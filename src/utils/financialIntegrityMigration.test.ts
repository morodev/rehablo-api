import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
const require = createRequire(import.meta.url);
const safeSeed = require('../../migrations/20261025-seed-administration-safe.js');
const schemaMigration = require('../../migrations/20261025-financial-integrity.js');
const schema = 'rehablo_0123456789abcdef0123456789abcdef';
test('pending initialization seeds configuration without inventing any historic cash', async () => {
    const queries: string[] = [];
    const transaction = {};
    await safeSeed.up({sequelize: {query: async (sql: string, options: any) => {
        assert.equal(options.transaction, transaction);
        queries.push(sql);
        return [[]];
    }}}, {schema, transaction});
    assert.ok(queries.some(sql => sql.includes('payment_methods')));
    assert.ok(queries.some(sql => sql.includes('financial_accounts')));
    assert.ok(queries.some(sql => sql.includes('price_list_versions')));
    assert.ok(queries.every(sql => !sql.includes('treasury_movements') && !sql.includes('invoice_payments')));
});
test('financial operations migration is additive and transaction-bound', async () => {
    const queries: string[] = [];
    const transaction = {};
    await schemaMigration.up({sequelize: {query: async (sql: string, options: any) => {
        assert.equal(options.transaction, transaction); queries.push(sql);
    }}}, {schema, transaction});
    assert.equal(queries.length, 2);
    assert.ok(queries[0].includes('CREATE TABLE IF NOT EXISTS'));
    assert.ok(queries[1].includes('CREATE UNIQUE INDEX IF NOT EXISTS'));
    assert.ok(queries.every(sql => !/\b(UPDATE|DELETE|INSERT)\b/.test(sql)));
    await assert.rejects(schemaMigration.up({sequelize: {}}, {schema: 'bad"schema'}), /Invalid tenant schema/);
});
