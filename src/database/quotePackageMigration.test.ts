import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
import type {Sequelize, Transaction} from 'sequelize';
import {migrateQuotePackageInvoiceLines, provisionTenantSchema, reconcileTenantSchemas, requiredMigrationNames} from './standardMigrations.js';

const schema = 'rehablo_11111111111141118111111111111111';
const release = '202610310001-quote-package-invoice-lines.js';

function fixture(fail = false) {
    const names = new Set<string>(requiredMigrationNames.filter(name => name !== release));
    const calls: string[] = [];
    const transaction = {} as Transaction;
    const database = {
        getQueryInterface: () => ({sequelize: database}),
        transaction: async (work: (tx: Transaction) => Promise<unknown>) => work(transaction),
        query: async (sql: string, options?: any) => {
            calls.push(sql);
            if (sql === 'SELECT id FROM public.tenants ORDER BY id') return [[{id: '11111111-1111-4111-8111-111111111111'}]];
            if (sql.includes('SELECT t.id, c.oid IS NOT NULL')) return [[{id: '11111111-1111-4111-8111-111111111111', hasMetadata: true}]];
            if (!sql.startsWith('SELECT')) assert.equal(options?.transaction, transaction);
            if (sql.includes('to_regclass')) return [[{registry: `${schema}.SequelizeMeta`}]];
            if (sql.startsWith('SELECT name FROM public.')) return [requiredMigrationNames.map(name => ({name}))];
            if (sql.startsWith('SELECT name FROM')) return [[...names].map(name => ({name}))];
            if (sql.startsWith('ALTER TABLE') && fail) throw new Error('locked line table');
            if (sql.startsWith('INSERT INTO') && options?.replacements?.name) names.add(options.replacements.name);
            return [[]];
        },
    } as unknown as Sequelize;
    return {database, names, calls, transaction};
}

test('registers the quote-package release without replaying history or rewriting money', async () => {
    const f = fixture();
    assert.ok((requiredMigrationNames as readonly string[]).includes(release));
    await migrateQuotePackageInvoiceLines(f.database);
    assert.ok(f.names.has(release));
    const changes = f.calls.filter(sql => sql.startsWith('ALTER TABLE'));
    assert.equal(changes.length, 2);
    assert.ok(changes.every(sql => sql.includes(`"${schema}"`) && sql.endsWith('DROP NOT NULL')));
    assert.ok(f.calls.every(sql => !/^(UPDATE|DELETE)\b/.test(sql)));
    assert.ok(f.calls.every(sql => !sql.includes('schema_migrations')));
    f.calls.length = 0;
    await migrateQuotePackageInvoiceLines(f.database);
    assert.ok(f.calls.every(sql => !sql.startsWith('ALTER TABLE')));
});

test('does not record a completed release if its table change fails', async () => {
    const f = fixture(true);
    await assert.rejects(migrateQuotePackageInvoiceLines(f.database), /locked line table/);
    assert.equal(f.names.has(release), false);
});

test('tenant provisioning applies the same new invoice-line release on its own transaction', async () => {
    const f = fixture();
    await provisionTenantSchema(f.database, schema, f.transaction);
    assert.ok(f.names.has(release));
    assert.equal(f.calls.filter(sql => sql.startsWith('ALTER TABLE')).length, 2);
});

test('upgrades a tenant registered by the preceding API after release discovery', async () => {
    const f = fixture();
    f.names.delete('202610310002-activity-recurrences.js');
    assert.equal(await reconcileTenantSchemas(f.database), 1);
    assert.ok(f.names.has(release));
    assert.equal(await reconcileTenantSchemas(f.database), 0);
});

test('does not replay missing historical tenant metadata while reconciling the new release', async () => {
    const f = fixture(); f.names.delete(requiredMigrationNames[0]);
    assert.equal(await reconcileTenantSchemas(f.database), 0);
    assert.ok(f.calls.every(sql => !sql.startsWith('ALTER TABLE')));
});

test('rejects an invalid tenant schema before changing invoice lines', async () => {
    const migration = createRequire(import.meta.url)('../../migrations/20261031-quote-package-invoice-lines.js');
    await assert.rejects(migration.up({sequelize: {query: () => assert.fail('No query expected')}}, {schema: 'public'}), /Invalid tenant schema/);
});
