import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Sequelize, Transaction} from 'sequelize';
import {runStructureBackfillTenant} from './structureBackfill.service.js';

test('per-tenant backfill retains ambiguous rows and uses only the supplied connection and transaction', async () => {
    const transaction = {} as Transaction;
    const statements: string[] = [];
    const database = {query: async (sql: string, options: {transaction: Transaction; replacements?: {table?: string}}) => {
        assert.equal(options.transaction, transaction);
        statements.push(sql);
        if (sql.includes('information_schema.schemata')) return [{exists: true}];
        if (sql.includes('information_schema.tables')) return [{exists: options.replacements?.table === 'patients'}];
        if (sql.includes('SELECT id FROM public.structures')) return [{id: 'structure-a'}, {id: 'structure-b'}];
        if (sql.startsWith('UPDATE')) return [undefined, 0];
        if (sql.includes('SELECT COUNT(*)')) return [{count: '7'}];
        throw new Error('Unexpected query: ' + sql);
    }} as unknown as Sequelize;
    const report = await runStructureBackfillTenant({tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', database, transaction});
    assert.deepEqual(report, {tenants: 1, updated: {}, ambiguous: {patients: 7}});
    assert.ok(statements.filter(sql => sql.startsWith('UPDATE')).every(sql => sql.includes('"structureId" IS NULL')));
    assert.equal(statements.some(sql => sql.includes('FROM public.tenants')), false);
});

test('per-tenant backfill rejects unsafe identifiers before accessing the database', async () => {
    const database = {query: () => {throw new Error('must not query');}} as unknown as Sequelize;
    await assert.rejects(runStructureBackfillTenant({tenantId: 'other-schema', database, transaction: {} as Transaction}), /Invalid tenant id/);
});
