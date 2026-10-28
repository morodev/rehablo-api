import type {Sequelize, Transaction} from 'sequelize';
import {env} from '../config/env.js';
import {databaseManifest as legacyBaseline} from './migrationManifest.js';
import {quoteTenantSchema, type MigrationStep} from './migrationTypes.js';
import {assertDatabaseReady, readMigrationNames, requiredMigrationNames} from './migrationStatus.js';

export {requiredMigrationNames} from './migrationStatus.js';

const [initialSchemaName, appointmentRemindersName] = requiredMigrationNames;
const reminderStep = legacyBaseline.tenantMigrations.find(step => step.name === '20261028-appointment-reminders-v1')!;
const tenantBaselineSteps = legacyBaseline.tenantMigrations.filter(step => step !== reminderStep);

/** Transaction-local limits apply to migration/provisioning SQL only. */
async function configureTransaction(database: Sequelize, transaction: Transaction): Promise<void> {
    const statementTimeout = env.migrationStatementTimeoutMs;
    if (!Number.isInteger(statementTimeout) || statementTimeout < 1 || statementTimeout > 120_000) {
        throw new Error('Migration statement timeout must be between 1 and 120000 milliseconds');
    }
    await database.query("SELECT set_config('lock_timeout', '10s', true), set_config('statement_timeout', :timeout, true)", {
        transaction, replacements: {timeout: statementTimeout + 'ms'}
    });
}

/** Only the tenant being changed is serialized, on the caller's existing transaction connection. */
async function prepareTenant(database: Sequelize, schema: string, transaction: Transaction): Promise<void> {
    const prefix = quoteTenantSchema(schema);
    await configureTransaction(database, transaction);
    await database.query('SELECT pg_advisory_xact_lock(hashtext(:schema), hashtext(:operation))', {
        transaction, replacements: {schema, operation: 'tenant-schema-migrations'}
    });
    await database.query(`CREATE SCHEMA IF NOT EXISTS ${prefix}`, {transaction});
}

/**
 * One-time adapter for pre-CLI history. Keep these frozen legacy steps and their recorded
 * timestamps intact; future changes belong in new files under migrations/releases.
 */
async function applyLegacySteps(database: Sequelize, schema: string, steps: MigrationStep[], transaction: Transaction): Promise<void> {
    const registry = schema === 'public' ? 'public."platform_schema_migrations"'
        : `${quoteTenantSchema(schema)}."schema_migrations"`;
    await database.query(`CREATE TABLE IF NOT EXISTS ${registry} (
        "version" VARCHAR(160) PRIMARY KEY, "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "checksum" VARCHAR(128))`, {transaction});
    await database.query(`ALTER TABLE ${registry} ADD COLUMN IF NOT EXISTS "checksum" VARCHAR(128)`, {transaction});
    const [rows] = await database.query(`SELECT "version", "checksum" FROM ${registry}`, {transaction});
    const applied = new Map((rows as Array<{version: string; checksum: string | null}>).map(row => [row.version, row.checksum]));
    for (const step of steps) {
        if (applied.has(step.name)) {
            if (applied.get(step.name) && applied.get(step.name) !== step.checksum) {
                throw new Error(`Historical migration ${step.name} checksum mismatch in ${schema}`);
            }
            continue;
        }
        console.log(`[migration] ${schema}: ${step.name}`);
        await step.up(database, schema, transaction);
        await database.query(`INSERT INTO ${registry} ("version", "checksum") VALUES (:version, :checksum)`, {
            transaction, replacements: {version: step.name, checksum: step.checksum}
        });
    }
}

/** New-tenant creation records the same two filenames atomically with its schema. */
async function recordTenantMigration(database: Sequelize, schema: string, name: string, transaction: Transaction): Promise<void> {
    const registry = `${quoteTenantSchema(schema)}."SequelizeMeta"`;
    await database.query(`CREATE TABLE IF NOT EXISTS ${registry} ("name" VARCHAR(255) PRIMARY KEY NOT NULL)`, {transaction});
    await database.query(`INSERT INTO ${registry} ("name") VALUES (:name) ON CONFLICT ("name") DO NOTHING`, {
        transaction, replacements: {name}
    });
}

async function applyTenantBaseline(database: Sequelize, schema: string, transaction: Transaction, applied: string[]): Promise<void> {
    if (applied.includes(initialSchemaName)) return;
    await applyLegacySteps(database, schema, tenantBaselineSteps, transaction);
    await recordTenantMigration(database, schema, initialSchemaName, transaction);
}

async function applyTenantReminders(database: Sequelize, schema: string, transaction: Transaction, applied: string[]): Promise<void> {
    if (applied.includes(appointmentRemindersName)) return;
    await applyLegacySteps(database, schema, [reminderStep], transaction);
    await recordTenantMigration(database, schema, appointmentRemindersName, transaction);
}

async function tenantSchemas(database: Sequelize): Promise<string[]> {
    const [rows] = await database.query('SELECT id FROM public.tenants ORDER BY id');
    return (rows as Array<{id: string}>).map(({id}) => 'rehablo_' + id.replaceAll('-', ''));
}

/** Called by the first standard Sequelize CLI migration's up(queryInterface, Sequelize). */
export async function migrateInitialSchema(database: Sequelize): Promise<void> {
    // Public enum additions must commit before later steps use their new values.
    for (const step of legacyBaseline.publicMigrations) {
        await database.transaction(async transaction => {
            await configureTransaction(database, transaction);
            await applyLegacySteps(database, 'public', [step], transaction);
        });
    }
    for (const schema of await tenantSchemas(database)) {
        try {
            await database.transaction(async transaction => {
                await prepareTenant(database, schema, transaction);
                await applyTenantBaseline(database, schema, transaction, await readMigrationNames(database, schema, transaction));
            });
        } catch (cause) {throw new Error(`Initial schema migration failed for ${schema}: ${(cause as Error).message}`, {cause});}
    }
}

/** Called by the second standard Sequelize CLI migration's up(queryInterface, Sequelize). */
export async function migrateAppointmentReminders(database: Sequelize): Promise<void> {
    for (const schema of await tenantSchemas(database)) {
        try {
            await database.transaction(async transaction => {
                await prepareTenant(database, schema, transaction);
                const applied = await readMigrationNames(database, schema, transaction);
                // The old API may have registered a tenant between the two CLI migrations.
                await applyTenantBaseline(database, schema, transaction, applied);
                await applyTenantReminders(database, schema, transaction, applied);
            });
        } catch (cause) {throw new Error(`Appointment reminder migration failed for ${schema}: ${(cause as Error).message}`, {cause});}
    }
}

/** Signup owns the transaction; no extra connection or global release lock is acquired. */
export async function provisionTenantSchema(database: Sequelize, schema: string, transaction: Transaction): Promise<void> {
    await prepareTenant(database, schema, transaction);
    const applied = await readMigrationNames(database, schema, transaction);
    await applyTenantBaseline(database, schema, transaction, applied);
    await applyTenantReminders(database, schema, transaction, applied);
}

/** Adopt only tenants created by a legacy API after pre-deploy, once global CLI migrations succeeded. */
export async function reconcileTenantSchemas(database: Sequelize): Promise<number> {
    await assertDatabaseReady(database);
    const applied = await readMigrationNames(database);
    if (applied.some(name => !(requiredMigrationNames as readonly string[]).includes(name))) return 0;
    // Completed schemas need no per-tenant reads. Only legacy registrations lack this metadata table:
    // standard provisioning creates it in the same transaction as the tenant and its entire schema.
    const [rows] = await database.query(`SELECT t.id FROM public.tenants t
        LEFT JOIN pg_namespace n ON n.nspname = 'rehablo_' || replace(t.id::text, '-', '')
        LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'SequelizeMeta' AND c.relkind = 'r'
        WHERE c.oid IS NULL ORDER BY t.id`);
    for (const {id} of rows as Array<{id: string}>) {
        const schema = 'rehablo_' + id.replaceAll('-', '');
        await database.transaction(transaction => provisionTenantSchema(database, schema, transaction));
    }
    return rows.length;
}
