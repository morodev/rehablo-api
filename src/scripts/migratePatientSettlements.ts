import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {sequelize} from '../config/database.js';
import {lockTenantSchema} from '../utils/tenantMigrations.js';

const require = createRequire(import.meta.url);
const migration = require('../../migrations/20261012-patient-settlements.js') as {
    VERSION: string; up(queryInterface: ReturnType<typeof sequelize.getQueryInterface>, options: Record<string, any>): Promise<void>;
};
const SCHEMA = /^rehablo_[a-f0-9]{32}$/i;
const TABLE = 'patient_settlement_operations';
const REQUIRED = ['id', 'patientId', 'structureId', 'idempotencyKey', 'requestHash', 'result', 'createdByUserId', 'createdAt'];
export function parsePatientSettlementMigrationArguments(flags: string[]) {
    if (flags.length === 1 && flags[0] === '--help') return {help: true, apply: false, schema: undefined as string | undefined};
    let apply = false, check = false, schema: string | undefined;
    for (let index = 0; index < flags.length; index++) {
        if (flags[index] === '--apply' && !apply) apply = true;
        else if (flags[index] === '--check' && !check) check = true;
        else if (flags[index] === '--schema' && schema === undefined) {
            schema = flags[++index]; if (!schema || !SCHEMA.test(schema)) throw new Error('Invalid tenant schema');
        } else throw new Error('Use only --check or --apply and optional --schema <existing tenant schema>');
    }
    if (apply && check) throw new Error('Use only --check or --apply');
    return {help: false, apply, schema};
}
export async function inspectPatientSettlements(connection: {query(sql: string, options?: any): Promise<any>}, schema: string) {
    if (!SCHEMA.test(schema)) throw new Error('Invalid tenant schema');
    const [columns] = await connection.query('SELECT column_name FROM information_schema.columns WHERE table_schema = :schema AND table_name = :table',
        {replacements: {schema, table: TABLE}});
    const present = new Set((columns as Array<{column_name: string}>).map(row => row.column_name));
    const missingColumns = REQUIRED.filter(column => !present.has(column));
    const [indexes] = await connection.query(`SELECT i.indisunique AS is_unique,
        ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS columns
        FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = :schema AND t.relname = :table`, {replacements: {schema, table: TABLE}});
    const uniqueKey = (indexes as Array<{is_unique: boolean; columns: string[]}>).some(row => row.is_unique && row.columns.join(',') === 'idempotencyKey');
    const [registry] = await connection.query('SELECT to_regclass(:registry) AS registry', {replacements: {registry: `"${schema}"."schema_migrations"`}});
    let versionApplied = false;
    if (registry[0]?.registry) {
        const [versions] = await connection.query(`SELECT 1 FROM "${schema}"."schema_migrations" WHERE "version" = :version`, {replacements: {version: migration.VERSION}});
        versionApplied = versions.length > 0;
    }
    return {schema, missingColumns, uniqueKey, versionApplied, ready: !missingColumns.length && uniqueKey && versionApplied};
}
async function main() {
    const options = parsePatientSettlementMigrationArguments(process.argv.slice(2));
    if (options.help) {console.log('Usage: npm run migrate:patient-settlements -- [--check | --apply] [--schema rehablo_<tenant UUID>]'); return;}
    await sequelize.authenticate();
    const [rows] = await sequelize.query(`SELECT nspname AS schema FROM pg_namespace WHERE nspname ~* '^rehablo_[a-f0-9]{32}$'
        ${options.schema ? 'AND nspname = :schema' : ''} ORDER BY nspname`, options.schema ? {replacements: {schema: options.schema}} : {});
    if (!rows.length) throw new Error('No existing matching tenant schema found');
    for (const row of rows as Array<{schema: string}>) {
        if (options.apply) await sequelize.transaction(async transaction => {
            await lockTenantSchema(sequelize, row.schema, transaction);
            await migration.up(sequelize.getQueryInterface(), {schema: row.schema, transaction});
            await sequelize.query(`CREATE TABLE IF NOT EXISTS "${row.schema}"."schema_migrations" (
                "version" VARCHAR(160) PRIMARY KEY, "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`, {transaction});
            await sequelize.query(`INSERT INTO "${row.schema}"."schema_migrations" ("version") VALUES (:version)
                ON CONFLICT ("version") DO NOTHING`, {transaction, replacements: {version: migration.VERSION}});
        });
        const readiness = await inspectPatientSettlements(sequelize, row.schema);
        console.log(JSON.stringify(readiness));
        if (!readiness.ready) process.exitCode = options.apply ? 1 : 2;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(() => {console.error('Patient settlement migration failed. No credentials or SQL details were logged.'); process.exitCode = 1;})
        .finally(() => sequelize.close());
}
