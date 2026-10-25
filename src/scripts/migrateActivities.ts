/** Additive Activities migration runner, including deployments with TENANT_SCHEMA_SYNC=off. */
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {Transaction} from 'sequelize';
import {sequelize} from '../config/database.js';
import {lockTenantSchema} from '../utils/tenantMigrations.js';

const require = createRequire(import.meta.url);
type FoundationContract = {
    tables: string[];
    columns: Record<string, string[]>;
    constraints: Array<{table: string; name: string}>;
    indexes: Array<{table: string; name: string; unique: boolean; columns: string[]; predicate: string | null}>;
};
const migration = require('../../migrations/20261011-activities-foundation.js') as {
    VERSION: string;
    contract: FoundationContract;
    up(queryInterface: ReturnType<typeof sequelize.getQueryInterface>, options: {
        schema: string; transaction: Transaction;
    }): Promise<void>;
};
const deliveryMigration = require('../../migrations/20261011-activities-delivery.js') as typeof migration;
const reviewMigration = require('../../migrations/20261024-activities-review.js') as typeof migration;
const publicMigration = require('../../migrations/20261011-activities-notifications-public.js') as {
    VERSION: string; contract: {columns: Record<string, string[]>};
    up(queryInterface: ReturnType<typeof sequelize.getQueryInterface>, options?: {transaction?: Transaction}): Promise<void>;
};
const contract: FoundationContract = {
    tables: [...migration.contract.tables, ...deliveryMigration.contract.tables],
    columns: {...migration.contract.columns, ...Object.fromEntries(Object.entries(deliveryMigration.contract.columns)
        .map(([table, columns]) => [table, [...(migration.contract.columns[table] ?? []), ...columns]])),
        ...Object.fromEntries(Object.entries(reviewMigration.contract.columns).map(([table, columns]) => [table, [...(migration.contract.columns[table] ?? []), ...columns]]))},
    constraints: [...migration.contract.constraints, ...deliveryMigration.contract.constraints, ...reviewMigration.contract.constraints],
    indexes: [...migration.contract.indexes, ...deliveryMigration.contract.indexes]
};
const SCHEMA_PATTERN = /^rehablo_[a-f0-9]{32}$/i;
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
type QueryConnection = {query(sql: string, options?: any): Promise<any>};

export function parseMigrationArguments(flags: string[]): {help: boolean; apply: boolean; schema?: string} {
    if (flags.length === 1 && flags[0] === '--help') return {help: true, apply: false};
    let apply = false;
    let check = false;
    let schema: string | undefined;
    for (let index = 0; index < flags.length; index++) {
        const flag = flags[index];
        if (flag === '--apply' && !apply) apply = true;
        else if (flag === '--check' && !check) check = true;
        else if (flag === '--schema' && schema === undefined) {
            schema = flags[++index];
            if (!schema || !SCHEMA_PATTERN.test(schema)) throw new Error('Invalid tenant schema.');
        } else throw new Error('Use only --check or --apply and optional --schema <existing tenant schema>.');
    }
    if (apply && check) throw new Error('Use only --check or --apply, not both.');
    return {help: false, apply, schema};
}

export interface ActivitiesReadiness {
    schema: string;
    versionApplied: boolean;
    deliveryVersionApplied: boolean;
    reviewVersionApplied: boolean;
    publicReady: boolean;
    missingPublicColumns: string[];
    missingTables: string[];
    missingColumns: string[];
    missingConstraints: string[];
    missingIndexes: string[];
    missingBoards: number | null;
    ready: boolean;
}

function normalizePredicate(value: string | null): string {
    return (value ?? '').replace(/::(?:text|character varying)/g, '').replace(/[()"\s]/g, '');
}

/** Read metadata and aggregate counts; activity content and personal data are never returned. */
export async function inspectActivities(connection: QueryConnection, schema: string): Promise<ActivitiesReadiness> {
    if (!SCHEMA_PATTERN.test(schema)) throw new Error('Invalid tenant schema.');
    const [rawColumns] = await connection.query(
        'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = :schema',
        {replacements: {schema}}
    );
    const columns = rawColumns as Array<{table_name: string; column_name: string}>;
    const availableTables = new Set(columns.map(column => column.table_name));
    const availableColumns = new Set(columns.map(column => column.table_name + '.' + column.column_name));
    const missingTables = contract.tables.filter(table => !availableTables.has(table));
    const missingColumns = Object.entries(contract.columns).flatMap(([table, names]) =>
        names.filter(name => !availableColumns.has(table + '.' + name)).map(name => table + '.' + name));
    const [rawConstraints] = await connection.query(`
        SELECT t.relname AS "table", c.conname AS name, c.convalidated AS validated
        FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = :schema`, {replacements: {schema}});
    const availableConstraints = new Set((rawConstraints as Array<{table: string; name: string; validated: boolean}>)
        .filter(constraint => constraint.validated).map(constraint => constraint.table + '.' + constraint.name));
    const missingConstraints = contract.constraints
        .filter(constraint => !availableConstraints.has(constraint.table + '.' + constraint.name))
        .map(constraint => constraint.name);
    const [rawIndexes] = await connection.query(`
        SELECT t.relname AS "table", idx.relname AS name, i.indisunique AS "unique",
            i.indisvalid AS valid, pg_get_expr(i.indpred, i.indrelid) AS predicate,
            ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS columns
        FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_class idx ON idx.oid = i.indexrelid
        WHERE n.nspname = :schema`, {replacements: {schema}});
    const indexes = rawIndexes as Array<{table: string; name: string; unique: boolean; valid: boolean;
        predicate: string | null; columns: string[]}>;
    const missingIndexes = contract.indexes.filter(expected => !indexes.some(actual =>
        actual.table === expected.table && actual.name === expected.name && actual.valid
        && actual.unique === expected.unique && actual.columns.join(',') === expected.columns.join(',')
        && normalizePredicate(actual.predicate) === normalizePredicate(expected.predicate))).map(index => index.name);
    let versionApplied = false, deliveryVersionApplied = false, reviewVersionApplied = false;
    if (availableColumns.has('schema_migrations.version')) {
        const [rows] = await connection.query(`SELECT 1 FROM ${quote(schema)}."schema_migrations" WHERE "version" = :version`, {
            replacements: {version: migration.VERSION}
        });
        versionApplied = rows.length > 0;
        const [deliveryRows] = await connection.query(`SELECT 1 FROM ${quote(schema)}."schema_migrations" WHERE "version" = :version`, {
            replacements: {version: deliveryMigration.VERSION}});
        deliveryVersionApplied = deliveryRows.length > 0;
        const [reviewRows] = await connection.query(`SELECT 1 FROM ${quote(schema)}."schema_migrations" WHERE "version" = :version`, {replacements: {version: reviewMigration.VERSION}});
        reviewVersionApplied = reviewRows.length > 0;
    }
    let missingBoards: number | null = null;
    if (availableColumns.has('activity_boards.structureId')) {
        const [rows] = await connection.query(`SELECT COUNT(*)::integer AS count FROM "public"."structures" s
            WHERE replace(s."tenantId"::text, '-', '') = :tenantSuffix
            AND NOT EXISTS (SELECT 1 FROM ${quote(schema)}."activity_boards" b WHERE b."structureId" = s."id")`, {
            replacements: {tenantSuffix: schema.slice('rehablo_'.length).toLowerCase()}
        });
        missingBoards = Number(rows[0]?.count ?? 0);
    }
    const [publicColumns] = await connection.query(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'");
    const availablePublic = new Set((publicColumns as Array<{table_name: string; column_name: string}>)
        .map(row => row.table_name + '.' + row.column_name));
    const missingPublicColumns = Object.entries(publicMigration.contract.columns).flatMap(([table, names]) =>
        names.filter(name => !availablePublic.has(table + '.' + name)).map(name => table + '.' + name));
    const publicReady = !missingPublicColumns.length;
    return {schema, versionApplied, deliveryVersionApplied, reviewVersionApplied, publicReady, missingPublicColumns,
        missingTables, missingColumns, missingConstraints, missingIndexes, missingBoards,
        ready: versionApplied && deliveryVersionApplied && reviewVersionApplied && publicReady && !missingTables.length && !missingColumns.length
            && !missingConstraints.length && !missingIndexes.length && missingBoards === 0};
}

async function applyForTenant(schema: string): Promise<ActivitiesReadiness> {
    return sequelize.transaction(async transaction => {
        await lockTenantSchema(sequelize, schema, transaction);
        await migration.up(sequelize.getQueryInterface(), {schema, transaction});
        await deliveryMigration.up(sequelize.getQueryInterface(), {schema, transaction});
        await reviewMigration.up(sequelize.getQueryInterface(), {schema, transaction});
        await sequelize.query(`CREATE TABLE IF NOT EXISTS ${quote(schema)}."schema_migrations" (
            "version" VARCHAR(160) PRIMARY KEY, "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`, {transaction});
        // This runner guarantees only Activities. It must not claim unrelated model baselines are ready.
        await sequelize.query(`INSERT INTO ${quote(schema)}."schema_migrations" ("version") VALUES (:version)
            ON CONFLICT ("version") DO NOTHING`, {transaction, replacements: {version: migration.VERSION}});
        await sequelize.query(`INSERT INTO ${quote(schema)}."schema_migrations" ("version") VALUES (:version)
            ON CONFLICT ("version") DO NOTHING`, {transaction, replacements: {version: deliveryMigration.VERSION}});
        await sequelize.query(`INSERT INTO ${quote(schema)}."schema_migrations" ("version") VALUES (:version) ON CONFLICT ("version") DO NOTHING`,
            {transaction, replacements: {version: reviewMigration.VERSION}});
        const connection: QueryConnection = {
            query: (sql, options = {}) => sequelize.query(sql, {...options, transaction})
        };
        const report = await inspectActivities(connection, schema);
        if (!report.ready) throw new Error('Activities post-migration readiness check failed for tenant ' + schema + '.');
        return report;
    });
}

async function main(): Promise<void> {
    const options = parseMigrationArguments(process.argv.slice(2));
    if (options.help) {
        console.log('Usage: npm run migrate:activities -- [--check | --apply] [--schema rehablo_<tenant UUID without hyphens>]');
        console.log('--check (default) reads readiness. Exit 2 means the Activities migration is required.');
        console.log('--apply provisions public notification preferences and tenant Activities/delivery tables; it does not activate alerts.');
        console.log('Only the Activities version is recorded. No API, notification worker or schema sync is started.');
        return;
    }
    (sequelize as unknown as {options: {logging: boolean}}).options.logging = false;
    await sequelize.authenticate();
    const [rawSchemas] = await sequelize.query(`SELECT n.nspname AS schema_name FROM pg_namespace n
        JOIN "public"."tenants" t ON lower(n.nspname) = 'rehablo_' || replace(t."id"::text, '-', '')
        WHERE n.nspname ~* '^rehablo_[a-f0-9]{32}$'${options.schema ? ' AND n.nspname = :schema' : ''}
        ORDER BY n.nspname`, options.schema ? {replacements: {schema: options.schema}} : {});
    const schemas = rawSchemas as Array<{schema_name: string}>;
    if (!schemas.length) throw new Error('No existing matching tenant schema found. Check --schema and database configuration.');
    if (options.apply) await publicMigration.up(sequelize.getQueryInterface());
    let incomplete = false;
    for (const {schema_name: schema} of schemas) {
        const report = options.apply ? await applyForTenant(schema) : await inspectActivities(sequelize, schema);
        console.log(JSON.stringify(report));
        incomplete ||= !report.ready;
    }
    if (!options.apply && incomplete) process.exitCode = 2;
    console.log(options.apply ? 'Activities migration completed and readiness verified.' : 'Read-only Activities readiness check complete.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error: unknown) => {
        const message = error instanceof Error && !('sql' in error) && !('parent' in error)
            && /^(Use only|Invalid tenant|No existing matching|Activities post-migration)/.test(error.message)
            ? error.message : 'Activities migration failed. No credentials or SQL details were logged.';
        console.error(message);
        process.exitCode = 1;
    }).finally(() => sequelize.close());
}
