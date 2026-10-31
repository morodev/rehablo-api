import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {it} from 'node:test';

const require = createRequire(import.meta.url);
const migration = require('../../../../migrations/20261031-quote-package-invoice-lines.js');
const schema = 'rehablo_' + 'a'.repeat(32);

it('allows description snapshots without rewriting existing invoice values or identities', async () => {
    const calls: Array<{sql: string; options: unknown}> = [];
    const transaction = {};
    const queryInterface = {sequelize: {query: async (sql: string, options: unknown) => {calls.push({sql, options}); return [[], {}];}}};
    await migration.up(queryInterface, {schema, transaction});
    assert.deepEqual(calls.map(call => call.sql), [
        `ALTER TABLE IF EXISTS "${schema}"."invoice_services" ALTER COLUMN "ServiceId" DROP NOT NULL`,
        `ALTER TABLE IF EXISTS "${schema}"."invoice_products" ALTER COLUMN "ProductId" DROP NOT NULL`,
    ]);
    calls.forEach(call => assert.deepEqual(call.options, {transaction}));
    await migration.up(queryInterface, {schema, transaction});
    assert.equal(calls.length, 4);
    assert.ok(calls.every(call => !/UPDATE|DELETE|INSERT/.test(call.sql)));
});

it('refuses an invalid tenant and a rollback which could remove quote invoice history', async () => {
    const queryInterface = {sequelize: {query: async () => {throw Error('No SQL expected');}}};
    await assert.rejects(migration.up(queryInterface, {schema: 'public'}), /Invalid tenant schema/);
    await assert.rejects(migration.down(), /snapshots must be retained/);
});
