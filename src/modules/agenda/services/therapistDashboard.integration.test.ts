import assert from 'node:assert/strict';
import {it} from 'node:test';

const databaseUrl = process.env.PERFORMANCE_TEST_DATABASE_URL;
it('reads compact therapist history from PostgreSQL with legacy JSON, recurrence and operator isolation', {skip: !databaseUrl}, async () => {
    const target = new URL(databaseUrl!);
    assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname));
    assert.equal(target.port, '5548');
    assert.equal(target.pathname, '/rehablo_performance_financial_test');
    process.env.DATABASE_URL = databaseUrl;
    process.env.DB_SSL = 'false';
    const {sequelize} = await import('../../../config/database.js');
    const {loadLastTherapistSessions, therapistDashboardBounds} = await import('./therapistDashboard.service.js');
    const schema = 'performance_dashboard_' + process.pid;
    const patient = '11111111-1111-4111-8111-111111111111';
    const secondPatient = '22222222-2222-4222-8222-222222222222';
    const operator = '33333333-3333-4333-8333-333333333333';
    const structure = '44444444-4444-4444-8444-444444444444';
    try {
        await sequelize.query(`CREATE SCHEMA "${schema}"`);
        await sequelize.query(`CREATE TABLE "${schema}".patients (id uuid PRIMARY KEY)`);
        await sequelize.query(`CREATE TABLE "${schema}".agenda_events (id uuid PRIMARY KEY, "patientId" uuid, patient json, start varchar, "end" varchar, title varchar, recurrence varchar, "calendarId" uuid, "structureId" uuid)`);
        await sequelize.query(`INSERT INTO "${schema}".patients VALUES ($1), ($2)`, {bind: [patient, secondPatient]});
        const rows = [
            {patientId: patient, patient: {id: patient}, start: '2026-11-08T10:00:00.000Z', title: 'Terapia'},
            {patientId: null, patient: {id: patient}, start: '2026-11-09T10:00:00.000Z', title: 'Terapia'},
            {patientId: patient, patient: {id: patient}, start: '2026-11-09T12:00:00.000Z', title: 'Ferie'},
            {patientId: patient, patient: {id: patient}, start: '2026-11-09T14:00:00.000Z', title: 'Terapia', calendarId: patient},
            {patientId: secondPatient, patient: null, start: '2025-01-01T10:00:00.000Z', title: 'Terapia', end: '2027-01-01T10:00:00.000Z', recurrence: 'FREQ=WEEKLY'},
            {patientId: null, patient: {id: 'legacy-placeholder'}, start: '2026-11-07T10:00:00.000Z', title: 'Terapia'}
        ];
        for (let index = 0; index < rows.length; index++) {
            const row: any = rows[index];
            await sequelize.query(`INSERT INTO "${schema}".agenda_events VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, {
                bind: ['55555555-5555-4555-8555-' + String(index).padStart(12, '0'), row.patientId, JSON.stringify(row.patient), row.start,
                    row.end ?? row.start, row.title, row.recurrence ?? null, row.calendarId ?? operator, structure]
            });
        }
        const result = await loadLastTherapistSessions(schema, [{patient: {id: patient}}, {patient: {id: secondPatient}}, {patient: {id: 'legacy-placeholder'}}],
            {calendarId: operator, structureId: structure}, therapistDashboardBounds('2026-11-10')!);
        assert.deepEqual(result, {[patient]: '2026-11-09T10:00:00.000Z', [secondPatient]: '2025-01-01T10:00:00.000Z', 'legacy-placeholder': '2026-11-07T10:00:00.000Z'});
    } finally {
        await sequelize.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await sequelize.close();
    }
});
