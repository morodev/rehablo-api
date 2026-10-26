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
import { completeAppointmentIfUntouched, deleteAgendaEvent, reportMissedArrival, resolveMissedArrival, saveAgendaEvent, updateAgendaEvent, updateRecurringEvent } from './agenda.controller.js';
import {CarePackage, PackageConsumption} from '../../administration/models/administration.model.js';
import {getRolePermissions, RoleCode} from '../../auth/rbac/roles.js';
import {shouldAutoCompleteAppointment} from '../services/missedArrivalAutomation.service.js';

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
it('a reopened appointment retains its package consumption audit and cannot be deleted', async t => {
    const f = fixture(t); f.req.query = {id: eventId};
    f.current.packageReservationStatus = 'RESERVED';
    t.mock.method(PackageConsumption, 'schema', (() => ({count: async () => 2})) as any);
    const result = await run(deleteAgendaEvent, f.req);
    assert.equal(result.status, 409);
    assert.match(result.body.message, /storico di utilizzo del pacchetto/);
    assert.equal(f.updated.length, 0);
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

it('records every direct arrival outcome in one locked attendance update and responds after commit', async t => {
    for (const resolution of ['ARRIVING', 'COMPLETED', 'CANCELLED', 'NO_SHOW']) {
        const f = fixture(t); f.req.params.agendaEventId = eventId; f.req.body = {resolution, reportIfMissing: true};
        const result = await run(resolveMissedArrival, f.req);
        assert.equal(result.status, 200, resolution); assert.equal(f.updated.length, 1, resolution);
        assert.equal(f.current.status, resolution === 'ARRIVING' ? 'CONFIRMED' : resolution);
        assert.equal(f.current.missedArrivalResolution, resolution);
        assert.equal(f.current.missedArrivalReportedBy, f.req.access.userId); assert.equal(f.current.missedArrivalResolvedBy, f.req.access.userId);
        assert.equal(f.current.missedArrivalReportedAt.getTime(), f.current.missedArrivalResolvedAt.getTime());
        assert.equal(f.current.noShowBillingDecision, resolution === 'NO_SHOW' ? 'PENDING' : null);
        const patientLock = f.trace.find(row => row.kind === 'patient-lock');
        const eventLock = f.trace.find(row => row.kind === 'event-lock');
        const saved = f.trace.find(row => row.kind === 'event-save');
        assert.ok(f.trace.indexOf(patientLock) < f.trace.indexOf(eventLock)); assert.ok(f.trace.indexOf(eventLock) < f.trace.indexOf(saved));
        for (const operation of [patientLock, eventLock, saved]) assert.equal(operation.transaction, f.transactionContext);
        assert.equal(f.trace.at(-1).kind, 'commit');
    }
});

it('keeps the legacy open-report requirement unless reportIfMissing is explicitly true', async t => {
    for (const body of [{resolution: 'COMPLETED'}, {resolution: 'COMPLETED', reportIfMissing: false}]) {
        const f = fixture(t); f.req.params.agendaEventId = eventId; f.req.body = body;
        const result = await run(resolveMissedArrival, f.req);
        assert.equal(result.status, 409); assert.match(result.body.message, /Non esiste una segnalazione/);
        assert.equal(f.updated.length, 0); assert.equal(f.current.missedArrivalReportedAt, undefined);
    }
    for (const flag of [undefined, true]) {
        const f = fixture(t); f.req.params.agendaEventId = eventId;
        const reportedAt = new Date('2025-01-02T09:20:00Z');
        f.current.missedArrivalReportedAt = reportedAt; f.current.missedArrivalReportedBy = id(20);
        f.req.body = {resolution: 'COMPLETED', ...(flag === undefined ? {} : {reportIfMissing: flag})};
        assert.equal((await run(resolveMissedArrival, f.req)).status, 200);
        assert.equal(f.updated.length, 1); assert.equal(f.current.missedArrivalReportedAt, reportedAt);
        assert.equal(f.current.missedArrivalReportedBy, id(20)); assert.equal('missedArrivalReportedAt' in f.updated[0], false);
    }
});

it('rejects malformed direct-report flags and invalid resolutions before entering a transaction', async t => {
    for (const reportIfMissing of [null, 'true', 'false', 0, 1, {}, []]) {
        const f = fixture(t); f.req.params.agendaEventId = eventId; f.req.body = {resolution: 'COMPLETED', reportIfMissing};
        assert.equal((await run(resolveMissedArrival, f.req)).status, 400); assert.equal(f.trace.length, 0);
    }
    const f = fixture(t); f.req.params.agendaEventId = eventId; f.req.body = {resolution: 'UNKNOWN', reportIfMissing: true};
    assert.equal((await run(resolveMissedArrival, f.req)).status, 400); assert.equal(f.trace.length, 0);
});

it('enforces the exact fifteen-minute boundary before recording a direct outcome', async t => {
    const now = Date.parse('2026-10-30T10:15:00Z'); t.mock.method(Date, 'now', () => now);
    const early = fixture(t); early.req.params.agendaEventId = eventId; early.req.body = {resolution: 'COMPLETED', reportIfMissing: true};
    early.current.start = new Date(now - 15 * 60000 + 1).toISOString();
    const rejected = await run(resolveMissedArrival, early.req);
    assert.equal(rejected.status, 409); assert.equal(rejected.body.error.availableAt, new Date(now + 1).toISOString());
    assert.equal(early.updated.length, 0); assert.equal(early.current.missedArrivalReportedAt, undefined);
    const boundary = fixture(t); boundary.req.params.agendaEventId = eventId; boundary.req.body = {resolution: 'COMPLETED', reportIfMissing: true};
    boundary.current.start = new Date(now - 15 * 60000).toISOString();
    assert.equal((await run(resolveMissedArrival, boundary.req)).status, 200); assert.equal(boundary.updated.length, 1);
});

it('refuses ineligible direct reports without opening an intermediate alert', async t => {
    for (const [changes, expected] of [
        [{recurrence: 'FREQ=WEEKLY'}, 422], [{recurringEventId: id(30)}, 422],
        [{patientId: null, patient: null}, 422], [{start: 'not-a-date'}, 422], [{start: '2099-01-01T09:00:00Z'}, 409],
        [{status: 'COMPLETED'}, 409], [{status: 'CANCELLED'}, 409], [{status: 'NO_SHOW'}, 409],
        [{invoiceId: id(31)}, 409], [{appointmentPaidAmount: 20}, 409],
    ] as Array<[Record<string, unknown>, number]>) {
        const f = fixture(t); Object.assign(f.current, changes); f.req.params.agendaEventId = eventId; f.req.body = {resolution: 'NO_SHOW', reportIfMissing: true};
        const result = await run(resolveMissedArrival, f.req);
        assert.equal(result.status, expected, JSON.stringify(changes)); assert.equal(f.updated.length, 0);
        assert.equal(f.current.missedArrivalReportedAt, undefined); assert.equal(f.current.missedArrivalResolvedAt, undefined);
    }
});

it('requires pricing rights for a waived no-show while preserving basic attendance rights and own-calendar pricing', async t => {
    const denied = fixture(t); denied.req.params.agendaEventId = eventId;
    denied.req.user = {tid: tenantId, sub: operatorId, sid: structureId, role: RoleCode.SECRETARY, perms: getRolePermissions(RoleCode.SECRETARY)};
    denied.req.body = {resolution: 'NO_SHOW', noShowBillingDecision: 'WAIVED', reportIfMissing: true};
    assert.equal((await run(resolveMissedArrival, denied.req)).status, 403); assert.equal(denied.updated.length, 0);
    assert.equal(denied.current.missedArrivalReportedAt, undefined);
    denied.req.body.noShowBillingDecision = 'PENDING';
    assert.equal((await run(resolveMissedArrival, denied.req)).status, 200);
    const own = fixture(t); own.req.params.agendaEventId = eventId;
    own.req.user = {tid: tenantId, sub: operatorId, sid: structureId, role: RoleCode.THERAPIST, perms: getRolePermissions(RoleCode.THERAPIST)};
    own.req.access = {scope: 'own', userId: operatorId, structureId};
    own.req.body = {resolution: 'NO_SHOW', noShowBillingDecision: 'WAIVED', reportIfMissing: true};
    assert.equal((await run(resolveMissedArrival, own.req)).status, 200); assert.equal(own.current.noShowBillingDecision, 'WAIVED');
    assert.equal(own.trace.find(row => row.kind === 'event-lock').where.calendarId, operatorId);
    const wrongCalendar = fixture(t); wrongCalendar.req.params.agendaEventId = eventId;
    wrongCalendar.req.user = own.req.user; wrongCalendar.current.calendarId = id(40);
    wrongCalendar.req.body = {resolution: 'NO_SHOW', noShowBillingDecision: 'WAIVED', reportIfMissing: true};
    assert.equal((await run(resolveMissedArrival, wrongCalendar.req)).status, 403); assert.equal(wrongCalendar.updated.length, 0);
    const invalid = fixture(t); invalid.req.params.agendaEventId = eventId;
    invalid.req.body = {resolution: 'NO_SHOW', noShowBillingDecision: 'INVOICED', reportIfMissing: true};
    assert.equal((await run(resolveMissedArrival, invalid.req)).status, 400); assert.equal(invalid.updated.length, 0);
});

it('retains the reported marker for ARRIVING so neither completion path treats the attendance as untouched', async t => {
    const f = fixture(t); f.req.params.agendaEventId = eventId; f.req.body = {resolution: 'ARRIVING', reportIfMissing: true};
    f.current.start = new Date(Date.now() - 60 * 60000).toISOString(); f.current.end = new Date(Date.now() - 30 * 60000).toISOString();
    assert.equal(shouldAutoCompleteAppointment(f.current), true);
    assert.equal((await run(resolveMissedArrival, f.req)).status, 200);
    assert.equal(f.current.status, 'CONFIRMED'); assert.ok(f.current.missedArrivalReportedAt); assert.ok(f.current.missedArrivalResolvedAt);
    assert.equal(shouldAutoCompleteAppointment(f.current), false);
    assert.equal(shouldAutoCompleteAppointment({...f.current, missedArrivalReportedAt: null}), true);
});

it('rejects a concurrent automatic completion observed under the event lock without reopening the appointment', async t => {
    const f = fixture(t); f.req.params.agendaEventId = eventId; f.req.body = {resolution: 'NO_SHOW', reportIfMissing: true};
    const model = AgendaEvent.schema('rehablo_test');
    t.mock.method(AgendaEvent, 'schema', (() => ({...model, findOne: async (options: any) => {
        if (options.lock) f.current.status = 'COMPLETED';
        return model.findOne(options);
    }})) as any);
    const result = await run(resolveMissedArrival, f.req);
    assert.equal(result.status, 409); assert.equal(f.current.status, 'COMPLETED'); assert.equal(f.updated.length, 0);
    assert.equal(f.current.missedArrivalReportedAt, undefined);
});

it('keeps a failed package transition inside the attendance transaction without persisting a preliminary report', async t => {
    const f = fixture(t); f.req.params.agendaEventId = eventId; f.req.body = {resolution: 'NO_SHOW', reportIfMissing: true};
    f.req.user.isSuperAdmin = true; f.current.carePackageId = id(50); f.current.packageReservationStatus = 'RESERVED';
    t.mock.method(CarePackage, 'schema', (() => ({findAll: async (options: any) => {
        assert.equal(options.transaction, f.transactionContext); assert.equal(options.lock, f.transactionContext.LOCK.UPDATE);
        throw Object.assign(new Error('Package transition rejected'), {statusCode: 422});
    }})) as any);
    t.mock.method(sequelize, 'transaction', (async (callback: any) => {
        f.trace.push({kind: 'begin'});
        try {const result = await callback(f.transactionContext); f.trace.push({kind: 'commit'}); return result;}
        catch (error) {f.trace.push({kind: 'rollback'}); throw error;}
    }) as any);
    const result = await run(resolveMissedArrival, f.req);
    assert.equal(result.status, 422); assert.equal(f.trace.at(-1).kind, 'rollback'); assert.equal(f.updated.length, 0);
    assert.equal(f.current.status, 'CONFIRMED'); assert.equal(f.current.missedArrivalReportedAt, undefined); assert.equal(f.current.missedArrivalResolvedAt, undefined);
});

it('preserves the explicit report endpoint and its idempotent open-alert behavior', async t => {
    const f = fixture(t); f.req.params.agendaEventId = eventId;
    assert.equal((await run(reportMissedArrival, f.req)).status, 200); const reportedAt = f.current.missedArrivalReportedAt;
    assert.equal((await run(reportMissedArrival, f.req)).status, 200);
    assert.equal(f.updated.length, 1); assert.equal(f.current.missedArrivalReportedAt, reportedAt);
    assert.equal(f.current.status, 'CONFIRMED'); assert.equal(f.current.missedArrivalResolvedAt, null);
});

it('complete-if-untouched consumes only the assigned package with attendance rights and caller audit after commit',async t=>{
    const f=fixture(t),packageId=id(70),serviceId=id(71),movements:any[]=[];
    const pkg:any={id:packageId,templateId:id(72),patientId,structureId,serviceId,status:'ACTIVE',remainingUnits:1,purchasedUnits:1,
        purchasedAt:'2020-01-01',expiresAt:null};
    const packageRecord:any={get:(key:any)=>typeof key==='string'?pkg[key]:{...pkg},
        update:async(patch:any)=>{Object.assign(pkg,patch);return packageRecord;}};
    Object.assign(f.current,{eventTypeId:id(73),start:new Date(Date.now()-3600000).toISOString(),
        end:new Date(Date.now()-1800000).toISOString(),carePackageId:packageId,carePackageServiceId:serviceId,packageReservationStatus:'RESERVED'});
    f.req.params={agendaEventId:eventId};f.req.access.scope='own';f.req.access.userId=operatorId;
    f.req.user={tid:tenantId,sub:operatorId,perms:['agenda:update:own']};
    t.mock.method(CarePackage,'schema',(()=>({findAll:async(options:any)=>{
        f.trace.push({kind:'package-lock',...options});return [packageRecord];}})) as any);
    t.mock.method(AgendaEvent,'schema',(()=>({findOne:async(options:any)=>{
        assert.equal(options.where.calendarId,operatorId);
        f.trace.push({kind:options.lock?'event-lock':'event-preview',...options});
        return {id:eventId,get:(key:any)=>typeof key==='string'?f.current[key]:{...f.current},
            update:async(patch:any,options:any)=>{f.trace.push({kind:'event-save',...options});Object.assign(f.current,patch);return f.current;}};
    },count:async()=>0})) as any);
    t.mock.method(PackageConsumption,'schema',(()=>({findOne:async()=>null,create:async(values:any)=>{
        movements.push(values);return {get:()=>values};}})) as any);
    t.mock.method(InvoicePayment,'schema',(()=>({findOne:async()=>null})) as any);
    const result=await run(completeAppointmentIfUntouched,f.req);
    assert.equal(result.status,200);assert.equal(f.current.status,'COMPLETED');assert.equal(f.current.packageReservationStatus,'CONSUMED');
    assert.equal(pkg.remainingUnits,0);assert.equal(movements.length,1);assert.equal(movements[0].createdByUserId,operatorId);
    assert.match(movements[0].note,/automatico/);
    const kinds=f.trace.map(row=>row.kind);
    assert.ok(kinds.indexOf('patient-lock')<kinds.indexOf('event-lock'));
    assert.ok(kinds.indexOf('event-lock')<kinds.indexOf('package-lock'));
    assert.ok(kinds.indexOf('event-save')<kinds.indexOf('commit'));
    assert.equal(await run(completeAppointmentIfUntouched,f.req).then(value=>value.status),200);assert.equal(movements.length,1);
});

it('complete-if-untouched preserves explicit ARRIVING and a concurrent future move without touching packages',async t=>{
    const f=fixture(t);f.req.params={agendaEventId:eventId};
    Object.assign(f.current,{start:new Date(Date.now()-3600000).toISOString(),end:new Date(Date.now()-1800000).toISOString(),
        carePackageId:id(70),packageReservationStatus:'RESERVED',missedArrivalReportedAt:new Date(),
        missedArrivalResolvedAt:new Date(),missedArrivalResolution:'ARRIVING'});
    assert.equal((await run(completeAppointmentIfUntouched,f.req)).status,200);assert.equal(f.updated.length,0);
    f.current.missedArrivalReportedAt=null;
    const model=(AgendaEvent.schema as any)('rehablo_test'),find=model.findOne;
    t.mock.method(AgendaEvent,'schema',(()=>({...model,findOne:async(options:any)=>{
        if(options.lock){f.current.start=new Date(Date.now()+3600000).toISOString();f.current.end=new Date(Date.now()+5400000).toISOString();}
        return find(options);
    }})) as any);
    assert.equal((await run(completeAppointmentIfUntouched,f.req)).status,200);assert.equal(f.updated.length,0);
    assert.equal(f.current.status,'CONFIRMED');
});

it('complete-if-untouched rejects inaccessible appointments without looking up their packages',async t=>{
    const f=fixture(t);f.req.params={agendaEventId:eventId};
    t.mock.method(AgendaEvent,'schema',(()=>({findOne:async()=>null})) as any);
    const packages=t.mock.method(CarePackage,'schema',(()=>{throw Error('must not read packages');}) as any);
    assert.equal((await run(completeAppointmentIfUntouched,f.req)).status,404);assert.equal(packages.mock.callCount(),0);
});
