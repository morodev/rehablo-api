import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { inspectAppointmentLedger, parseMigrationArguments } from './migrateAppointmentLedger.js';

const require = createRequire(import.meta.url);
const migration = require('../../migrations/20260907-unify-appointment-payment-ledger.js');
const schema = 'rehablo_00000000000040008000000000000001';
const columns = [
    ...['id', 'invoiceId', 'appointmentPaymentStatus', 'appointmentPaidAmount', 'appointmentPaidAt',
        'appointmentPaymentMethod', 'appointmentPaymentNote', 'appointmentPaymentRecordedBy',
        'appointmentExpectedAmount', 'appointmentNetAmount', 'appointmentVatRate', 'appointmentPriceRecordedAt',
        'appointmentPaymentHistoryKnown'].map(column_name => ({ table_name: 'agenda_events', column_name, is_nullable: 'YES' })),
    ...['id', 'invoiceId', 'agendaEventId', 'amount', 'paidAt', 'source', 'status', 'method', 'note',
        'createdByUserId', 'createdAt', 'updatedAt'].map(column_name => ({ table_name: 'invoice_payments', column_name, is_nullable: 'YES' })),
    ...['id', 'agendaEventId', 'status'].map(column_name => ({ table_name: 'invoices', column_name, is_nullable: 'YES' })),
    ...['id', 'invoiceId', 'agendaEventId', 'serviceId', 'releasedAt', 'createdAt', 'updatedAt']
        .map(column_name => ({ table_name: 'invoice_agenda_events', column_name, is_nullable: 'YES' }))
];
const readyIndexes = [
    { table_name: 'invoice_payments', index_name: 'invoice_payments_agenda_event_status_idx',
        is_unique: false, columns: ['agendaEventId', 'status'], predicate: null },
    { table_name: 'invoice_agenda_events', index_name: 'invoice_agenda_events_active_event_unique',
        is_unique: true, columns: ['agendaEventId'], predicate: '("releasedAt" IS NULL)' }
];

describe('ledger migration rollout selection', () => {
    it('accepts an explicit existing-schema name and rejects malformed or repeated arguments', () => {
        assert.deepEqual(parseMigrationArguments(['--apply', '--schema', schema]), { help: false, apply: true, schema });
        assert.equal(parseMigrationArguments(['--schema', schema]).apply, false);
        assert.throws(() => parseMigrationArguments(['--schema', 'public']));
        assert.throws(() => parseMigrationArguments(['--schema', schema + '"; DROP SCHEMA public']));
        assert.throws(() => parseMigrationArguments(['--schema']));
        assert.throws(() => parseMigrationArguments(['--check', '--apply']));
        assert.throws(() => parseMigrationArguments(['--schema', schema, '--schema', schema]));
    });

    it('reports the half-deployed additive-sync state as pending despite all new columns/indexes existing', async () => {
        const queried: string[] = [];
        const connection = { query: async (sql: string) => {
            queried.push(sql);
            if (sql.includes('information_schema.columns')) return [columns.map(column =>
                column.table_name === 'invoice_payments' && column.column_name === 'invoiceId'
                    ? { ...column, is_nullable: 'NO' } : column)];
            if (sql.includes('FROM pg_index')) return [[...readyIndexes,
                { table_name: 'invoice_payments', index_name: 'invoice_payments_agenda_event_unique',
                    is_unique: true, columns: ['agendaEventId'], predicate: '("agendaEventId" IS NOT NULL)' },
                { table_name: 'invoice_agenda_events', index_name: 'invoice_agenda_events_agendaEventId_key',
                    is_unique: true, columns: ['agendaEventId'], predicate: null }]];
            if (sql.includes('"appointmentPaymentHistoryKnown" = true')) return [[{ count: 12 }]];
            return [[{ count: 3 }]];
        } };
        const result = await inspectAppointmentLedger(connection, schema);
        assert.equal(result.ready, false);
        assert.equal(result.invoiceIdNullable, false);
        assert.deepEqual(result.missingLedgerColumns, []);
        assert.deepEqual(result.missingRequiredIndexes, []);
        assert.equal(result.pendingImports, 3);
        assert.equal(result.historyKnownCleanup, 12);
        assert.deepEqual(result.legacyUniqueIndexes, ['invoice_payments_agenda_event_unique', 'invoice_agenda_events_agendaEventId_key']);
        assert.ok(queried.every(sql => !/\b(UPDATE|INSERT|ALTER|DROP|CREATE|DELETE)\b/.test(sql)));
    });

    it('marks a fully migrated schema ready without misclassifying composite unique indexes', async () => {
        const connection = { query: async (sql: string) => {
            if (sql.includes('information_schema.columns')) return [columns];
            if (sql.includes('FROM pg_index')) {
                // pg decodes text[] as an array; PostgreSQL name[] is returned as a raw string.
                assert.match(sql, /ARRAY\(SELECT a\.attname::text/);
                return [[...readyIndexes,
                    { table_name: 'invoice_payments', index_name: 'audit_composite',
                        is_unique: true, columns: ['agendaEventId', 'id'], predicate: null }]];
            }
            return [[{ count: 0 }]];
        } };
        const result = await inspectAppointmentLedger(connection, schema);
        assert.equal(result.ready, true);
        assert.deepEqual(result.legacyUniqueIndexes, []);
        assert.equal(result.historyKnownCleanup, 0);
    });

    it('reports missing prerequisites without reading unavailable payment tables', async () => {
        const connection = { query: async (sql: string) => {
            if (sql.includes('information_schema.columns')) return [[]];
            if (sql.includes('FROM pg_index')) return [[]];
            throw new Error('An incomplete tenant must not be queried for payments');
        } };
        const result = await inspectAppointmentLedger(connection, schema);
        assert.equal(result.ready, false);
        assert.ok(result.missingPrerequisites.includes('invoice_payments.invoiceId'));
        assert.equal(result.pendingImports, null);
    });

    it('locks the selected tenant before classification and resets contaminated history only before the first successful upgrade', async () => {
        let nullable = false;
        const queries: string[] = [];
        const connection = {
            transaction: async (callback: any) => callback({ id: 'transaction' }),
            query: async (sql: string, options?: any) => {
                queries.push(sql);
                if (sql.includes('information_schema.schemata')) {
                    assert.equal(options.replacements.schema, schema);
                    assert.ok(sql.includes('schema_name = :schema'));
                    return [[{ schema_name: schema }]];
                }
                if (sql.includes('to_regclass')) return [[{ agenda: true, payments: true, invoices: true }]];
                if (sql.includes('information_schema.columns')) {
                    assert.ok(queries.some(query => query.startsWith('LOCK TABLE')));
                    return [[
                        { table_name: 'agenda_events', column_name: 'appointmentPaymentHistoryKnown', is_nullable: 'NO' },
                        { table_name: 'invoice_payments', column_name: 'invoiceId', is_nullable: nullable ? 'YES' : 'NO' }
                    ]];
                }
                if (sql.includes('ALTER COLUMN "invoiceId" DROP NOT NULL')) nullable = true;
                return [[]];
            }
        };
        await migration.up({ sequelize: connection }, { schema });
        assert.ok(queries.some(sql => sql === "SET LOCAL lock_timeout = '10s'"));
        assert.equal(queries.filter(sql => sql.includes('SET "appointmentPaymentHistoryKnown" = false')).length, 1);
        const reset = queries.find(sql => sql.includes('SET "appointmentPaymentHistoryKnown" = false'))!;
        assert.ok(reset.includes('"appointmentPriceRecordedAt" IS NULL'));
        assert.ok(reset.includes('"appointmentPaymentRecordedBy" IS NULL'));
        assert.ok(reset.includes('NOT EXISTS'));
        await migration.up({ sequelize: connection }, { schema });
        assert.equal(queries.filter(sql => sql.includes('SET "appointmentPaymentHistoryKnown" = false')).length, 1);
        assert.ok(queries.every(sql => !sql.includes('CREATE SCHEMA')));
    });

    it('rejects an absent or invalid selected schema before any transaction or mutation', async () => {
        const connection = {
            query: async () => [[]],
            transaction: async () => { throw new Error('Must not open a migration transaction'); }
        };
        await assert.rejects(migration.up({ sequelize: connection }, { schema }), /does not exist/);
        await assert.rejects(migration.up({ sequelize: connection }, { schema: 'public' }), /Invalid tenant schema/);
    });
});
