import {sequelize} from '../config/database.js';
import {env} from '../config/env.js';
import {databaseManifest} from '../database/migrationManifest.js';
import {initializeControlTables, withReleaseLock} from '../database/releaseControl.js';
import {getDatabaseStatus, migrateDatabase} from '../database/releaseRunner.js';
import {initializeBridge, requireBridgeComplete} from '../database/schemaTransition.js';
import {registerDatabaseModels} from '../database/registerModels.js';

async function main(): Promise<void> {
    const [action, ...options] = process.argv.slice(2);
    if (!['migrate','status','check'].includes(action) || options.some(option => option !== '--tenants')) {
        throw new Error('Usage: databaseMigrations.js migrate|status|check [--tenants]');
    }
    if (action !== 'migrate') {
        const status = await getDatabaseStatus(databaseManifest, sequelize, options.includes('--tenants'));
        console.log(JSON.stringify(status));
        if (action === 'check' && !status.ready) process.exitCode = 2;
        return;
    }
    if (env.databaseMigrationPhase === 'bridge') {
        const result = await withReleaseLock(sequelize, async () => {
            if ((await getDatabaseStatus(databaseManifest, sequelize)).ready) return 'already managed';
            await sequelize.transaction(async transaction => {
                await initializeControlTables(sequelize, transaction);
                await initializeBridge(sequelize, transaction);
            });
            return 'bridge metadata ready; legacy bootstrap is coordinated until the managed release';
        });
        console.log('[database-release] ' + result);
        return;
    }
    // The bridge makes existing provisioning participate in the global release lock.
    await requireBridgeComplete(sequelize);
    registerDatabaseModels();
    const result = await migrateDatabase(databaseManifest, {
        concurrency: env.migrationConcurrency, statementTimeoutMs: env.migrationStatementTimeoutMs,
        onProgress: event => console.log('[database-migration] ' + JSON.stringify({release: databaseManifest.id, ...event}))
    });
    console.log('[database-release] ' + JSON.stringify(result));
}

main().catch(error => {
    console.error('[database-release] failed:', error.message);
    if (error.cause?.message) console.error('[database-release] cause:', error.cause.message);
    process.exitCode = 1;
}).finally(() => sequelize.close());
