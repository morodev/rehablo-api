import assert from 'node:assert/strict';
import {it} from 'node:test';
import {createRequire} from 'node:module';
import {parseSocialSecurityMigrationArguments} from '../scripts/migrateSocialSecurityPricing.js';
const require = createRequire(import.meta.url);
const migration = require('../../migrations/20261023-social-security-pricing.js');
it('requires an explicit apply flag and otherwise only checks schema readiness', () => {
    assert.equal(parseSocialSecurityMigrationArguments([]).apply, false);
    assert.equal(parseSocialSecurityMigrationArguments(['--check']).apply, false);
    assert.equal(parseSocialSecurityMigrationArguments(['--apply']).apply, true);
    assert.throws(() => parseSocialSecurityMigrationArguments(['--apply', '--check']));
    assert.throws(() => parseSocialSecurityMigrationArguments(['--unknown']));
});
it('adds nullable snapshots without rewriting any historical financial records', async () => {
    const sql: string[] = [];
    const schema = 'rehablo_' + 'a'.repeat(32);
    const qi = {sequelize: {query: async (query: string) => {sql.push(query); return [[{schema_name: schema}]];}}};
    await migration.up(qi);
    const first = [...sql];
    await migration.up(qi);
    assert.deepEqual(sql.slice(first.length), first);
    assert.equal(sql.some(query => /\b(UPDATE|DELETE|DROP)\b/i.test(query)), false);
    assert.equal(sql.filter(query => query.startsWith('ALTER TABLE')).length, 12);
    assert.ok(sql.every(query => query.startsWith('SELECT') || query.includes('ADD COLUMN IF NOT EXISTS')));
    await assert.rejects(() => migration.up(qi, {schema: 'public; DROP TABLE invoices'}), /Invalid tenant schema/);
});
