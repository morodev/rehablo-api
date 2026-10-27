import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Sequelize, Transaction} from 'sequelize';
import {publicMigrationSteps} from './publicMigrations.js';

test('adopts completed legacy public upgrades without repeating their data changes', async () => {
    for (const name of ['public-auth-security', 'public-secretary-roles', 'public-structure-calendars', 'public-activity-notifications']) {
        const transaction = {} as Transaction;
        const calls: string[] = [];
        const database = {query: async (sql: string, options: {transaction: Transaction}) => {
            assert.equal(options.transaction, transaction);
            calls.push(sql);
            return [sql.includes('to_regclass') ? [{registry: 'legacy_registry'}] : [{version: 'already-applied'}], {}];
        }} as unknown as Sequelize;
        const step = publicMigrationSteps().find(candidate => candidate.name.includes(name));
        assert.ok(step);
        await step.up(database, 'public', transaction);
        assert.equal(calls.length, 2);
        assert.ok(calls.every(sql => /^SELECT\b/.test(sql)));
    }
});

test('legacy availability repair shares the migration transaction and disables unrecoverable enabled ranges', async () => {
    const transaction = {} as Transaction;
    const statements: string[] = [];
    const database = {query: async (sql: string, options: {transaction: Transaction}) => {
        assert.equal(options.transaction, transaction);
        statements.push(sql);
        return [sql.startsWith('SELECT') ? [{column_name: 'rangeOneStart'}] : [], {}];
    }} as unknown as Sequelize;
    await publicMigrationSteps().find(step => step.name.includes('availability-repair'))!.up(database, 'public', transaction);
    assert.equal(statements.filter(sql => sql.startsWith('ALTER TABLE')).length, 7);
    assert.ok(statements.some(sql => sql.startsWith('UPDATE') && sql.includes('enabled=false') && sql.includes('WHERE enabled=true')));
});

test('availability repair preserves enabled schedules when the original finish time exists', async () => {
    const statements: string[] = [];
    const database = {query: async (sql: string) => {
        statements.push(sql);
        return [sql.startsWith('SELECT') ? [{column_name: 'rangeOneStart'}, {column_name: 'rangeOneFinish'}] : [], {}];
    }} as unknown as Sequelize;
    await publicMigrationSteps().find(step => step.name.includes('availability-repair'))!.up(database, 'public', {} as Transaction);
    assert.equal(statements.some(sql => sql.startsWith('UPDATE')), false);
});
