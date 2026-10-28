import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';
import type {Sequelize, Transaction} from 'sequelize';
import {
    ADMINISTRATION_SEED_VERSION, APPOINTMENT_LEDGER_VERSION, prepareTenantPaymentHistory,
    runTenantMigrations, tenantMigrations
} from './tenantMigrations.js';

const schema = 'rehablo_00000000000040008000000000000001';
const transaction = {id: 'migration-transaction'} as unknown as Transaction;
const originalMigrations = tenantMigrations.map(migration => ({version: migration.version, module: migration.module, up: migration.module.up}));
let queries: Array<{sql: string; options?: any}>;
let applied: Map<string, string>;
let calls: string[];
let transactionStarts: number;
let agendaExists: boolean;
let historyExists: boolean;
let invoiceNullable: boolean;
let migrationWork: (version: string) => Promise<void>;
let database: Sequelize;

beforeEach(() => {
    queries = [];
    applied = new Map();
    calls = [];
    transactionStarts = 0;
    agendaExists = true;
    historyExists = false;
    invoiceNullable = false;
    migrationWork = async () => {};
    database = {
        getQueryInterface: () => ({sequelize: database}),
        transaction: async (work: (current: Transaction) => Promise<unknown>) => {
            transactionStarts++;
            const previous = new Map(applied);
            try {return await work(transaction);}
            catch (error) {applied = previous; throw error;}
        },
        query: async (sql: string, options?: any) => {
            queries.push({sql, options});
            if (sql.includes('to_regclass')) return [[{agenda: agendaExists ? schema + '.agenda_events' : null}]];
            if (sql.includes('information_schema.columns')) return [[
                {table_name: 'invoice_payments', column_name: 'invoiceId', is_nullable: invoiceNullable ? 'YES' : 'NO'},
                ...(historyExists ? [{table_name: 'agenda_events', column_name: 'appointmentPaymentHistoryKnown'}] : [])
            ]];
            if (sql.startsWith('SELECT "version"')) return [[...applied.keys()].map(version => ({version}))];
            if (sql.startsWith('INSERT INTO') && options?.replacements?.version) {
                applied.set(options.replacements.version, 'new-migration-timestamp');
            }
            return [[]];
        }
    } as unknown as Sequelize;
    for (const migration of tenantMigrations) {
        migration.module.up = async (queryInterface, options) => {
            assert.equal(queryInterface.sequelize, database);
            assert.equal(options.schema, schema);
            assert.equal(options.transaction, transaction);
            calls.push(migration.version);
            await migrationWork(migration.version);
        };
    }
});

afterEach(() => {
    for (const original of originalMigrations) original.module.up = original.up;
});

describe('tenant migration history and transactions', () => {
    it('preserves completed cash imports and publication migrations while applying only pending versions', async () => {
        const completed = [APPOINTMENT_LEDGER_VERSION, ADMINISTRATION_SEED_VERSION, '20260924-backfill-patient-publication'];
        for (const version of [...completed, 'historic-model-baseline']) applied.set(version, 'original-timestamp');

        const result = await runTenantMigrations(schema, true, database);

        const pending = tenantMigrations.map(migration => migration.version).filter(version => !completed.includes(version));
        assert.deepEqual(result, pending);
        assert.deepEqual(calls, pending);
        for (const version of [...completed, 'historic-model-baseline']) assert.equal(applied.get(version), 'original-timestamp');
        assert.equal(transactionStarts, 1);
        assert.ok(queries.every(query => query.options?.transaction === transaction));
    });

    it('does not rerun migrations or overwrite their timestamps when all registered versions are complete', async () => {
        for (const migration of tenantMigrations) applied.set(migration.version, 'original-timestamp');

        assert.deepEqual(await runTenantMigrations(schema, false, database), []);

        assert.deepEqual(calls, []);
        assert.ok(queries.every(query => !query.sql.startsWith('INSERT INTO')));
        assert.ok([...applied.values()].every(timestamp => timestamp === 'original-timestamp'));
    });

    it('passes the historical evidence and caller transaction through migration and completion recording', async () => {
        for (const migration of tenantMigrations) {
            if (migration.version !== APPOINTMENT_LEDGER_VERSION) applied.set(migration.version, 'original-timestamp');
        }
        const ledger = tenantMigrations.find(migration => migration.version === APPOINTMENT_LEDGER_VERSION)!;
        let completedWork = false;
        ledger.module.up = async (_queryInterface, options) => {
            assert.equal(options.schema, schema);
            assert.equal(options.transaction, transaction);
            assert.equal(options.repairHistoryKnown, true);
            assert.equal(applied.has(APPOINTMENT_LEDGER_VERSION), false, 'Completion must follow successful work');
            completedWork = true;
        };

        assert.deepEqual(await runTenantMigrations(schema, true, database, transaction), [APPOINTMENT_LEDGER_VERSION]);

        assert.equal(completedWork, true);
        assert.equal(transactionStarts, 0, 'The caller owns the transaction');
        assert.equal(applied.has(APPOINTMENT_LEDGER_VERSION), true);
        assert.ok(queries.every(query => query.options?.transaction === transaction));
    });

    it('rolls back earlier completion records on failure and retries the unfinished transaction', async () => {
        const [first, second] = tenantMigrations;
        for (const migration of tenantMigrations.slice(2)) applied.set(migration.version, 'original-timestamp');
        migrationWork = async version => {if (version === second.version) throw new Error('Migration failed');};

        await assert.rejects(runTenantMigrations(schema, false, database), /Migration failed/);
        assert.equal(applied.has(first.version), false);
        assert.equal(applied.has(second.version), false);

        migrationWork = async () => {};
        assert.deepEqual(await runTenantMigrations(schema, false, database), [first.version, second.version]);
        assert.deepEqual(await runTenantMigrations(schema, false, database), []);
        assert.deepEqual(calls, [first.version, second.version, first.version, second.version]);
        assert.equal(transactionStarts, 3);
    });
});

describe('historical payment evidence before schema migration', () => {
    it('marks existing history unknown before setting the default for future appointments', async () => {
        assert.equal(await prepareTenantPaymentHistory(schema, database, transaction), true);

        const changes = queries.filter(query => query.sql.startsWith('ALTER TABLE'));
        assert.equal(changes.length, 2);
        assert.match(changes[0].sql, /ADD COLUMN IF NOT EXISTS "appointmentPaymentHistoryKnown" BOOLEAN NOT NULL DEFAULT false/);
        assert.match(changes[1].sql, /ALTER COLUMN "appointmentPaymentHistoryKnown" SET DEFAULT true/);
        assert.ok(queries.every(query => query.options?.transaction === transaction));
        assert.equal(transactionStarts, 0);
    });

    it('preserves existing historical flags when the ledger already accepts appointment payments', async () => {
        historyExists = true;
        invoiceNullable = true;

        assert.equal(await prepareTenantPaymentHistory(schema, database, transaction), false);

        assert.ok(queries.every(query => !/^(ALTER|UPDATE|INSERT|DELETE)/.test(query.sql)));
    });

    it('does not classify a new tenant without agenda data as historical', async () => {
        agendaExists = false;

        assert.equal(await prepareTenantPaymentHistory(schema, database), false);

        assert.ok(queries.every(query => !query.sql.startsWith('ALTER TABLE')));
        assert.equal(transactionStarts, 1);
    });

    it('rejects invalid schema names before accessing the database', async () => {
        await assert.rejects(runTenantMigrations('public', false, database), /Invalid tenant schema/);
        await assert.rejects(prepareTenantPaymentHistory('rehablo_bad"', database), /Invalid tenant schema/);
        assert.equal(queries.length, 0);
        assert.equal(transactionStarts, 0);
    });
});

describe('preserved tenant data migration policies', () => {
    it('adds the patient preference with an indexed SET NULL foreign key', async () => {
        const migrationQueries: string[] = [];
        const queryInterface = {sequelize: {query: async (sql: string) => {
            migrationQueries.push(sql);
            if (sql.includes('to_regclass')) return [[{patients: schema + '.patients', eventTypes: schema + '.event_types'}]];
            return [[]];
        }}};
        const migration = originalMigrations.find(item => item.version === '20260908-add-patient-default-event-type')!;

        await migration.up(queryInterface as any, {schema, transaction});

        assert.ok(migrationQueries.some(sql => sql.includes('ADD COLUMN IF NOT EXISTS "defaultEventTypeId" UUID NULL')));
        assert.ok(migrationQueries.some(sql => sql.includes('patients_default_event_type_idx')));
        assert.ok(migrationQueries.some(sql => sql.includes('FOREIGN KEY ("defaultEventTypeId")')));
        assert.ok(migrationQueries.some(sql => sql.includes('ON UPDATE CASCADE ON DELETE SET NULL')));
    });

    it('adds optional price snapshots without changing existing appointment amounts', async () => {
        const migrationQueries: string[] = [];
        const migration = originalMigrations.find(item => item.version === '20260908-add-appointment-price-adjustments')!;

        await migration.up({sequelize: {query: async (sql: string, options: any) => {
            assert.equal(options.transaction, transaction);
            migrationQueries.push(sql);
            return [[]];
        }}} as any, {schema, transaction});

        assert.equal(migrationQueries.length, 6);
        assert.ok(migrationQueries.every(sql => sql.startsWith(`ALTER TABLE "${schema}".`) && sql.includes('ADD COLUMN IF NOT EXISTS')));
        assert.ok(migrationQueries.some(sql => sql.includes('"originalServicePrice"')));
        await assert.rejects(migration.up({} as any, {schema: 'public', transaction}), /Invalid tenant schema/);
    });
});
