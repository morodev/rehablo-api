/**
 * Single ledger migration runner. --check only reads metadata and aggregate import counts.
 * --schema limits both inspection and writes to one existing tenant; no tenant is created.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { sequelize } from '../config/database.js';

const require = createRequire(import.meta.url);
const migration = require('../../migrations/20260907-unify-appointment-payment-ledger.js') as {
    up(queryInterface: ReturnType<typeof sequelize.getQueryInterface>, options?: { schema?: string }): Promise<void>;
};
const SCHEMA = /^rehablo_[a-f0-9]{32}$/i;
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
type QueryConnection = { query(sql: string, options?: any): Promise<any> };

export function parseMigrationArguments(flags: string[]): { help: boolean; apply: boolean; schema?: string } {
    if (flags.includes('--help')) return { help: true, apply: false };
    let apply = false;
    let check = false;
    let schema: string | undefined;
    for (let index = 0; index < flags.length; index++) {
        const flag = flags[index];
        if (flag === '--apply' && !apply) apply = true;
        else if (flag === '--check' && !check) check = true;
        else if (flag === '--schema' && schema === undefined) {
            schema = flags[++index];
            if (!schema || !SCHEMA.test(schema)) throw new Error('Invalid tenant schema: expected rehablo_ followed by a UUID without hyphens.');
        } else throw new Error('Use only --check or --apply and optional --schema <existing tenant schema>.');
    }
    if (apply && check) throw new Error('Use only --check or --apply, not both.');
    return { help: false, apply, schema };
}

interface Column { table_name: string; column_name: string; is_nullable: string; }
interface Index { table_name: string; index_name: string; is_unique: boolean; columns: string[]; predicate: string | null; }
export interface LedgerReadiness {
    schema: string;
    missingPrerequisites: string[];
    missingLedgerColumns: string[];
    invoiceIdNullable: boolean;
    legacyUniqueIndexes: string[];
    missingRequiredIndexes: string[];
    pendingImports: number | null;
    historyKnownCleanup: number | null;
    ready: boolean;
}

/** Metadata and counts only: no patients, amounts, notes or credentials are returned. */
export async function inspectAppointmentLedger(connection: QueryConnection, schema: string): Promise<LedgerReadiness> {
    if (!SCHEMA.test(schema)) throw new Error('Invalid tenant schema.');
    const [columns]: [Column[]] = await connection.query(
        'SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = :schema',
        { replacements: { schema } }
    );
    const available = new Set(columns.map(column => column.table_name + '.' + column.column_name));
    const required: Record<string, string[]> = {
        agenda_events: ['id', 'invoiceId', 'appointmentPaymentStatus', 'appointmentPaidAmount', 'appointmentPaidAt',
            'appointmentPaymentMethod', 'appointmentPaymentNote', 'appointmentPaymentRecordedBy'],
        invoice_payments: ['id', 'invoiceId', 'agendaEventId', 'amount', 'paidAt', 'source', 'status',
            'method', 'note', 'createdByUserId', 'createdAt', 'updatedAt'],
        invoices: ['id', 'agendaEventId', 'status']
    };
    const missingPrerequisites = Object.entries(required).flatMap(([table, names]) =>
        names.filter(name => !available.has(table + '.' + name)).map(name => table + '.' + name));
    const ledgerColumns = [
        ...['appointmentExpectedAmount', 'appointmentNetAmount', 'appointmentVatRate',
            'appointmentPriceRecordedAt', 'appointmentPaymentHistoryKnown'].map(name => 'agenda_events.' + name),
        ...['id', 'invoiceId', 'agendaEventId', 'serviceId', 'releasedAt', 'createdAt', 'updatedAt'].map(name => 'invoice_agenda_events.' + name)
    ];
    const missingLedgerColumns = ledgerColumns.filter(name => !available.has(name));
    const invoiceIdNullable = columns.some(column => column.table_name === 'invoice_payments'
        && column.column_name === 'invoiceId' && column.is_nullable === 'YES');
    const [indexes]: [Index[]] = await connection.query(`
        SELECT t.relname AS table_name, idx.relname AS index_name, i.indisunique AS is_unique,
            pg_get_expr(i.indpred, i.indrelid) AS predicate,
            ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS columns
        FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_class idx ON idx.oid = i.indexrelid
        WHERE n.nspname = :schema AND t.relname IN ('invoice_payments', 'invoice_agenda_events')`,
    { replacements: { schema } });
    const isActiveIndex = (index: Index) => index.table_name === 'invoice_agenda_events'
        && index.index_name === 'invoice_agenda_events_active_event_unique' && index.is_unique
        && index.columns.length === 1 && index.columns[0] === 'agendaEventId'
        && (index.predicate ?? '').replace(/[()\s]/g, '') === '"releasedAt"ISNULL';
    const legacyUniqueIndexes = indexes.filter(index => index.is_unique && index.columns.length === 1
        && index.columns[0] === 'agendaEventId' && !isActiveIndex(index)).map(index => index.index_name);
    const missingRequiredIndexes: string[] = [];
    if (!indexes.some(index => index.table_name === 'invoice_payments' && !index.is_unique
        && index.columns.join(',') === 'agendaEventId,status')) missingRequiredIndexes.push('invoice_payments_agenda_event_status_idx');
    if (!indexes.some(isActiveIndex)) missingRequiredIndexes.push('invoice_agenda_events_active_event_unique');

    let pendingImports: number | null = null;
    let historyKnownCleanup: number | null = null;
    if (!missingPrerequisites.length) {
        const prefix = quote(schema) + '.';
        const agenda = prefix + '"agenda_events"';
        const payments = prefix + '"invoice_payments"';
        const invoices = prefix + '"invoices"';
        const hasLinks = available.has('invoice_agenda_events.agendaEventId');
        const activeLinks = hasLinks ? `AND NOT EXISTS (SELECT 1 FROM ${prefix}"invoice_agenda_events" l
            WHERE l."agendaEventId" = a."id"${available.has('invoice_agenda_events.releasedAt') ? ' AND l."releasedAt" IS NULL' : ''})` : '';
        const [pending] = await connection.query(`
            SELECT COUNT(*)::integer AS count FROM ${agenda} a
            WHERE a."invoiceId" IS NULL AND COALESCE(a."appointmentPaidAmount", 0) > 0
                AND a."appointmentPaymentStatus" IN ('paid', 'partial') ${activeLinks}
                AND NOT EXISTS (SELECT 1 FROM ${invoices} i WHERE i."agendaEventId" = a."id" AND LOWER(COALESCE(i."status", '')) <> 'void')
                AND NOT EXISTS (SELECT 1 FROM ${payments} p WHERE p."agendaEventId" = a."id")`);
        pendingImports = Number(pending[0]?.count ?? 0);
        if (!invoiceIdNullable && available.has('agenda_events.appointmentPaymentHistoryKnown')) {
            const [cleanup] = await connection.query(`
                SELECT COUNT(*)::integer AS count FROM ${agenda} a
                WHERE a."appointmentPaymentHistoryKnown" = true
                    ${available.has('agenda_events.appointmentPriceRecordedAt') ? 'AND a."appointmentPriceRecordedAt" IS NULL' : ''}
                    AND a."appointmentPaymentRecordedBy" IS NULL
                    AND NOT (COALESCE(a."appointmentPaidAmount", 0) > 0 AND COALESCE(a."appointmentPaymentStatus", '') IN ('paid', 'partial'))
                    AND NOT EXISTS (SELECT 1 FROM ${payments} p WHERE p."agendaEventId" = a."id")`);
            historyKnownCleanup = Number(cleanup[0]?.count ?? 0);
        } else historyKnownCleanup = 0;
    }
    return { schema, missingPrerequisites, missingLedgerColumns, invoiceIdNullable, legacyUniqueIndexes,
        missingRequiredIndexes, pendingImports, historyKnownCleanup,
        ready: !missingPrerequisites.length && !missingLedgerColumns.length && invoiceIdNullable
            && !legacyUniqueIndexes.length && !missingRequiredIndexes.length && pendingImports === 0 };
}

function printReadiness(report: LedgerReadiness): void {
    console.log(JSON.stringify(report));
}

async function main(): Promise<void> {
    const options = parseMigrationArguments(process.argv.slice(2));
    if (options.help) {
        console.log('Usage: npm run migrate:appointment-ledger -- [--check | --apply] [--schema rehablo_<tenant UUID without hyphens>]');
        console.log('--check (default) reports actual readiness, old constraints and pending imports; exit 2 means migration is required.');
        console.log('--apply runs only the ledger migration. --schema targets one existing tenant and never creates a schema.');
        console.log('Before --apply: stop API writers, back up the database and verify prerequisite agenda/payment tables.');
        return;
    }
    if (typeof migration.up !== 'function') throw new Error('The CommonJS ledger migration could not be loaded.');
    (sequelize as unknown as { options: { logging: boolean } }).options.logging = false;
    await sequelize.authenticate();
    const [schemas] = await sequelize.query(
        options.schema ? 'SELECT schema_name FROM information_schema.schemata WHERE schema_name = :schema'
            : "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'",
        options.schema ? { replacements: { schema: options.schema } } : {}
    );
    if (!schemas.length) throw new Error('No existing matching rehablo tenant schema found. Check --schema and database configuration.');
    const reports: LedgerReadiness[] = [];
    for (const row of schemas as Array<{ schema_name: string }>) {
        const report = await inspectAppointmentLedger(sequelize, row.schema_name);
        reports.push(report);
        printReadiness(report);
    }
    if (!options.apply) {
        if (reports.some(report => !report.ready)) process.exitCode = 2;
        console.log('Read-only readiness check complete. No migration was applied.');
        return;
    }
    const missing = reports.find(report => report.missingPrerequisites.length);
    if (missing) throw new Error('Existing agenda/payment prerequisites are missing in tenant ' + missing.schema + ': ' + missing.missingPrerequisites.join(', '));
    await migration.up(sequelize.getQueryInterface(), { schema: options.schema });
    for (const before of reports) {
        const after = await inspectAppointmentLedger(sequelize, before.schema);
        printReadiness(after);
        if (!after.ready) throw new Error('Ledger post-migration readiness check failed for tenant ' + before.schema);
    }
    console.log('Appointment ledger migration completed and readiness verified.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error: unknown) => {
        const message = error instanceof Error && !('sql' in error) && !('parent' in error)
            && /^(Use only|No existing|Existing agenda|The CommonJS|Invalid tenant|Selected tenant|Ledger post-migration)/.test(error.message)
            ? error.message : 'Migration failed. No credentials or SQL details were logged; investigate with the database administrator.';
        console.error(message);
        process.exitCode = 1;
    }).finally(() => sequelize.close());
}
