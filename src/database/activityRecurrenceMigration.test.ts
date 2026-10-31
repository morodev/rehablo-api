import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
import type {Sequelize, Transaction} from 'sequelize';
import {migrateActivityRecurrences, provisionTenantSchema, reconcileTenantSchemas, requiredMigrationNames} from './standardMigrations.js';

const release = '202610310002-activity-recurrences.js';
const schema = 'rehablo_11111111111141118111111111111111';
function fixture(fail = false) {
    const names = new Set<string>(requiredMigrationNames.filter(name => name !== release));
    const transaction = {} as Transaction;
    const calls: string[] = [];
    const database = {
        getQueryInterface: () => ({sequelize: database}),
        transaction: async (work: (tx: Transaction) => Promise<unknown>) => work(transaction),
        query: async (sql: string, options?: any) => {
            calls.push(sql);
            if (sql === 'SELECT id FROM public.tenants ORDER BY id') return [[{id: '11111111-1111-4111-8111-111111111111'}]];
            if (sql.includes('SELECT t.id, c.oid IS NOT NULL')) return [[{id: '11111111-1111-4111-8111-111111111111', hasMetadata: true}]];
            if (sql.includes('to_regclass')) return [[{registry: `${schema}.SequelizeMeta`}]];
            if (sql.startsWith('SELECT name FROM public.')) return [requiredMigrationNames.map(name => ({name}))];
            if (sql.startsWith('SELECT name FROM')) return [[...names].map(name => ({name}))];
            if (!sql.startsWith('SELECT')) assert.equal(options?.transaction, transaction);
            if (fail && sql.includes('CREATE TABLE IF NOT EXISTS') && sql.includes('activity_executions')) throw new Error('execution table unavailable');
            if (sql.startsWith('INSERT INTO') && options?.replacements?.name) names.add(options.replacements.name);
            return [[]];
        },
    } as unknown as Sequelize;
    return {database, transaction, names, calls};
}

test('recurrence release creates execution storage without converting existing activities', async () => {
    const f = fixture();
    await migrateActivityRecurrences(f.database);
    assert.ok(f.names.has(release));
    assert.ok(f.calls.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS') && sql.includes('activity_executions')));
    assert.ok(f.calls.some(sql => sql.includes('activity_executions_activity_date_unique')));
    assert.ok(f.calls.every(sql => !/^(UPDATE|DELETE)\b/.test(sql)));
    assert.ok(f.calls.every(sql => !sql.includes('schema_migrations')));
    f.calls.length = 0;
    await migrateActivityRecurrences(f.database);
    assert.ok(f.calls.every(sql => !sql.includes('activity_executions') && !sql.startsWith('ALTER TABLE')));
});

test('failed recurrence schema work does not record successful release', async () => {
    const f = fixture(true);
    await assert.rejects(migrateActivityRecurrences(f.database), /execution table unavailable/);
    assert.equal(f.names.has(release), false);
});

test('provisioning and old-version tenant reconciliation include the recurrence release', async () => {
    const f = fixture();
    await provisionTenantSchema(f.database, schema, f.transaction);
    assert.ok(f.names.has(release));
    const oldTenant = fixture();
    assert.equal(await reconcileTenantSchemas(oldTenant.database), 1);
    assert.ok(oldTenant.names.has(release));
    assert.equal(await reconcileTenantSchemas(oldTenant.database), 0);
});

test('recurrence migration rejects non-tenant schemas before executing SQL', async () => {
    const migration = createRequire(import.meta.url)('../../migrations/20261031-activity-recurrences.js');
    await assert.rejects(migration.up({sequelize: {query: () => assert.fail('No SQL expected')}}, {schema: 'public'}), /Invalid tenant schema/);
});
