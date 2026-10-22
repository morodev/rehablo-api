import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {it} from 'node:test';
const require = createRequire(import.meta.url);
const migration = require('../../migrations/20261022-care-package-purchases.js');

it('adds package sale and reservation fields without inventing payments or rewriting legacy purchases', async () => {
    const calls: string[] = [], transaction = {id: 'transaction'};
    await migration.up({sequelize: {query: async (sql: string, options: any) => {
        calls.push(sql); assert.equal(options.transaction, transaction);
    }}}, {schema: 'rehablo_11111111111141118111111111111111', transaction});
    assert.ok(calls.some(sql => sql.includes('package_templates')));
    assert.ok(calls.some(sql => sql.includes('packageReservationStatus')));
    assert.ok(calls.some(sql => sql.includes('invoices_care_package_unique')));
    assert.ok(calls.every(sql => /^(CREATE|ALTER)\s/.test(sql)));
    assert.ok(calls.every(sql => sql.includes('IF NOT EXISTS')));
});

it('rejects a schema name before running any migration query', async () => {
    await assert.rejects(() => migration.up({sequelize: {query: () => assert.fail('Must not query')}}, {schema: 'public'}), /Invalid tenant schema/);
});
