import assert from 'node:assert/strict';
import {it} from 'node:test';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const migration = require('../../../../migrations/20261028-appointment-reminders.js');

it('the reminder migration is tenant scoped, additive and uses the release transaction', async () => {
    const statements: string[] = [];
    const transaction = {};
    const queryInterface = {sequelize: {query: async (sql: string, options: any) => {
        assert.equal(options.transaction, transaction); statements.push(sql);
    }}};
    const schema = 'rehablo_' + 'a'.repeat(32);
    await migration.up(queryInterface, {schema, transaction});
    assert.equal(statements.length, 3);
    assert.ok(statements.every(sql => sql.includes(`"${schema}"."appointment_reminder_deliveries"`)));
    assert.ok(statements.every(sql => !/DROP|DELETE|ALTER TABLE.*agenda_events/i.test(sql)));
    assert.match(statements[0], /BIGSERIAL/);
    assert.match(statements[2], /UNIQUE INDEX IF NOT EXISTS/);
    await assert.rejects(migration.up(queryInterface, {schema: 'public";DROP SCHEMA public;--', transaction}), /Invalid tenant schema/);
    assert.equal(statements.length, 3);
});
