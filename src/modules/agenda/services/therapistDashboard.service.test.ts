import assert from 'node:assert/strict';
import {it} from 'node:test';
import {Op} from 'sequelize';
import AgendaEvent from '../models/agendaEvent.model.js';
import Patient from '../../patients/models/patient.model.js';
import {lastTherapistSessions, loadLastTherapistSessions, therapistDashboardBounds} from './therapistDashboard.service.js';

const patient = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const record = (row: any): any => ({get: (key: any) => typeof key === 'string' ? row[key] : {...row}});

it('uses Rome day boundaries across daylight saving and a 180 civil-day lookback', () => {
    assert.deepEqual(therapistDashboardBounds('2026-03-29'), {
        start: '2026-03-28T23:00:00.000Z', end: '2026-03-29T21:59:59.999Z', historyStart: '2025-09-29T22:00:00.000Z'
    });
    assert.equal(therapistDashboardBounds('2026-02-30'), null);
    assert.equal(therapistDashboardBounds(' 2026-03-29'), null);
    assert.equal(therapistDashboardBounds(''), null);
});

it('preserves cancelled/no-show history, legacy patient snapshots and time-off exclusions', () => {
    const rows = [
        {patientId: patient, snapshotPatientId: other, start: '2026-11-08T10:00:00Z', status: 'CANCELLED', title: 'Terapia'},
        {patientId: null, snapshotPatientId: patient, start: '2026-11-09T10:00:00Z', status: 'NO_SHOW', title: 'Terapia'},
        {patientId: patient, start: '2026-11-09T13:00:00Z', title: 'Ferie'},
        {patientId: patient, start: '2026-11-10T10:00:00Z', title: 'Terapia'},
        {patientId: other, snapshotPatientId: 'removed-legacy', start: '2026-10-01T10:00:00Z', title: 'Terapia'},
        {patientId: patient, start: 'bad-date', title: 'Terapia'}
    ];
    assert.deepEqual(lastTherapistSessions(rows, new Set([patient, 'removed-legacy']), new Set([patient]), '2026-11-09T23:00:00Z'), {
        [patient]: '2026-11-09T10:00:00.000Z', 'removed-legacy': '2026-10-01T10:00:00.000Z'
    });
});

it('reads only historical identity/date fields, preserves the authorized scope and skips empty patient sets', async t => {
    const calls: any[] = [];
    t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async (options: any) => {
        calls.push(options);
        return [record({id: 'old-series', patientId: patient, snapshotPatientId: patient, start: '2025-01-01T10:00:00Z', title: 'Terapia'})];
    }})) as any);
    t.mock.method(Patient, 'schema', (() => ({findAll: async () => [record({id: patient})]})) as any);
    const bounds = therapistDashboardBounds('2026-11-10')!;
    const scope = {calendarId: other, structureId: patient};
    assert.deepEqual(await loadLastTherapistSessions('rehablo_test', [], scope, bounds), {});
    assert.equal(calls.length, 0);
    assert.deepEqual(await loadLastTherapistSessions('rehablo_test', [{patient: {id: patient}}], scope, bounds), {[patient]: '2025-01-01T10:00:00.000Z'});
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].where[Op.and][0], scope);
    assert.deepEqual(calls[0].attributes.slice(0, 4), ['id', 'start', 'title', 'patientId']);
    const range = calls[0].where[Op.and][3][Op.or];
    assert.equal(range[1].end[Op.gte], bounds.historyStart);
    assert.equal(range[1].recurrence[Op.not], null);
});
