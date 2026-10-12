import assert from 'node:assert/strict';
import {it} from 'node:test';
import {inspectPatientSettlements, parsePatientSettlementMigrationArguments} from './migratePatientSettlements.js';

it('migration defaults to check and rejects contradictory flags or an unsafe schema', () => {
    assert.equal(parsePatientSettlementMigrationArguments([]).apply, false);
    assert.equal(parsePatientSettlementMigrationArguments(['--apply']).apply, true);
    assert.throws(() => parsePatientSettlementMigrationArguments(['--check', '--apply']));
    assert.throws(() => parsePatientSettlementMigrationArguments(['--schema', 'public']));
    assert.throws(() => parsePatientSettlementMigrationArguments(['--schema', 'rehablo_x;DROP TABLE users']));
});
it('readiness inspects only metadata and reports a missing table without running mutations', async () => {
    const queries: string[] = [];
    const result = await inspectPatientSettlements({query: async sql => {queries.push(sql); return [[]];}}, 'rehablo_aaaaaaaaaaaa4aaa8aaa000000000001');
    assert.equal(result.ready, false); assert.equal(result.missingColumns.length, 8);
    assert.ok(queries.every(sql => sql.trim().startsWith('SELECT')));
});
it('readiness requires the actual unique key and the registered migration version', async () => {
    const connection = {query: async (sql: string) => sql.includes('information_schema.columns')
        ? [[...['id', 'patientId', 'structureId', 'idempotencyKey', 'requestHash', 'result', 'createdByUserId', 'createdAt'].map(column_name => ({column_name}))]]
        : sql.includes('pg_index') ? [[{is_unique: true, columns: ['idempotencyKey']}]]
        : sql.includes('to_regclass') ? [[{registry: 'schema_migrations'}]] : [[{exists: 1}]]};
    assert.equal((await inspectPatientSettlements(connection, 'rehablo_aaaaaaaaaaaa4aaa8aaa000000000001')).ready, true);
});
