import type {Sequelize, Transaction} from 'sequelize';
import {createRequire} from 'node:module';
import {env} from '../config/env.js';
import {databaseManifest as legacyBaseline} from './migrationManifest.js';
import {quoteTenantSchema, type MigrationStep} from './migrationTypes.js';
import {assertDatabaseReady, readMigrationNames, requiredMigrationNames} from './migrationStatus.js';

export {requiredMigrationNames} from './migrationStatus.js';

const [initialSchemaName, appointmentRemindersName, quotePackageInvoicesName, activityRecurrencesName] = requiredMigrationNames;
const quotePackageInvoiceLines = createRequire(import.meta.url)('../../migrations/20261031-quote-package-invoice-lines.js');
const activityRecurrences = createRequire(import.meta.url)('../../migrations/20261031-activity-recurrences.js');
const reminderStep = legacyBaseline.tenantMigrations.find(step => step.name === '20261028-appointment-reminders-v1')!;
const tenantBaselineSteps = legacyBaseline.tenantMigrations.filter(step => step !== reminderStep);

/** Keep the original PostgreSQL error, and expose the blocked operation without logging bound data. */
function migrationFailure(context: string, cause: unknown): Error {
    const error = cause as Error & {sql?: string; original?: {code?: string}; parent?: {code?: string}};
    const code = error.original?.code ?? error.parent?.code;
    const sql = error.sql?.trim() ?? '';
    const details: string[] = code ? ['SQLSTATE ' + code] : [];
    if (/^SELECT\s+pg_advisory_xact_lock\(/i.test(sql)) details.push('tenant migration advisory lock');
    else {
        // Only SQL keywords and identifiers: INSERT/UPDATE values can contain business data.
        const ddl = sql.match(/^(ALTER TABLE|CREATE TABLE(?: IF NOT EXISTS)?|CREATE SCHEMA(?: IF NOT EXISTS)?|LOCK TABLE)\s+((?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)(?:\.(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*))?)/i);
        const command = sql.match(/^[a-z]+/i)?.[0];
        if (ddl) details.push(ddl[1] + ' ' + ddl[2]);
        else if (command) details.push(command.toUpperCase());
    }
    return new Error(`${context}: ${error.message}${details.length ? ' [' + details.join('; ') + ']' : ''}`, {cause});
}

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
    const [registries] = await database.query(`SELECT to_regclass(:registry) AS registry,
        EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(:registry)
            AND attname='checksum' AND attnum>0 AND NOT attisdropped) AS "hasChecksum"`, {
        transaction, replacements: {registry}
    });
    const existing = registries[0] as {registry: string | null; hasChecksum: boolean};
    let hasChecksum = existing.hasChecksum;
    if (!existing.registry) {
        await database.query(`CREATE TABLE IF NOT EXISTS ${registry} (
            "version" VARCHAR(160) PRIMARY KEY, "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "checksum" VARCHAR(128))`, {transaction});
        hasChecksum = true;
    }
    // The old two-column ledger is valid history. Adding optional bookkeeping would require
    // ACCESS EXCLUSIVE, even with IF NOT EXISTS, and can block the still-running API's readers.
    const [rows] = await database.query(`SELECT "version", ${hasChecksum ? '"checksum"' : 'NULL::text AS "checksum"'} FROM ${registry}`, {transaction});
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
        await database.query(`INSERT INTO ${registry} (${hasChecksum ? '"version", "checksum"' : '"version"'})
            VALUES (${hasChecksum ? ':version, :checksum' : ':version'})`, {
            transaction, replacements: {version: step.name, checksum: step.checksum}
        });
    }
}

/** New-tenant creation records the release filenames atomically with its schema. */
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

async function applyTenantQuotePackageInvoices(database: Sequelize, schema: string, transaction: Transaction, applied: string[]): Promise<void> {
    if (applied.includes(quotePackageInvoicesName)) return;
    await quotePackageInvoiceLines.up(database.getQueryInterface(), {schema, transaction});
    await recordTenantMigration(database, schema, quotePackageInvoicesName, transaction);
}

async function applyTenantActivityRecurrences(database: Sequelize, schema: string, transaction: Transaction, applied: string[]): Promise<void> {
    if (applied.includes(activityRecurrencesName)) return;
    await activityRecurrences.up(database.getQueryInterface(), {schema, transaction});
    await recordTenantMigration(database, schema, activityRecurrencesName, transaction);
}

async function tenantSchemas(database: Sequelize): Promise<string[]> {
    const [rows] = await database.query('SELECT id FROM public.tenants ORDER BY id');
    return (rows as Array<{id: string}>).map(({id}) => 'rehablo_' + id.replaceAll('-', ''));
}

/** Called by the first standard Sequelize CLI migration's up(queryInterface, Sequelize). */
export async function migrateInitialSchema(database: Sequelize): Promise<void> {
    // Public enum additions must commit before later steps use their new values.
    for (const step of legacyBaseline.publicMigrations) {
        try {
            await database.transaction(async transaction => {
                await configureTransaction(database, transaction);
                await applyLegacySteps(database, 'public', [step], transaction);
            });
        } catch (cause) {throw migrationFailure(`Initial public schema migration failed at ${step.name}`, cause);}
    }
    for (const schema of await tenantSchemas(database)) {
        try {
            await database.transaction(async transaction => {
                await prepareTenant(database, schema, transaction);
                await applyTenantBaseline(database, schema, transaction, await readMigrationNames(database, schema, transaction));
            });
        } catch (cause) {throw migrationFailure(`Initial schema migration failed for ${schema}`, cause);}
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
        } catch (cause) {throw migrationFailure(`Appointment reminder migration failed for ${schema}`, cause);}
    }
}

/** Run the additive quote-package invoice migration without replaying frozen historical migrations. */
export async function migrateQuotePackageInvoiceLines(database: Sequelize): Promise<void> {
    for (const schema of await tenantSchemas(database)) {
        try {
            await database.transaction(async transaction => {
                await prepareTenant(database, schema, transaction);
                const applied = await readMigrationNames(database, schema, transaction);
                await applyTenantBaseline(database, schema, transaction, applied);
                await applyTenantReminders(database, schema, transaction, applied);
                await applyTenantQuotePackageInvoices(database, schema, transaction, applied);
            });
        } catch (cause) {throw migrationFailure(`Quote package invoice migration failed for ${schema}`, cause);}
    }
}

/** Additive recurrence release; previous migrations remain frozen. */
export async function migrateActivityRecurrences(database: Sequelize): Promise<void> {
    for (const schema of await tenantSchemas(database)) {
        try {
            await database.transaction(async transaction => {
                await prepareTenant(database, schema, transaction);
                const applied = await readMigrationNames(database, schema, transaction);
                await applyTenantBaseline(database, schema, transaction, applied);
                await applyTenantReminders(database, schema, transaction, applied);
                await applyTenantQuotePackageInvoices(database, schema, transaction, applied);
                await applyTenantActivityRecurrences(database, schema, transaction, applied);
            });
        } catch (cause) {throw migrationFailure(`Activity recurrence migration failed for ${schema}`, cause);}
    }
}

/** Signup owns the transaction; no extra connection or global release lock is acquired. */
export async function provisionTenantSchema(database: Sequelize, schema: string, transaction: Transaction): Promise<void> {
    await prepareTenant(database, schema, transaction);
    const applied = await readMigrationNames(database, schema, transaction);
    await applyTenantBaseline(database, schema, transaction, applied);
    await applyTenantReminders(database, schema, transaction, applied);
    await applyTenantQuotePackageInvoices(database, schema, transaction, applied);
    await applyTenantActivityRecurrences(database, schema, transaction, applied);
}

/** Catch tenants registered by a preceding API after the CLI discovered its tenant list. */
export async function reconcileTenantSchemas(database: Sequelize): Promise<number> {
    await assertDatabaseReady(database);
    const applied = await readMigrationNames(database);
    if (applied.some(name => !(requiredMigrationNames as readonly string[]).includes(name))) return 0;
    const [rows] = await database.query(`SELECT t.id, c.oid IS NOT NULL AS "hasMetadata" FROM public.tenants t
        LEFT JOIN pg_namespace n ON n.nspname = 'rehablo_' || replace(t.id::text, '-', '')
        LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'SequelizeMeta' AND c.relkind = 'r'
        ORDER BY t.id`);
    let reconciled = 0;
    for (const {id, hasMetadata} of rows as Array<{id: string; hasMetadata: boolean}>) {
        const schema = 'rehablo_' + id.replaceAll('-', '');
        if (hasMetadata) {
            const names = await readMigrationNames(database, schema);
            // Only upgrade the known preceding release; incomplete historical metadata still needs review.
            if (names.includes(activityRecurrencesName) || !names.includes(initialSchemaName)
                || !names.includes(appointmentRemindersName)
                || names.some(name => !(requiredMigrationNames as readonly string[]).includes(name))) continue;
        }
        await database.transaction(transaction => provisionTenantSchema(database, schema, transaction));
        reconciled++;
    }
    return reconciled;
}
