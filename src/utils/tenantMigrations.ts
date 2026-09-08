import {createRequire} from 'node:module';
import {Sequelize, Transaction} from 'sequelize';
import {sequelize} from '../config/database.js';

const require = createRequire(import.meta.url);
type MigrationModule = {
    up(queryInterface: ReturnType<Sequelize['getQueryInterface']>, options: {
        schema: string; transaction: Transaction; repairHistoryKnown?: boolean;
    }): Promise<void>;
};
export const APPOINTMENT_LEDGER_VERSION = '20260907-unify-appointment-payment-ledger';
export const PATIENT_DEFAULT_EVENT_TYPE_VERSION = '20260908-add-patient-default-event-type';
export const APPOINTMENT_PRICE_ADJUSTMENTS_VERSION = '20260908-add-appointment-price-adjustments';
export const TENANT_MODEL_BASELINE_VERSION = '20260907-tenant-model-baseline-v1';
const tenantMigrations: Array<{version: string; module: MigrationModule}> = [
    {version: APPOINTMENT_LEDGER_VERSION, module: require('../../migrations/20260907-unify-appointment-payment-ledger.js')},
    {version: PATIENT_DEFAULT_EVENT_TYPE_VERSION, module: require('../../migrations/20260908-add-patient-default-event-type.js')},
    {version: APPOINTMENT_PRICE_ADJUSTMENTS_VERSION, module: require('../../migrations/20260908-add-appointment-price-adjustments.js')}
];

export function requiredTenantSchemaVersions(): string[] {
    return [TENANT_MODEL_BASELINE_VERSION, ...tenantMigrations.map(migration => migration.version)];
}

function quotedSchema(schema: string): string {
    if (!/^rehablo_[a-f0-9]{32}$/i.test(schema)) throw new Error('Invalid tenant schema');
    return '"' + schema + '"';
}

export async function lockTenantSchema(database: Sequelize, schema: string, transaction: Transaction): Promise<void> {
    quotedSchema(schema);
    await database.query("SET LOCAL lock_timeout = '10s'", {transaction});
    // The database lock also serializes different API instances, beyond the in-process cache.
    await database.query('SELECT pg_advisory_xact_lock(hashtext(:schema), hashtext(:operation))', {
        transaction, replacements: {schema, operation: 'tenant-schema-migrations'}
    });
}

/** Preserve the distinction between old and new appointments before model sync adds defaults. */
export async function prepareTenantPaymentHistory(
    schema: string, database: Sequelize = sequelize, transaction?: Transaction
): Promise<boolean> {
    const prefix = quotedSchema(schema);
    const prepare = async (currentTransaction: Transaction) => {
        const [tables] = await database.query('SELECT to_regclass(:agenda) AS agenda', {
            transaction: currentTransaction, replacements: {agenda: prefix + '."agenda_events"'}
        });
        if (!(tables[0] as {agenda?: string})?.agenda) return false;
        const [rawColumns] = await database.query(
            "SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = :schema AND table_name IN ('agenda_events', 'invoice_payments')",
            {transaction: currentTransaction, replacements: {schema}}
        );
        const columns = rawColumns as Array<{table_name: string; column_name: string; is_nullable: string}>;
        const historyExists = columns.some(column => column.table_name === 'agenda_events'
            && column.column_name === 'appointmentPaymentHistoryKnown');
        const invoiceColumn = columns.find(column => column.table_name === 'invoice_payments' && column.column_name === 'invoiceId');
        if (!historyExists) {
            await database.query(`ALTER TABLE ${prefix}."agenda_events" ADD COLUMN IF NOT EXISTS "appointmentPaymentHistoryKnown" BOOLEAN NOT NULL DEFAULT false`, {transaction: currentTransaction});
            await database.query(`ALTER TABLE ${prefix}."agenda_events" ALTER COLUMN "appointmentPaymentHistoryKnown" SET DEFAULT true`, {transaction: currentTransaction});
        }
        // Keep this evidence even if full sync subsequently changes invoiceId to nullable,
        // or creates a missing invoice_payments table with the new nullable model.
        return !invoiceColumn || invoiceColumn.is_nullable === 'NO';
    };
    if (transaction) return prepare(transaction);
    return database.transaction(async currentTransaction => {
        await lockTenantSchema(database, schema, currentTransaction);
        return prepare(currentTransaction);
    });
}

/** Called after model sync, before the API accepts traffic for the tenant. */
export async function runTenantMigrations(
    schema: string, repairHistoryKnown = false, database: Sequelize = sequelize, transaction?: Transaction
): Promise<string[]> {
    const prefix = quotedSchema(schema);
    const migrate = async (currentTransaction: Transaction) => {
        await database.query(`CREATE TABLE IF NOT EXISTS ${prefix}."schema_migrations" (
            "version" VARCHAR(160) PRIMARY KEY, "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`, {transaction: currentTransaction});
        const [rows] = await database.query(`SELECT "version" FROM ${prefix}."schema_migrations"`, {
            transaction: currentTransaction
        });
        const alreadyApplied = new Set((rows as Array<{version: string}>).map(row => row.version));
        const completed: string[] = [];
        for (const migration of tenantMigrations) {
            if (alreadyApplied.has(migration.version)) continue;
            await migration.module.up(database.getQueryInterface(), {
                schema, transaction: currentTransaction, repairHistoryKnown
            });
            // Each migration and its completion record belong to the caller's transaction.
            await database.query(`INSERT INTO ${prefix}."schema_migrations" ("version") VALUES (:version)`, {
                transaction: currentTransaction, replacements: {version: migration.version}
            });
            completed.push(migration.version);
        }
        return completed;
    };
    if (transaction) return migrate(transaction);
    return database.transaction(async currentTransaction => {
        await lockTenantSchema(database, schema, currentTransaction);
        return migrate(currentTransaction);
    });
}

/** Persist that model sync and every registered migration committed for this schema revision. */
export async function recordTenantModelBaseline(
    schema: string, database: Sequelize, transaction: Transaction
): Promise<void> {
    const prefix = quotedSchema(schema);
    await database.query(`INSERT INTO ${prefix}."schema_migrations" ("version") VALUES (:version)
        ON CONFLICT ("version") DO NOTHING`, {
        transaction, replacements: {version: TENANT_MODEL_BASELINE_VERSION}
    });
}

/** Cheap persistent readiness check used on restarts and by instances that did not create the tenant. */
export async function isTenantSchemaCurrent(
    schema: string, database: Sequelize = sequelize, transaction?: Transaction
): Promise<boolean> {
    const prefix = quotedSchema(schema);
    const [tables] = await database.query('SELECT to_regclass(:registry) AS registry', {
        transaction, replacements: {registry: prefix + '."schema_migrations"'}
    });
    if (!(tables[0] as {registry?: string})?.registry) return false;
    const [rows] = await database.query(`SELECT "version" FROM ${prefix}."schema_migrations"`, {transaction});
    const applied = new Set((rows as Array<{version: string}>).map(row => row.version));
    return requiredTenantSchemaVersions().every(version => applied.has(version));
}
