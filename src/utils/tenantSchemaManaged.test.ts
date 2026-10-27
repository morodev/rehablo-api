import assert from 'node:assert/strict';
import {after, beforeEach, test} from 'node:test';
import type {Transaction} from 'sequelize';
import {sequelize} from '../config/database.js';
import {env} from '../config/env.js';
import {databaseManifest} from '../database/migrationManifest.js';
import {
    beginTenantProvisioning, ensureTenantSchema, invalidateTenantSchemaCache,
    markTenantSchemaReady, provisionTenantSchema, registerTenantScopedModel
} from './tenantSchema.js';

const tenantId = '00000000-0000-4000-8000-000000000003';
const schema = 'rehablo_' + tenantId.replaceAll('-', '');
const original = {query: sequelize.query, transaction: sequelize.transaction, phase: env.databaseMigrationPhase,
    syncMode: env.tenantSchemaSync, migrations: databaseManifest.tenantMigrations};
let queries: Array<{sql: string; options?: any}>;
let compatible: boolean;
let currentRelease: string;
let migrationRuns: number;
const transaction = {id: 'registration-transaction'} as unknown as Transaction;

registerTenantScopedModel({schema: () => ({sync: async () => {throw new Error('Managed runtime must never call Model.sync');}})} as any);

beforeEach(() => {
    invalidateTenantSchemaCache();
    env.databaseMigrationPhase = 'managed';
    env.tenantSchemaSync = 'additive';
    queries = [];
    compatible = true;
    currentRelease = databaseManifest.id;
    migrationRuns = 0;
    databaseManifest.tenantMigrations = [{name: 'synthetic-provisioning-migration', scope: 'tenant', checksum: 'synthetic-checksum',
        up: async (database, currentSchema, currentTransaction) => {
            assert.equal(database, sequelize);
            assert.equal(currentSchema, schema);
            assert.equal(currentTransaction, transaction);
            migrationRuns++;
            await database.query(`CREATE TABLE "${currentSchema}"."synthetic_provisioning" (id UUID PRIMARY KEY)`, {transaction: currentTransaction});
        }}];
    sequelize.transaction = (async () => {throw new Error('Runtime/provisioning must use the caller transaction');}) as any;
    sequelize.query = (async (sql: string, options?: any) => {
        queries.push({sql, options});
        if (sql.includes('FROM public.tenant_schema_state t')) return [compatible ? [{
            releaseId: databaseManifest.id, checksum: databaseManifest.checksum, releaseChecksum: databaseManifest.checksum
        }] : []];
        if (sql.includes('FROM public.schema_control c JOIN public.schema_releases')) return [[{
            releaseId: currentRelease, checksum: databaseManifest.checksum, releaseChecksum: databaseManifest.checksum
        }]];
        return [[]];
    }) as any;
});

after(() => {
    sequelize.query = original.query;
    sequelize.transaction = original.transaction;
    env.databaseMigrationPhase = original.phase;
    env.tenantSchemaSync = original.syncMode;
    databaseManifest.tenantMigrations = original.migrations;
    invalidateTenantSchemaCache();
});

test('managed tenant access performs one central read then uses the cache without DDL or activation writes', async () => {
    assert.equal(await ensureTenantSchema(tenantId), schema);
    assert.equal(await ensureTenantSchema(tenantId), schema);
    assert.equal(queries.length, 1);
    assert.ok(queries[0].sql.startsWith('SELECT'));
    assert.ok(queries[0].sql.includes('public.tenant_schema_state'));
});

test('simultaneous managed requests share the same readiness lookup', async () => {
    const query = sequelize.query;
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => {finish = resolve;});
    sequelize.query = (async (...args: any[]) => {
        await waiting;
        return (query as any)(...args);
    }) as any;
    const first = ensureTenantSchema(tenantId);
    const second = ensureTenantSchema(tenantId);
    finish();
    assert.deepEqual(await Promise.all([first, second]), [schema, schema]);
    assert.equal(queries.length, 1);
});

test('incompatible tenants fail promptly and retry readiness on the next request without migration writes', async () => {
    compatible = false;
    await assert.rejects(ensureTenantSchema(tenantId), (error: any) => error.statusCode === 503);
    compatible = true;
    assert.equal(await ensureTenantSchema(tenantId), schema);
    assert.equal(queries.length, 2);
    assert.ok(queries.every(({sql}) => sql.startsWith('SELECT')));
    assert.equal(migrationRuns, 0);
});

test('managed provisioning runs explicit migrations despite TENANT_SCHEMA_SYNC=off and keeps every write in caller transaction', async () => {
    env.tenantSchemaSync = 'off';
    assert.equal(await provisionTenantSchema(tenantId, transaction), schema);
    assert.equal(migrationRuns, 1);
    const sql = queries.map(query => query.sql);
    const globalLock = sql.findIndex(query => query.includes('pg_advisory_xact_lock_shared'));
    const releaseCheck = sql.findIndex(query => query.includes('FROM public.schema_control'));
    const tenantLock = sql.findIndex(query => query.includes('pg_advisory_xact_lock(hashtext'));
    const creation = sql.findIndex(query => query.startsWith('CREATE SCHEMA'));
    const version = sql.findIndex(query => query.startsWith('INSERT INTO') && query.includes('schema_migrations'));
    const checkpoint = sql.findIndex(query => query.startsWith('INSERT INTO public.tenant_schema_state'));
    assert.ok(globalLock >= 0 && globalLock < releaseCheck && releaseCheck < tenantLock && tenantLock < creation);
    assert.ok(version > creation && checkpoint > version);
    assert.ok(queries.every(query => query.options?.transaction === transaction));
});

test('provisioning does not publish a process cache entry before the controller commits', async () => {
    await provisionTenantSchema(tenantId, transaction);
    compatible = false; // A rollback leaves no committed central state visible to subsequent requests.
    await assert.rejects(ensureTenantSchema(tenantId), /not ready/);
    markTenantSchemaReady(tenantId);
    const count = queries.length;
    assert.equal(await ensureTenantSchema(tenantId), schema);
    assert.equal(queries.length, count);
});

test('a previous API release cannot start provisioning after database target advances', async () => {
    currentRelease = 'a-newer-database-release';
    await assert.rejects(beginTenantProvisioning(transaction), (error: any) => error.statusCode === 503);
    assert.equal(migrationRuns, 0);
    assert.ok(queries.every(({sql}) => !/^(CREATE|ALTER|INSERT|UPDATE|DELETE)/.test(sql)));
});

test('a still-running bridge instance switches to read-only tenant checks after the managed release completes', async () => {
    env.databaseMigrationPhase = 'bridge';
    const manager = sequelize.connectionManager as any;
    const originalGet = manager.getConnection;
    const originalRelease = manager.releaseConnection;
    const locks: string[] = [];
    manager.getConnection = async () => ({query: async (sql: string) => {locks.push(sql); return {rows: []};}});
    manager.releaseConnection = async () => {};
    const query = sequelize.query;
    sequelize.query = (async (sql: string, options?: any) => {
        if (sql.includes('to_regclass')) {
            queries.push({sql, options});
            return [[{control: 'schema_control', releases: 'schema_releases', tenants: 'tenant_schema_state'}]];
        }
        if (sql.includes('FROM public.schema_control c LEFT JOIN')) {
            queries.push({sql, options});
            return [[{releaseId: databaseManifest.id, checksum: databaseManifest.checksum}]];
        }
        return (query as any)(sql, options);
    }) as any;
    try {
        assert.equal(await ensureTenantSchema(tenantId), schema);
        assert.equal(migrationRuns, 0);
        assert.ok(queries.every(({sql}) => sql.startsWith('SELECT')));
        assert.ok(locks.some(sql => sql.includes('pg_advisory_lock_shared')));
        assert.ok(locks.some(sql => sql.includes('pg_advisory_unlock_shared')));
    } finally {
        manager.getConnection = originalGet;
        manager.releaseConnection = originalRelease;
    }
});
