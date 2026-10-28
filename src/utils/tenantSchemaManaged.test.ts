import assert from 'node:assert/strict';
import {after, beforeEach, test} from 'node:test';
import type {Transaction} from 'sequelize';
import {sequelize} from '../config/database.js';
import {requiredMigrationNames} from '../database/standardMigrations.js';
import {
    beginTenantProvisioning, ensureTenantSchema, invalidateTenantSchemaCache,
    markTenantSchemaReady, registerTenantScopedModel
} from './tenantSchema.js';

const tenantId = '00000000-0000-4000-8000-000000000003';
const schema = 'rehablo_' + tenantId.replaceAll('-', '');
const original = {query: sequelize.query, transaction: sequelize.transaction,
    phase: process.env.DATABASE_MIGRATION_PHASE, syncMode: process.env.TENANT_SCHEMA_SYNC};
const transaction = {id: 'registration-transaction'} as unknown as Transaction;
let queries: Array<{sql: string; options?: any}>;
let tenantVersions: string[];
let publicVersions: string[];
let tenantRegistryExists: boolean;

registerTenantScopedModel({schema: () => ({sync: async () => {throw new Error('Runtime must never call Model.sync');}})} as any);

beforeEach(() => {
    invalidateTenantSchemaCache();
    queries = [];
    tenantVersions = [...requiredMigrationNames];
    publicVersions = [...requiredMigrationNames];
    tenantRegistryExists = true;
    sequelize.transaction = (async () => {throw new Error('Readiness must not acquire another transaction');}) as any;
    sequelize.query = (async (sql: string, options?: any) => {
        queries.push({sql, options});
        if (!/^SELECT\b/.test(sql)) throw new Error('Runtime readiness must only read migration history');
        if (sql.includes('to_regclass')) {
            const registry = String(options?.replacements?.registry ?? '');
            return [[{registry: registry.includes(schema) && !tenantRegistryExists ? null : registry}]];
        }
        if (sql.includes('SequelizeMeta')) {
            const versions = sql.includes(schema) ? tenantVersions : publicVersions;
            return [versions.map(name => ({name}))];
        }
        throw new Error('Unexpected readiness query: ' + sql);
    }) as any;
});

after(() => {
    sequelize.query = original.query;
    sequelize.transaction = original.transaction;
    if (original.phase === undefined) delete process.env.DATABASE_MIGRATION_PHASE;
    else process.env.DATABASE_MIGRATION_PHASE = original.phase;
    if (original.syncMode === undefined) delete process.env.TENANT_SCHEMA_SYNC;
    else process.env.TENANT_SCHEMA_SYNC = original.syncMode;
    invalidateTenantSchemaCache();
});

test('tenant access reads its standard migration history once and then uses the process cache', async () => {
    assert.equal(await ensureTenantSchema(tenantId), schema);
    const reads = queries.length;
    assert.ok(reads > 0);
    assert.equal(await ensureTenantSchema(tenantId), schema);
    assert.equal(queries.length, reads);
    assert.ok(queries.every(({sql}) => /^SELECT\b/.test(sql)));
    assert.ok(queries.some(({sql}) => sql.includes(schema) && sql.includes('SequelizeMeta')));
});

test('simultaneous requests share the same tenant readiness lookup', async () => {
    const query = sequelize.query;
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => {finish = resolve;});
    sequelize.query = (async (...args: any[]) => {await waiting; return (query as any)(...args);}) as any;
    const first = ensureTenantSchema(tenantId);
    const second = ensureTenantSchema(tenantId);
    finish();
    assert.deepEqual(await Promise.all([first, second]), [schema, schema]);
    assert.equal(queries.filter(({sql}) => sql.includes('to_regclass')).length, 1);
    assert.equal(queries.filter(({sql}) => sql.includes('FROM') && sql.includes('SequelizeMeta')).length, 1);
});

test('incomplete tenant migrations fail and can be retried after the database has been migrated', async () => {
    tenantVersions = requiredMigrationNames.slice(0, 1);
    await assert.rejects(ensureTenantSchema(tenantId), (error: any) => error.statusCode === 503);
    const failedReads = queries.length;
    tenantVersions = [...requiredMigrationNames];
    assert.equal(await ensureTenantSchema(tenantId), schema);
    assert.ok(queries.length > failedReads, 'A failed readiness check must not populate the cache');
    assert.ok(queries.every(({sql}) => /^SELECT\b/.test(sql)));
});

test('a missing tenant metadata table fails without creating or synchronizing the schema', async () => {
    tenantRegistryExists = false;
    await assert.rejects(ensureTenantSchema(tenantId), (error: any) => error.statusCode === 503);
    assert.equal(queries.length, 1);
    assert.ok(queries[0].sql.includes('to_regclass'));
});

test('provisioning checks global SequelizeMeta inside the caller transaction without a global lock', async () => {
    await beginTenantProvisioning(transaction);
    assert.ok(queries.length > 0);
    assert.ok(queries.every(query => query.options?.transaction === transaction));
    assert.ok(queries.every(({sql}) => /^SELECT\b/.test(sql) && !sql.includes('pg_advisory')));
});

test('a previous API cannot provision against migrations newer than its schema definition', async () => {
    publicVersions.push('202611010001-future-schema.js');
    await assert.rejects(beginTenantProvisioning(transaction), (error: any) => error.statusCode === 503);
    assert.ok(queries.every(query => query.options?.transaction === transaction));
    assert.ok(queries.every(({sql}) => /^SELECT\b/.test(sql)));
});

test('pending public migrations prevent registration before any tenant schema writes', async () => {
    publicVersions = requiredMigrationNames.slice(0, 1);
    await assert.rejects(beginTenantProvisioning(transaction), (error: any) => error.statusCode === 503);
    assert.ok(queries.every(({sql}) => /^SELECT\b/.test(sql)));
});

test('legacy phase and synchronization settings never enable request-time schema changes', async () => {
    process.env.DATABASE_MIGRATION_PHASE = 'bridge';
    process.env.TENANT_SCHEMA_SYNC = 'full';
    assert.equal(await ensureTenantSchema(tenantId), schema);
    invalidateTenantSchemaCache();
    tenantVersions = [];
    await assert.rejects(ensureTenantSchema(tenantId), (error: any) => error.statusCode === 503);
    assert.ok(queries.every(({sql}) => /^SELECT\b/.test(sql)));
});

test('a controller can cache a newly provisioned tenant only after committing its transaction', async () => {
    tenantVersions = [];
    await assert.rejects(ensureTenantSchema(tenantId), (error: any) => error.statusCode === 503);
    markTenantSchemaReady(tenantId);
    const count = queries.length;
    assert.equal(await ensureTenantSchema(tenantId), schema);
    assert.equal(queries.length, count);
    invalidateTenantSchemaCache(tenantId);
    await assert.rejects(ensureTenantSchema(tenantId), (error: any) => error.statusCode === 503);
});
