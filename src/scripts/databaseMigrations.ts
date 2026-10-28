import type {Sequelize} from 'sequelize';

let database: Sequelize | undefined;

async function main(): Promise<void> {
    const [action, ...options] = process.argv.slice(2);
    if (!['migrate', 'status', 'check'].includes(action) || options.some(option => option !== '--tenants')) {
        throw new Error('Usage: databaseMigrations.js migrate|status|check [--tenants]');
    }
    // Load configuration and immutable migration artifacts inside the error boundary as well.
    const {sequelize} = await import('../config/database.js');
    database = sequelize;
    const {env} = await import('../config/env.js');
    const {databaseManifest} = await import('../database/migrationManifest.js');
    const {getDatabaseStatus, migrateDatabase} = await import('../database/releaseRunner.js');
    if (action !== 'migrate') {
        const status = await getDatabaseStatus(databaseManifest, sequelize, options.includes('--tenants'));
        console.log(JSON.stringify(status));
        if (action === 'check' && !status.ready) process.exitCode = 2;
        return;
    }
    console.log('[database-release] starting ' + databaseManifest.id);
    const {registerDatabaseModels} = await import('../database/registerModels.js');
    registerDatabaseModels();
    const result = await migrateDatabase(databaseManifest, {
        concurrency: env.migrationConcurrency,
        statementTimeoutMs: env.migrationStatementTimeoutMs,
        reconcileMissingTenants: true,
        onProgress: event => console.log('[database-migration] ' + JSON.stringify({release: databaseManifest.id, ...event}))
    });
    console.log('[database-release] ' + JSON.stringify(result));
}

async function run(): Promise<void> {
    try {
        await main();
    } catch (error) {
        const failure = error as Error & {cause?: Error};
        console.error('[database-release] failed:', failure.message ?? String(error));
        if (failure.cause?.message) console.error('[database-release] cause:', failure.cause.message);
        process.exitCode = 1;
    } finally {
        try {
            await database?.close();
        } catch (error) {
            console.error('[database-release] connection cleanup failed:', (error as Error).message);
            process.exitCode = 1;
        }
    }
}

void run();
