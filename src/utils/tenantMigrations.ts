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
export const CATALOG_STRUCTURE_AVAILABILITY_VERSION = '20260919-add-catalog-structure-availability';
export const ADMINISTRATION_SEED_VERSION = '20260922-seed-administration';
export const WORK_ITEM_ASSIGNEES_VERSION = '20261010-work-item-assignees';
export const ACTIVITIES_FOUNDATION_VERSION = '20261011-activities-foundation';
// Increment this whenever the tenant model registry changes, so existing schemas run model sync.
export const TENANT_MODEL_BASELINE_VERSION = '20261026-tenant-model-baseline-v21';
export const PATIENT_CONTACT_FOLLOW_UP_VERSION = '20261026-patient-contact-follow-ups';
export const FINANCIAL_INTEGRITY_VERSION = '20261025-financial-integrity';
export const PACKAGE_BOOKING_SERVICES_VERSION = '20261025-package-booking-services';
export const CARE_PACKAGE_PURCHASES_VERSION = '20261022-care-package-purchases';
export const PATIENT_SETTLEMENTS_VERSION = '20261012-patient-settlements';
export const ACTIVITIES_REVIEW_VERSION = '20261024-activities-review';
export const ACTIVITIES_DELIVERY_VERSION = '20261011-activities-delivery';
export const SOCIAL_SECURITY_PRICING_VERSION = '20261023-social-security-pricing';
export const tenantMigrations: Array<{version: string; module: MigrationModule}> = [
    {version: PATIENT_CONTACT_FOLLOW_UP_VERSION, module: require('../../migrations/20261026-patient-contact-follow-ups.js')},
    {version: SOCIAL_SECURITY_PRICING_VERSION, module: require('../../migrations/20261023-social-security-pricing.js')},
    {version: CARE_PACKAGE_PURCHASES_VERSION, module: require('../../migrations/20261022-care-package-purchases.js')},
    {version: PACKAGE_BOOKING_SERVICES_VERSION, module: require('../../migrations/20261025-package-booking-services.js')},
    {version: PATIENT_SETTLEMENTS_VERSION, module: require('../../migrations/20261012-patient-settlements.js')},
    {version: APPOINTMENT_LEDGER_VERSION, module: require('../../migrations/20260907-unify-appointment-payment-ledger.js')},
    {version: PATIENT_DEFAULT_EVENT_TYPE_VERSION, module: require('../../migrations/20260908-add-patient-default-event-type.js')},
    {version: APPOINTMENT_PRICE_ADJUSTMENTS_VERSION, module: require('../../migrations/20260908-add-appointment-price-adjustments.js')},
    {version: CATALOG_STRUCTURE_AVAILABILITY_VERSION, module: require('../../migrations/20260919-add-catalog-structure-availability.js')},
    // Supersede only pending legacy seeds. Never replay or rewrite completed historic cash imports.
    {version: ADMINISTRATION_SEED_VERSION, module: require('../../migrations/20261025-seed-administration-safe.js')},
    {version: FINANCIAL_INTEGRITY_VERSION, module: require('../../migrations/20261025-financial-integrity.js')},
    {version: '20260924-backfill-patient-publication', module: require('../../migrations/20260924-backfill-patient-publication.js')},
    {version: WORK_ITEM_ASSIGNEES_VERSION, module: require('../../migrations/20261010-work-item-assignees.js')},
    {version: ACTIVITIES_FOUNDATION_VERSION, module: require('../../migrations/20261011-activities-foundation.js')},
    {version: ACTIVITIES_DELIVERY_VERSION, module: require('../../migrations/20261011-activities-delivery.js')},
    {version: ACTIVITIES_REVIEW_VERSION, module: require('../../migrations/20261024-activities-review.js')}
];

export function requiredTenantSchemaVersions(): string[] {
    return [TENANT_MODEL_BASELINE_VERSION, ...tenantMigrations.map(migration => migration.version)];
}

function quotedSchema(schema: string): string {
    if (!/^rehablo_[a-f0-9]{32}$/i.test(schema)) throw new Error('Invalid tenant schema');
    return '"' + schema + '"';
}

/** Log before awaiting database work so a stalled startup identifies its active phase. */
export async function traceTenantSchemaPhase<T>(schema: string, phase: string, work: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    console.log(`[tenant-schema] ${schema}: ${phase}: avvio`);
    try {
        const result = await work();
        console.log(`[tenant-schema] ${schema}: ${phase}: completato (${Date.now() - startedAt} ms)`);
        return result;
    } catch (error) {
        console.error(`[tenant-schema] ${schema}: ${phase}: fallito (${Date.now() - startedAt} ms)`);
        throw error;
    }
}

export async function lockTenantSchema(database: Sequelize, schema: string, transaction: Transaction): Promise<void> {
    quotedSchema(schema);
    await traceTenantSchemaPhase(schema, 'lock migrazioni', async () => {
        await database.query("SET LOCAL lock_timeout = '10s'", {transaction});
        // The database lock also serializes different API instances, beyond the in-process cache.
        await database.query('SELECT pg_advisory_xact_lock(hashtext(:schema), hashtext(:operation))', {
            transaction, replacements: {schema, operation: 'tenant-schema-migrations'}
        });
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
    const migrate = async (currentTransaction: Transaction) => traceTenantSchemaPhase(schema, 'migrazioni tenant', async () => {
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
            await traceTenantSchemaPhase(schema, `migrazione ${migration.version}`, async () => {
                await migration.module.up(database.getQueryInterface(), {
                    schema, transaction: currentTransaction, repairHistoryKnown
                });
                // Each migration and its completion record belong to the caller's transaction.
                await database.query(`INSERT INTO ${prefix}."schema_migrations" ("version") VALUES (:version)`, {
                    transaction: currentTransaction, replacements: {version: migration.version}
                });
            });
            completed.push(migration.version);
        }
        return completed;
    });
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
    return traceTenantSchemaPhase(schema, 'verifica versioni schema', async () => {
        const [tables] = await database.query('SELECT to_regclass(:registry) AS registry', {
            transaction, replacements: {registry: prefix + '."schema_migrations"'}
        });
        if (!(tables[0] as {registry?: string})?.registry) return false;
        const [rows] = await database.query(`SELECT "version" FROM ${prefix}."schema_migrations"`, {transaction});
        const applied = new Set((rows as Array<{version: string}>).map(row => row.version));
        return requiredTenantSchemaVersions().every(version => applied.has(version));
    });
}
