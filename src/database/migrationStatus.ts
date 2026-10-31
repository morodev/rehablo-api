import type {Sequelize, Transaction} from 'sequelize';
import {sequelize} from '../config/database.js';
import {quoteTenantSchema, SchemaReadinessError} from './migrationTypes.js';

export const requiredMigrationNames = [
    '202610280001-initial-schema.js',
    '202610280002-appointment-reminders.js',
    '202610310001-quote-package-invoice-lines.js',
    '202610310002-activity-recurrences.js'
] as const;

/** Read Sequelize's migration history without creating tables or running migrations. */
export async function readMigrationNames(database: Sequelize, schema = 'public', transaction?: Transaction): Promise<string[]> {
    const prefix = schema === 'public' ? 'public' : quoteTenantSchema(schema);
    const registry = `${prefix}."SequelizeMeta"`;
    const [tables] = await database.query('SELECT to_regclass(:registry) AS registry', {
        transaction, replacements: {registry}
    });
    if (!(tables[0] as {registry?: string})?.registry) return [];
    const [rows] = await database.query(`SELECT name FROM ${registry} ORDER BY name`, {transaction});
    return (rows as Array<{name: string}>).map(row => row.name);
}

export async function getDatabaseStatus(database: Sequelize = sequelize, includeTenants = false) {
    const applied = await readMigrationNames(database);
    const pending = requiredMigrationNames.filter(name => !applied.includes(name));
    const status: {ready: boolean; applied: string[]; pending: string[];
        tenants?: Array<{schemaName: string; ready: boolean; pending: string[]}>} = {
        ready: pending.length === 0, applied, pending
    };
    if (includeTenants) {
        status.tenants = [];
        const [tables] = await database.query("SELECT to_regclass('public.tenants') AS tenants");
        if ((tables[0] as {tenants?: string})?.tenants) {
            const [tenants] = await database.query('SELECT id FROM public.tenants ORDER BY id');
            for (const {id} of tenants as Array<{id: string}>) {
                const schemaName = 'rehablo_' + id.replaceAll('-', '');
                const names = await readMigrationNames(database, schemaName);
                const missing = requiredMigrationNames.filter(name => !names.includes(name));
                status.tenants.push({schemaName, ready: missing.length === 0, pending: missing});
            }
        }
    }
    return status;
}

export async function assertDatabaseReady(database: Sequelize = sequelize): Promise<void> {
    const {pending} = await getDatabaseStatus(database);
    if (pending.length) throw new SchemaReadinessError(
        `Database migrations pending: ${pending.join(', ')}. Run npm run db:migrate before starting the API.`);
}

export async function assertTenantReady(schema: string, database: Sequelize = sequelize, transaction?: Transaction): Promise<void> {
    quoteTenantSchema(schema);
    const applied = await readMigrationNames(database, schema, transaction);
    if (requiredMigrationNames.some(name => !applied.includes(name))) {
        throw new SchemaReadinessError(`Tenant schema ${schema} has pending migrations; run npm run db:migrate.`);
    }
}

/** Old application versions may serve compatible data, but must not create an older tenant schema. */
export async function assertProvisioningReady(database: Sequelize, transaction: Transaction): Promise<void> {
    const applied = await readMigrationNames(database, 'public', transaction);
    if (requiredMigrationNames.some(name => !applied.includes(name)) ||
        applied.some(name => !(requiredMigrationNames as readonly string[]).includes(name))) {
        throw new SchemaReadinessError('Tenant registration requires the application version matching the applied database migrations.');
    }
}
