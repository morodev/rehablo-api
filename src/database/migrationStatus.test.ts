import assert from 'node:assert/strict';
import test from 'node:test';
import type {Sequelize, Transaction} from 'sequelize';
import {assertDatabaseReady, assertProvisioningReady, assertTenantReady, getDatabaseStatus, requiredMigrationNames} from './migrationStatus.js';

function databaseWith(names: string[] | null) {
    const calls: Array<{sql: string; transaction?: Transaction}> = [];
    const database = {query: async (sql: string, options?: {transaction?: Transaction}) => {
        calls.push({sql, transaction: options?.transaction});
        assert.ok(/^SELECT\b/.test(sql), 'Readiness must never change the database');
        if (sql.includes('to_regclass')) return [[{registry: names === null ? null : 'SequelizeMeta'}]];
        return [(names ?? []).map(name => ({name}))];
    }} as unknown as Sequelize;
    return {database, calls};
}

test('an unmigrated database reports pending filenames without initializing metadata', async () => {
    const {database, calls} = databaseWith(null);
    assert.deepEqual(await getDatabaseStatus(database), {ready: false, applied: [], pending: [...requiredMigrationNames]});
    assert.equal(calls.length, 1);
    await assert.rejects(assertDatabaseReady(database), /Run npm run db:migrate/);
});

test('startup requires both standard CLI migration records and tolerates later additive migrations', async () => {
    await assert.rejects(assertDatabaseReady(databaseWith([requiredMigrationNames[0]]).database), /appointment-reminders/);
    const {database} = databaseWith([...requiredMigrationNames, '202611010001-later-migration.js']);
    await assertDatabaseReady(database);
    assert.equal((await getDatabaseStatus(database)).ready, true);
});

test('older applications cannot provision tenants after a newer migration has completed', async () => {
    const transaction = {} as Transaction;
    const {database, calls} = databaseWith([...requiredMigrationNames]);
    await assertProvisioningReady(database, transaction);
    assert.ok(calls.every(call => call.transaction === transaction));
    await assert.rejects(assertProvisioningReady(databaseWith([...requiredMigrationNames, '202611010001-later-migration.js']).database,
        transaction), /matching the applied database migrations/);
    await assert.rejects(assertProvisioningReady(databaseWith([requiredMigrationNames[0]]).database, transaction), /matching/);
});

test('tenant readiness validates the schema and checks only its standard migration records', async () => {
    const {database, calls} = databaseWith([...requiredMigrationNames]);
    await assert.rejects(assertTenantReady('public;DROP SCHEMA public', database), /Invalid tenant schema/);
    assert.equal(calls.length, 0);
    const schema = 'rehablo_' + 'a'.repeat(32);
    await assertTenantReady(schema, database);
    assert.ok(calls[1].sql.includes(`"${schema}"."SequelizeMeta"`));
    await assert.rejects(assertTenantReady(schema, databaseWith([requiredMigrationNames[0]]).database), /pending migrations/);
});
