import assert from 'node:assert/strict';
import { it, TestContext } from 'node:test';
import { sequelize } from '../../../config/database.js';
import { StructureUser, TenantUser, User } from '../../auth/models/index.js';
import AgendaEvent from '../models/agendaEvent.model.js';
import AgendaEventException from '../models/agendaEventException.model.js';
import Patient from '../../patients/models/patient.model.js';
import TimeOffRequest from '../models/timeOffRequest.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import { reportMissedArrival, saveAgendaEvent, updateAgendaEvent, updateRecurringEvent } from './agenda.controller.js';

const id = (value: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(value).padStart(12, '0');
const tenantId = id(1), structureId = id(2), otherStructure = id(3), operatorId = id(4), patientId = id(5), eventId = id(6);
function run(handler: typeof saveAgendaEvent, req: any): Promise<{status: number; body: any}> {
    return new Promise(resolve => {
        const res: any = {statusCode: 200,
            status(code: number) {this.statusCode = code; return this;},
            json(body: any) {resolve({status: this.statusCode, body}); return this;}
        };
        handler(req, res, (error?: any) => resolve({status: error?.statusCode ?? 500, body: {message: error?.message}}));
    });
}
function fixture(t: TestContext) {
    const assignments: any[] = [{userId: operatorId, structureId, calendarEnabled: false},
        {userId: operatorId, structureId: otherStructure, calendarEnabled: true}];
    const current: any = {id: eventId, calendarId: operatorId, structureId,
        start: '2025-01-02T09:00:00.000Z', end: '2025-01-02T09:30:00.000Z', title: 'Seduta',
        status: 'CONFIRMED', recurrence: null, duration: null, patient: {id: patientId}, patientId};
    const created: any[] = [], updated: any[] = [], exceptionRows: any[] = [], trace: any[] = [];
    const transactionContext: any = {LOCK: {UPDATE: 'UPDATE'}};
    const record = (row: any): any => Object.assign({}, row, {
        get: (key: any) => typeof key === 'string' ? row[key] : {...row},
        async update(values: any, options: any) {trace.push({kind: 'event-save', ...options});
            Object.assign(row, values); updated.push({...values}); return record(row);}
    });
    t.mock.method(StructureUser, 'findOne', (async (options: any) => {
        trace.push({kind: 'membership-lock', ...options});
        return assignments.find(row => row.userId === options.where.userId && row.structureId === options.where.structureId) ?? null;
    }) as any);
    t.mock.method(TenantUser, 'findOne', (async () => ({tenantId, userId: operatorId, deactivatedAt: null})) as any);
    t.mock.method(User, 'findByPk', (async () => ({id: operatorId, deactivatedAt: null, isActive: true})) as any);
    t.mock.method(AgendaEvent, 'schema', (() => ({
        findOne: async (options: any) => {trace.push({kind: options.lock ? 'event-lock' : 'event-preview', ...options}); return record(current);},
        findByPk: async () => record(current),
        create: async (values: any, options: any) => {trace.push({kind: 'event-create', ...options}); created.push(values); return record({...values, id: id(10)});},
        update: async (values: any, options: any) => {trace.push({kind: 'event-save', ...options}); updated.push(values); Object.assign(current, values);}
    })) as any);
    t.mock.method(AgendaEventException, 'schema', (() => ({findAll: async () => exceptionRows.map(record),
        create: async (values: any) => exceptionRows.push(values)})) as any);
    t.mock.method(Patient, 'schema', (() => ({findOne: async () => record({id: patientId, structureId,
        name: 'Anna', surname: 'Test', emails: [], phoneNumbers: [], fiscalCode: null}),
        findByPk: async () => record({emailNotificationsConsent: false})
    })) as any);
    t.mock.method(TimeOffRequest, 'schema', (() => ({findOne: async () => null})) as any);
    t.mock.method(InvoiceAgendaEvent, 'schema', (() => ({findOne: async () => null})) as any);
    t.mock.method(InvoicePayment, 'schema', (() => ({count: async () => 0, sum: async () => 0})) as any);
    t.mock.method(sequelize, 'query', (async (sql: string, options: any) => {
        assert.match(sql, /pg_advisory_xact_lock/);
        trace.push({kind: 'patient-lock', ...options}); return [[], {}];
    }) as any);
    t.mock.method(sequelize, 'transaction', (async (callback: any) => {
        trace.push({kind: 'begin'}); const result = await callback(transactionContext); trace.push({kind: 'commit'}); return result;
    }) as any);
    const req: any = {tenantSchema: 'rehablo_test', user: {tid: tenantId},
        access: {scope: 'structure', structureId, userId: id(7)}, body: {}, params: {}, query: {}};
    const newEvent = {calendarId: operatorId, start: '2035-01-02T09:00:00.000Z', end: '2035-01-02T09:30:00.000Z',
        title: 'Seduta', status: 'CONFIRMED', patient: {id: patientId}};
    return {req, assignments, current, newEvent, created, updated, exceptionRows, trace, transactionContext};
}

it('create refuses an active account whose calendar is disabled in the current premise', async t => {
    const f = fixture(t); f.req.body = {agendaEvent: f.newEvent};
    const result = await run(saveAgendaEvent, f.req);
    assert.equal(result.status, 409); assert.match(result.body.message, /agenda.*disabilitata/);
    assert.equal(f.created.length, 0);
});
it('create uses the current premise calendar enablement independently of another premise', async t => {
    const f = fixture(t); f.req.access.structureId = otherStructure;
    f.req.body = {agendaEvent: {...f.newEvent, structureId}};
    const result = await run(saveAgendaEvent, f.req);
    assert.equal(result.status, 201); assert.equal(f.created[0].structureId, otherStructure);
    assert.equal(f.assignments[0].calendarEnabled, false);
});
it('own-only create cannot bypass a disabled personal calendar by submitting another operator', async t => {
    const f = fixture(t); f.req.access.scope = 'own'; f.req.access.userId = operatorId;
    f.req.body = {agendaEvent: {...f.newEvent, calendarId: id(99)}};
    assert.equal((await run(saveAgendaEvent, f.req)).status, 409);
    assert.equal(f.created.length, 0);
});
it('rescheduling a pre-existing appointment into a disabled calendar is refused without changing the event', async t => {
    const f = fixture(t); f.req.body = {id: eventId, event: {start: '2035-01-02T10:00:00.000Z', end: '2035-01-02T10:30:00.000Z'}};
    assert.equal((await run(updateAgendaEvent, f.req)).status, 409);
    assert.equal(f.current.start, '2025-01-02T09:00:00.000Z'); assert.equal(f.updated.length, 0);
});
it('administrative changes on an existing historical appointment remain possible after disabling its calendar', async t => {
    const f = fixture(t); f.req.body = {id: eventId, event: {description: 'Nota aggiornata', status: 'CANCELLED',
        calendarId: operatorId, structureId, start: f.current.start, end: f.current.end}};
    const result = await run(updateAgendaEvent, f.req);
    assert.equal(result.status, 200); assert.equal(f.current.description, 'Nota aggiornata');
    assert.equal(f.current.status, 'CANCELLED'); assert.equal(f.current.calendarId, operatorId);
});
it('a patient appointment cannot bypass calendar enablement by using an absence title', async t => {
    const f = fixture(t); f.req.body = {agendaEvent: {...f.newEvent, title: 'Ferie'}};
    assert.equal((await run(saveAgendaEvent, f.req)).status, 409); assert.equal(f.created.length, 0);
});
it('legacy staff time off remains creatable with a disabled appointment calendar', async t => {
    const f = fixture(t); f.req.body = {agendaEvent: {...f.newEvent, title: 'Ferie', patient: null}};
    assert.equal((await run(saveAgendaEvent, f.req)).status, 201); assert.equal(f.created.length, 1);
});
for (const mode of ['single', 'future', 'all']) {
    it('recurring ' + mode + ' schedule update requires an enabled calendar in the event premise', async t => {
        const f = fixture(t); Object.assign(f.current, {start: '2035-01-01T09:00:00.000Z',
            end: '2035-02-01T09:00:00.000Z', recurrence: 'FREQ=WEEKLY;BYDAY=MO', duration: 30});
        f.req.body = {mode, event: {...f.current, recurringEventId: eventId,
            start: '2035-01-08T10:00:00.000Z'}, originalEvent: {...f.current, recurringEventId: eventId}};
        const result = await run(updateRecurringEvent, f.req);
        assert.equal(result.status, 409); assert.match(result.body.message, /agenda.*disabilitata/);
        assert.equal(f.updated.length, 0); assert.equal(f.created.length, 0); assert.equal(f.exceptionRows.length, 0);
    });
}
function historicalSeriesFixture(t: TestContext) {
    const f = fixture(t);
    Object.assign(f.current, {start: '2025-01-06T09:00:00.000Z', end: '2025-02-24T09:00:00.000Z',
        recurrence: 'FREQ=WEEKLY;BYDAY=MO', duration: 30, allDay: false});
    const occurrence = {...f.current, recurringEventId: eventId, start: '2025-01-13T09:00:00.000Z',
        end: '2025-01-13T09:30:00.000Z'};
    return {...f, occurrence};
}
it('all-series metadata editing on a disabled calendar retains the authoritative series boundaries', async t => {
    const f = historicalSeriesFixture(t); f.req.body = {mode: 'all', originalEvent: f.occurrence,
        event: {...f.occurrence, description: 'Nota sulla serie'}};
    const result = await run(updateRecurringEvent, f.req);
    assert.equal(result.status, 201); assert.equal(f.current.description, 'Nota sulla serie');
    assert.equal(f.current.start, '2025-01-06T09:00:00.000Z');
    assert.equal(f.current.end, '2025-02-24T09:00:00.000Z');
    assert.equal(f.current.calendarId, operatorId); assert.equal(f.current.duration, 30);
});
it('single historical occurrence metadata editing remains possible with a disabled calendar', async t => {
    const f = historicalSeriesFixture(t); f.req.body = {mode: 'single', originalEvent: f.occurrence,
        event: {...f.occurrence, description: 'Nota storica', status: 'CANCELLED'}};
    const result = await run(updateRecurringEvent, f.req);
    assert.equal(result.status, 201); assert.equal(f.created.length, 1);
    assert.equal(f.created[0].start, '2025-01-13T09:00:00.000Z');
    assert.equal(f.created[0].end, '2025-01-13T09:30:00.000Z');
    assert.equal(f.created[0].calendarId, operatorId); assert.equal(f.created[0].description, 'Nota storica');
    assert.equal(f.created[0].recurrence, null); assert.equal(f.created[0].status, 'CANCELLED');
    assert.equal(f.current.start, '2025-01-06T09:00:00.000Z');
    assert.equal(f.current.end, '2025-02-24T09:00:00.000Z');
    assert.deepEqual(f.exceptionRows[0], {eventId, exdate: '2025-01-13T09:00:00.000Z'});
});
it('future metadata editing on a disabled calendar splits without truncating the future series end', async t => {
    const f = historicalSeriesFixture(t); f.req.body = {mode: 'future', originalEvent: f.occurrence,
        event: {...f.occurrence, description: 'Nota da questa seduta'}};
    const result = await run(updateRecurringEvent, f.req);
    assert.equal(result.status, 201); assert.equal(f.created.length, 1);
    assert.equal(f.created[0].start, '2025-01-13T09:00:00.000Z');
    assert.equal(f.created[0].end, '2025-02-24T09:00:00.000Z');
    assert.equal(f.created[0].calendarId, operatorId); assert.equal(f.created[0].description, 'Nota da questa seduta');
    assert.ok(Date.parse(f.current.end) < Date.parse(f.created[0].start));
});
it('a forged original duration cannot disguise rescheduling as metadata on a disabled calendar', async t => {
    const f = historicalSeriesFixture(t); f.req.body = {mode: 'single',
        originalEvent: {...f.occurrence, duration: 60}, event: {...f.occurrence, duration: 60}};
    const result = await run(updateRecurringEvent, f.req);
    assert.equal(result.status, 409); assert.match(result.body.message, /agenda.*disabilitata/);
    assert.equal(f.created.length, 0); assert.equal(f.exceptionRows.length, 0);
});
it('recurring metadata editing refuses a fabricated occurrence outside the persisted recurrence', async t => {
    const f = historicalSeriesFixture(t), occurrence = {...f.occurrence, start: '2025-01-14T09:00:00.000Z'};
    f.req.body = {mode: 'single', originalEvent: occurrence, event: {...occurrence, description: 'Nota'}};
    const result = await run(updateRecurringEvent, f.req);
    assert.equal(result.status, 409); assert.match(result.body.message, /occorrenza.*disponibile/);
    assert.equal(f.created.length, 0); assert.equal(f.exceptionRows.length, 0);
});
it('recurring metadata editing refuses an occurrence already excluded from its source series', async t => {
    const f = historicalSeriesFixture(t); f.exceptionRows.push({eventId, exdate: f.occurrence.start});
    f.req.body = {mode: 'single', originalEvent: f.occurrence, event: {...f.occurrence, description: 'Nota'}};
    const result = await run(updateRecurringEvent, f.req);
    assert.equal(result.status, 409); assert.equal(f.created.length, 0); assert.equal(f.exceptionRows.length, 1);
});

it('creation guards the membership and saves within one transaction, then responds after commit', async t => {
    const f = fixture(t); f.assignments[0].calendarEnabled = true; f.req.body = {agendaEvent: f.newEvent};
    assert.equal((await run(saveAgendaEvent, f.req)).status, 201);
    const membership = f.trace.find(row => row.kind === 'membership-lock'), saved = f.trace.find(row => row.kind === 'event-create');
    assert.equal(membership.transaction, f.transactionContext); assert.equal(membership.lock, f.transactionContext.LOCK.UPDATE);
    assert.equal(saved.transaction, f.transactionContext);
    assert.ok(f.trace.indexOf(membership) < f.trace.indexOf(saved)); assert.equal(f.trace.at(-1).kind, 'commit');
});
it('a calendar disabled before the transaction obtains its membership lock cannot receive a new event', async t => {
    const f = fixture(t); f.assignments[0].calendarEnabled = true; f.req.body = {agendaEvent: f.newEvent};
    const readAssignment = StructureUser.findOne;
    t.mock.method(StructureUser, 'findOne', (async (options: any) => {
        assert.equal(options.transaction, f.transactionContext); assert.equal(options.lock, f.transactionContext.LOCK.UPDATE);
        f.assignments[0].calendarEnabled = false; return readAssignment.call(StructureUser, options);
    }) as any);
    assert.equal((await run(saveAgendaEvent, f.req)).status, 409); assert.equal(f.created.length, 0);
});
it('rescheduling locks the membership before the appointment and saves in that same transaction', async t => {
    const f = fixture(t); f.assignments[0].calendarEnabled = true;
    f.req.body = {id: eventId, event: {start: '2035-01-02T10:00:00.000Z', end: '2035-01-02T10:30:00.000Z'}};
    assert.equal((await run(updateAgendaEvent, f.req)).status, 200);
    const membership = f.trace.find(row => row.kind === 'membership-lock'), eventLock = f.trace.find(row => row.kind === 'event-lock'),
        saved = f.trace.find(row => row.kind === 'event-save');
    const patientLock = f.trace.find(row => row.kind === 'patient-lock');
    assert.ok(f.trace.indexOf(patientLock) < f.trace.indexOf(membership));
    assert.ok(f.trace.indexOf(membership) < f.trace.indexOf(eventLock));
    for (const operation of [membership, eventLock, saved]) assert.equal(operation.transaction, f.transactionContext);
});
it('a stale administrative payload cannot silently restore an old schedule after a concurrent change', async t => {
    const f = fixture(t); const originalStart = f.current.start, originalEnd = f.current.end;
    const readAssignment = StructureUser.findOne;
    t.mock.method(StructureUser, 'findOne', (async (options: any) => {
        f.current.start = '2025-01-02T10:00:00.000Z'; f.current.end = '2025-01-02T10:30:00.000Z';
        return readAssignment.call(StructureUser, options);
    }) as any);
    f.req.body = {id: eventId, event: {start: originalStart, end: originalEnd, description: 'Nota dal vecchio drawer'}};
    assert.equal((await run(updateAgendaEvent, f.req)).status, 409);
    assert.equal(f.updated.length, 0); assert.equal(f.current.start, '2025-01-02T10:00:00.000Z');
});
it('recurring metadata update follows membership-first lock ordering and writes inside the transaction', async t => {
    const f = historicalSeriesFixture(t); f.req.body = {mode: 'single', originalEvent: f.occurrence,
        event: {...f.occurrence, description: 'Nota'}};
    assert.equal((await run(updateRecurringEvent, f.req)).status, 201);
    const membership = f.trace.find(row => row.kind === 'membership-lock'), eventLock = f.trace.find(row => row.kind === 'event-lock'),
        created = f.trace.find(row => row.kind === 'event-create');
    assert.ok(f.trace.indexOf(membership) < f.trace.indexOf(eventLock));
    for (const operation of [membership, eventLock, created]) assert.equal(operation.transaction, f.transactionContext);
    assert.equal(f.trace.at(-1).kind, 'commit');
});

it('attendance writes share the patient lock and respond only after the transaction commits', async t => {
    const f = fixture(t);
    f.req.params.agendaEventId = eventId;
    const result = await run(reportMissedArrival, f.req);
    assert.equal(result.status, 200);
    assert.ok(f.current.missedArrivalReportedAt);
    const patientLock = f.trace.find(row => row.kind === 'patient-lock');
    const eventLock = f.trace.find(row => row.kind === 'event-lock');
    assert.ok(f.trace.indexOf(patientLock) < f.trace.indexOf(eventLock));
    assert.equal(f.trace.at(-1).kind, 'commit');
});
