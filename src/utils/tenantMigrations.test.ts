import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, beforeEach, describe, it} from 'node:test';
import {sequelize} from '../config/database.js';
import {env} from '../config/env.js';
import {
    ensureTenantSchema, invalidateTenantSchemaCache, provisionTenantSchema,
    registerTenantScopedModel, warmTenantSchemas
} from './tenantSchema.js';
import {
    APPOINTMENT_LEDGER_VERSION, prepareTenantPaymentHistory, runTenantMigrations,
    PATIENT_DEFAULT_EVENT_TYPE_VERSION, TENANT_MODEL_BASELINE_VERSION, APPOINTMENT_PRICE_ADJUSTMENTS_VERSION
} from './tenantMigrations.js';

const require = createRequire(import.meta.url);
const migration = require('../../migrations/20260907-unify-appointment-payment-ledger.js');
const patientDefaultMigration = require('../../migrations/20260908-add-patient-default-event-type.js');
const pricingMigration = require('../../migrations/20260908-add-appointment-price-adjustments.js');
const tenant = '00000000-0000-4000-8000-000000000001';
const schema = 'rehablo_' + tenant.replaceAll('-', '');
const original = {
    query: sequelize.query, transaction: sequelize.transaction, createSchema: sequelize.createSchema,
    migrate: migration.up, patientDefaultMigrate: patientDefaultMigration.up, pricingMigrate: pricingMigration.up, mode: env.tenantSchemaSync
};
let queries: string[], order: string[], applied: boolean, patientDefaultApplied: boolean, syncs: number, migrations: number;
let historyExists: boolean, agendaExists: boolean, transactionStarts: number, baselineApplied: boolean;
let legacyBaselineApplied: boolean;
let lastSyncOptions: any;
let pricingApplied: boolean;
let migrationWork: (options: any) => Promise<void>;
const transaction = {id: 'test-transaction'};

registerTenantScopedModel({schema: () => ({sync: async (options: any) => {
    lastSyncOptions = options; order.push('sync'); syncs++; historyExists = true;
}})} as any);

beforeEach(() => {
    invalidateTenantSchemaCache();
    env.tenantSchemaSync = 'additive';
    queries = []; order = []; applied = false; patientDefaultApplied = false; syncs = 0; migrations = 0;
    historyExists = false; agendaExists = true; transactionStarts = 0; baselineApplied = false;
    legacyBaselineApplied = false;
    lastSyncOptions = undefined;
    pricingApplied = false;
    migrationWork = async () => {};
    sequelize.createSchema = (async () => {}) as any;
    sequelize.transaction = (async (callback: any) => {
        transactionStarts++;
        const previouslyApplied = applied, previousBaseline = baselineApplied;
        try {return await callback(transaction);} catch (error) {
            applied = previouslyApplied; baselineApplied = previousBaseline; throw error;
        }
    }) as any;
    sequelize.query = (async (sql: string, options?: any) => {
        queries.push(sql);
        if (sql.includes('to_regclass') && options?.replacements?.registry) {
            return [[{registry: baselineApplied || legacyBaselineApplied ? schema + '.schema_migrations' : null}]];
        }
        if (sql.includes('to_regclass')) return [[{agenda: agendaExists ? schema + '.agenda_events' : null}]];
        if (sql.includes('information_schema.columns')) return [[
            {table_name: 'invoice_payments', column_name: 'invoiceId', is_nullable: 'NO'},
            ...(historyExists ? [{table_name: 'agenda_events', column_name: 'appointmentPaymentHistoryKnown', is_nullable: 'NO'}] : [])
        ]];
        if (sql.includes('ADD COLUMN IF NOT EXISTS "appointmentPaymentHistoryKnown"')) {order.push('preserve-history'); historyExists = true;}
        if (sql.startsWith('SELECT "version"')) return [[
            ...(applied ? [{version: APPOINTMENT_LEDGER_VERSION}] : []),
            ...(patientDefaultApplied ? [{version: PATIENT_DEFAULT_EVENT_TYPE_VERSION}] : []),
            ...(pricingApplied ? [{version: APPOINTMENT_PRICE_ADJUSTMENTS_VERSION}] : []),
            ...(legacyBaselineApplied ? [{version: '20260907-tenant-model-baseline-v1'}] : []),
            ...(baselineApplied ? [{version: TENANT_MODEL_BASELINE_VERSION}] : [])
        ]];
        if (sql.startsWith('INSERT INTO') && options?.replacements?.version === APPOINTMENT_LEDGER_VERSION) {
            applied = true; order.push('record-version');
        }
        if (sql.startsWith('INSERT INTO') && options?.replacements?.version === PATIENT_DEFAULT_EVENT_TYPE_VERSION) {
            patientDefaultApplied = true; order.push('record-version');
        }
        if (sql.startsWith('INSERT INTO') && options?.replacements?.version === TENANT_MODEL_BASELINE_VERSION) {
            baselineApplied = true;
        }
        if (sql.startsWith('INSERT INTO') && options?.replacements?.version === APPOINTMENT_PRICE_ADJUSTMENTS_VERSION) {
            pricingApplied = true; order.push('record-version');
        }
        return [[]];
    }) as any;
    migration.up = async (_queryInterface: any, options: any) => {
        assert.equal(options.schema, schema);
        assert.equal(options.transaction, transaction);
        assert.equal(options.repairHistoryKnown, true);
        migrations++; order.push('migrate');
        await migrationWork(options);
    };
    patientDefaultMigration.up = async (_queryInterface: any, options: any) => {
        assert.equal(options.schema, schema);
        assert.equal(options.transaction, transaction);
        migrations++; order.push('migrate');
    };
    pricingMigration.up = patientDefaultMigration.up;
});

after(() => {
    sequelize.query = original.query; sequelize.transaction = original.transaction;
    sequelize.createSchema = original.createSchema; migration.up = original.migrate;
    patientDefaultMigration.up = original.patientDefaultMigrate;
    pricingMigration.up = original.pricingMigrate;
    env.tenantSchemaSync = original.mode;
    invalidateTenantSchemaCache();
});

describe('tenant schema bootstrap', () => {
    it('preserves old history before model sync and records completion after migration', async () => {
        assert.equal(await ensureTenantSchema(tenant), schema);
        assert.deepEqual(order, ['preserve-history', 'sync', 'migrate', 'record-version', 'migrate', 'record-version', 'migrate', 'record-version']);
        assert.equal(applied, true);
        assert.equal(patientDefaultApplied, true);
        assert.equal(lastSyncOptions.transaction, transaction);
        assert.ok(queries.some(sql => sql.includes('DEFAULT false')));
        assert.ok(queries.some(sql => sql.includes('pg_advisory_xact_lock')));
        const count = queries.length;
        await ensureTenantSchema(tenant);
        assert.equal(queries.length, count);
    });

    it('warms each existing tenant once before HTTP startup', async () => {
        assert.equal(await warmTenantSchemas([tenant, tenant], 2), 1);
        assert.equal(syncs, 1);
        assert.equal(migrations, 3);
        assert.equal(transactionStarts, 1);
    });

    it('provisions a new tenant inside the registration transaction', async () => {
        assert.equal(await provisionTenantSchema(tenant, transaction as any), schema);
        assert.equal(transactionStarts, 0);
        assert.equal(lastSyncOptions.transaction, transaction);
        assert.deepEqual(order, ['preserve-history', 'sync', 'migrate', 'record-version', 'migrate', 'record-version', 'migrate', 'record-version']);
    });

    it('shares initialization between simultaneous requests and waits for migration completion', async () => {
        let release!: () => void;
        let started!: () => void;
        const migrationStarted = new Promise<void>(resolve => {started = resolve;});
        const blocked = new Promise<void>(resolve => {release = resolve;});
        migrationWork = async () => {started(); await blocked;};
        let finished = 0;
        const first = ensureTenantSchema(tenant).then(() => {finished++;});
        const second = ensureTenantSchema(tenant).then(() => {finished++;});
        await migrationStarted;
        assert.equal(finished, 0);
        assert.equal(syncs, 1); assert.equal(migrations, 1);
        release(); await Promise.all([first, second]);
        assert.equal(finished, 2); assert.equal(migrations, 3);
    });

    it('retries failed migrations without caching the tenant or saving completion', async () => {
        migrationWork = async () => {throw new Error('Migration failed');};
        await assert.rejects(ensureTenantSchema(tenant), /Migration failed/);
        assert.equal(applied, false);
        migrationWork = async () => {};
        await ensureTenantSchema(tenant);
        assert.equal(migrations, 4); assert.equal(applied, true); assert.equal(patientDefaultApplied, true); assert.equal(pricingApplied, true);
    });

    it('uses the persisted version after process-cache invalidation instead of importing again', async () => {
        await ensureTenantSchema(tenant);
        invalidateTenantSchemaCache();
        await ensureTenantSchema(tenant);
        assert.equal(syncs, 1); assert.equal(migrations, 3);
        assert.equal(transactionStarts, 1);
    });

    it('resyncs an existing tenant when the registered model baseline changes', async () => {
        applied = true;
        patientDefaultApplied = true;
        pricingApplied = true;
        legacyBaselineApplied = true;

        await ensureTenantSchema(tenant);

        assert.equal(syncs, 1);
        assert.equal(migrations, 0);
        assert.equal(baselineApplied, true);
        assert.equal(transactionStarts, 1);
    });

    it('respects explicit off mode for environments managed with manual migrations', async () => {
        env.tenantSchemaSync = 'off';
        await ensureTenantSchema(tenant);
        assert.equal(syncs, 0); assert.equal(migrations, 0); assert.equal(queries.length, 0);
    });

    it('does not classify a newly created tenant as historical', async () => {
        agendaExists = false;
        assert.equal(await prepareTenantPaymentHistory(schema), false);
        assert.ok(queries.every(sql => !sql.startsWith('ALTER TABLE')));
    });

    it('rejects invalid tenant names before accessing the database', async () => {
        await assert.rejects(runTenantMigrations('public'), /Invalid tenant schema/);
        await assert.rejects(prepareTenantPaymentHistory('rehablo_bad"'), /Invalid tenant schema/);
        assert.equal(queries.length, 0);
    });

    it('adds the patient preference with an indexed SET NULL foreign key', async () => {
        const migrationQueries: string[] = [];
        const queryInterface = {
            sequelize: {
                query: async (sql: string) => {
                    migrationQueries.push(sql);
                    if (sql.includes('to_regclass')) {
                        return [[{patients: schema + '.patients', eventTypes: schema + '.event_types'}]];
                    }
                    if (sql.includes('FROM pg_constraint')) return [[]];
                    return [[]];
                }
            }
        };

        await original.patientDefaultMigrate(queryInterface as any, {schema, transaction});

        assert.ok(migrationQueries.some(sql => sql.includes('ADD COLUMN IF NOT EXISTS "defaultEventTypeId" UUID NULL')));
        assert.ok(migrationQueries.some(sql => sql.includes('patients_default_event_type_idx')));
        assert.ok(migrationQueries.some(sql => sql.includes('FOREIGN KEY ("defaultEventTypeId")')));
        assert.ok(migrationQueries.some(sql => sql.includes('ON UPDATE CASCADE ON DELETE SET NULL')));
    });

    it('adds optional price snapshots without changing existing appointment amounts', async () => {
        const queries: string[] = [];
        await original.pricingMigrate({sequelize: {query: async (sql: string, options: any) => {
            assert.equal(options.transaction, transaction); queries.push(sql); return [[]];
        }}}, {schema, transaction});
        assert.equal(queries.length, 6);
        assert.ok(queries.every(sql => sql.startsWith(`ALTER TABLE "${schema}".`) && sql.includes('ADD COLUMN IF NOT EXISTS')));
        assert.ok(queries.some(sql => sql.includes('"originalServicePrice"')));
        await assert.rejects(original.pricingMigrate({}, {schema: 'public'}), /Invalid tenant schema/);
    });
});
