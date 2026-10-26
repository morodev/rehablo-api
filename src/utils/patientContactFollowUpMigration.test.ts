import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
const require = createRequire(import.meta.url);
const migration = require('../../migrations/20261026-patient-contact-follow-ups.js');
test('contact follow-up migration is additive, transaction-bound and safe to rerun', async () => {
    const sql: string[] = [], transaction = {};
    const queryInterface = {sequelize: {query: async (query: string, options: any) => {assert.equal(options.transaction, transaction); sql.push(query);}}};
    await migration.up(queryInterface, {schema: 'rehablo_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', transaction});
    assert.equal(sql.length, 3); assert.ok(sql.every(query => query.includes('IF NOT EXISTS')));
    assert.ok(sql.every(query => !/\b(UPDATE|DELETE|INSERT|DROP)\b/.test(query)));
    assert.match(sql[1], /createdByUserId.*patientId.*structureId/s);
    assert.match(sql[1], /OPEN.*SNOOZED/);
    await migration.up(queryInterface, {schema: 'rehablo_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', transaction});
    assert.equal(sql.length, 6);
    await assert.rejects(migration.up(queryInterface, {schema: 'bad"schema', transaction}), /Invalid tenant schema/);
});
