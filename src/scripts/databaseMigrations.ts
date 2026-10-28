import type {Sequelize} from 'sequelize';

let database: Sequelize | undefined;

async function main(): Promise<void> {
    const [action, ...options] = process.argv.slice(2);
    if (!['status', 'check'].includes(action) || options.some(option => option !== '--tenants')) {
        throw new Error('Usage: databaseMigrations.js status|check [--tenants]. Apply migrations with npm run db:migrate (Sequelize CLI).');
    }
    const {sequelize} = await import('../config/database.js');
    database = sequelize;
    const {getDatabaseStatus} = await import('../database/migrationStatus.js');
    const status = await getDatabaseStatus(sequelize, options.includes('--tenants'));
    console.log(JSON.stringify(status));
    if (action === 'check' && (!status.ready || status.tenants?.some(tenant => !tenant.ready))) process.exitCode = 2;
}

void main().catch(error => {
    console.error('[database] failed:', error.message);
    process.exitCode = 1;
}).finally(async () => {
    try {await database?.close();}
    catch (error) {console.error('[database] connection cleanup failed:', (error as Error).message); process.exitCode = 1;}
});
