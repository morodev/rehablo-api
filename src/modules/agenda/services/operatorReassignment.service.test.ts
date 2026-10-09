import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { recurrenceBoundary, recurrenceWithUntil } from './operatorReassignment.service.js';

describe('operator reassignment recurrence boundary', () => {
    const weeklySeries = {
        id: 'series-1',
        start: '2026-08-03T08:00:00.000Z',
        end: '2026-09-28T08:00:00.000Z',
        recurrence: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO'
    };

    it('separates a series at the first future occurrence and preserves a past side', () => {
        const boundary = recurrenceBoundary(
            weeklySeries,
            [],
            new Date('2026-08-12T12:00:00.000Z')
        );

        assert.ok(boundary?.previousStart);
        assert.equal(boundary.previousStart.toISOString(), '2026-08-10T08:00:00.000Z');
        assert.equal(boundary.nextStart.toISOString(), '2026-08-17T08:00:00.000Z');
    });

    it('does not reassign an occurrence excluded from the original series', () => {
        const boundary = recurrenceBoundary(
            weeklySeries,
            [new Date('2026-08-17T08:00:00.000Z')],
            new Date('2026-08-12T12:00:00.000Z')
        );

        assert.equal(boundary?.nextStart.toISOString(), '2026-08-24T08:00:00.000Z');
    });

    it('reports no historical side when the whole series is still in the future', () => {
        const boundary = recurrenceBoundary(
            weeklySeries,
            [],
            new Date('2026-08-01T00:00:00.000Z')
        );

        assert.equal(boundary?.previousStart, null);
        assert.equal(boundary?.nextStart.toISOString(), '2026-08-03T08:00:00.000Z');
    });

    it('normalizes COUNT and UNTIL to the new authoritative series end', () => {
        assert.equal(
            recurrenceWithUntil(
                'FREQ=WEEKLY;INTERVAL=2;COUNT=10;UNTIL=20261231T000000Z',
                new Date('2026-09-01T07:59:59.000Z')
            ),
            'FREQ=WEEKLY;INTERVAL=2;UNTIL=20260901T075959Z'
        );
    });

    it('keeps the local appointment time across the daylight-saving transition', () => {
        const boundary = recurrenceBoundary({
            id: 'dst-series',
            // 10:00 Europe/Rome while daylight-saving time is active.
            start: '2026-10-19T08:00:00.000Z',
            end: '2026-11-30T09:00:00.000Z',
            recurrence: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO'
        }, [], new Date('2026-10-20T00:00:00.000Z'));

        // On 26 October Italy is back to UTC+1: 10:00 local is therefore 09:00Z.
        assert.equal(boundary?.nextStart.toISOString(), '2026-10-26T09:00:00.000Z');
    });
});

// Database-free behavior coverage for calendar enablement and per-premise reassignment.
import { TestContext } from 'node:test';
import { Op } from 'sequelize';
import AgendaEvent from '../models/agendaEvent.model.js';
import AgendaEventException from '../models/agendaEventException.model.js';
import { StructureUser, TenantUser, User } from '../../auth/models/index.js';
import {
    getOperatorDeactivationImpact, reassignFutureAppointments, reassignDeferredOperatorAppointments,
    InvalidDeferredOperatorReassignmentError, InvalidReplacementOperatorError
} from './operatorReassignment.service.js';

const reassignmentNow = new Date('2026-08-12T12:00:00.000Z');
const transaction = { LOCK: { UPDATE: 'UPDATE' } } as any;
function matchesReassignment(row: any, where: any): boolean {
    return Reflect.ownKeys(where ?? {}).every(key => {
        const expected = where[key];
        if (key === Op.or) return expected.some((part: any) => matchesReassignment(row, part));
        if (key === Op.and) return expected.every((part: any) => matchesReassignment(row, part));
        if (typeof key !== 'string') return true;
        if (expected && typeof expected === 'object') return Reflect.ownKeys(expected).every(op => {
            if (op === Op.in) return expected[op].includes(row[key]);
            if (op === Op.ne) return row[key] !== expected[op];
            if (op === Op.not) return row[key] != expected[op];
            if (op === Op.is) return row[key] == expected[op];
            if (op === Op.gte) return row[key] >= expected[op];
            return true;
        });
        return expected === null ? row[key] == null : row[key] === expected;
    });
}
function reassignmentFixture(t: TestContext) {
    const members: any[] = ['source', 'replacement', 'other'].map(userId => ({tenantId: 'tenant', userId, deactivatedAt: null}));
    const users: any[] = members.map(row => ({id: row.userId, name: row.userId, surname: '', email: row.userId + '@test.invalid',
        isActive: true, deactivatedAt: null}));
    const structureMembers: any[] = [
        {userId: 'source', structureId: 'premise-a', calendarEnabled: false},
        {userId: 'source', structureId: 'premise-b', calendarEnabled: true},
        {userId: 'replacement', structureId: 'premise-a', calendarEnabled: true},
        {userId: 'replacement', structureId: 'premise-b', calendarEnabled: true},
        {userId: 'other', structureId: 'premise-a', calendarEnabled: true},
        {userId: 'other', structureId: 'premise-b', calendarEnabled: false}
    ];
    const appointment = (id: string, structureId: string, start: string, extra = {}) => ({id, structureId,
        calendarId: 'source', start, end: '2026-08-20T08:30:00.000Z', status: 'CONFIRMED', title: 'Seduta',
        patient: {id: 'patient'}, recurrence: null, ...extra});
    const events: any[] = [appointment('a', 'premise-a', '2026-08-20T08:00:00.000Z'),
        appointment('b', 'premise-b', '2026-08-20T08:00:00.000Z'),
        appointment('history', 'premise-a', '2026-08-01T08:00:00.000Z'),
        appointment('cancelled', 'premise-a', '2026-08-20T08:00:00.000Z', {status: 'CANCELLED'}),
        appointment('vacation', 'premise-a', '2026-08-20T08:00:00.000Z', {title: 'Ferie', patient: null})];
    const exceptions: any[] = [];
    const created: any[] = [], trace: any[] = [];
    const record = (row: any): any => Object.assign({}, row, {
        get: (key: any) => typeof key === 'string' ? row[key] : {...row},
        async update(values: any) { Object.assign(row, values); Object.assign(this, values); return this; }
    });
    const all = (rows: any[], options: any) => rows.filter(row => matchesReassignment(row, options.where)).map(record);
    const stubShared = (model: any, rows: any[]) => {
        t.mock.method(model, 'findAll', (async (options: any) => {
            if (model === StructureUser && options.lock) trace.push({kind: 'membership-lock', ...options});
            return all(rows, options);
        }) as any);
        t.mock.method(model, 'findOne', (async (options: any) => all(rows, options)[0] ?? null) as any);
        t.mock.method(model, 'findByPk', (async (id: string) => rows.find(row => row.id === id) ?? null) as any);
    };
    stubShared(TenantUser, members); stubShared(User, users); stubShared(StructureUser, structureMembers);
    t.mock.method(AgendaEvent, 'schema', (() => ({
        findAll: async (options: any) => {trace.push({kind: options.lock ? 'event-lock' : 'event-preview', ...options}); return all(events, options);},
        findOne: async (options: any) => {trace.push({kind: 'event-lock', ...options}); return all(events, options)[0] ?? null;},
        create: async (values: any) => {const row = {...values, id: 'created-' + created.length}; created.push(row); events.push(row); return record(row);}
    })) as any);
    t.mock.method(AgendaEventException, 'schema', (() => ({
        findAll: async (options: any) => all(exceptions, options),
        create: async (values: any) => {const row = {...values, id: 'exception-' + exceptions.length}; exceptions.push(row); return record(row);},
        update: async (values: any, options: any) => {exceptions.filter(row => matchesReassignment(row, options.where)).forEach(row => Object.assign(row, values));}
    })) as any);
    return {members, users, structureMembers, events, exceptions, created, appointment, trace};
}

it('calendar disable impact is scoped to its premise and excludes time off and cancelled appointments', async t => {
    const f = reassignmentFixture(t);
    const impact = await getOperatorDeactivationImpact('tenant', 'schema', 'source', reassignmentNow, 'premise-a');
    assert.equal(impact.futureSingleAppointments, 1);
    assert.equal(impact.futureRecurringSeries, 0);
    assert.deepEqual(impact.replacementOperators.map(row => row.id), ['other', 'replacement']);
    assert.equal(f.events[1].calendarId, 'source');
});
it('ordinary offboarding still spans every premise and only offers substitutes enabled in all of them', async t => {
    reassignmentFixture(t);
    const impact = await getOperatorDeactivationImpact('tenant', 'schema', 'source', reassignmentNow);
    assert.equal(impact.futureSingleAppointments, 2);
    assert.deepEqual(impact.replacementOperators.map(row => row.id), ['replacement']);
});
it('immediate calendar reassignment changes only future appointments in the selected premise', async t => {
    const f = reassignmentFixture(t);
    const result = await reassignFutureAppointments('tenant', 'schema', 'source', 'other', transaction, reassignmentNow, 'premise-a');
    assert.deepEqual(result, {reassignedSingleAppointments: 1, reassignedRecurringSeries: 0});
    assert.equal(f.events.find(row => row.id === 'a').calendarId, 'other');
    for (const id of ['b', 'history', 'cancelled', 'vacation']) assert.equal(f.events.find(row => row.id === id).calendarId, 'source');
});
it('immediate reassignment rejects a substitute whose calendar is disabled in the selected premise', async t => {
    const f = reassignmentFixture(t);
    f.structureMembers.find(row => row.userId === 'other' && row.structureId === 'premise-a').calendarEnabled = false;
    await assert.rejects(reassignFutureAppointments('tenant', 'schema', 'source', 'other', transaction, reassignmentNow, 'premise-a'), InvalidReplacementOperatorError);
    assert.equal(f.events[0].calendarId, 'source');
});
it('scoped immediate reassignment splits a recurring series while preserving its history and exceptions', async t => {
    const f = reassignmentFixture(t);
    f.events.push(f.appointment('series', 'premise-a', '2026-08-03T08:00:00.000Z', {
        end: '2026-09-28T08:00:00.000Z', recurrence: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO', duration: 30,
        invoiceId: 'old-invoice', appointmentPaidAmount: 50, missedArrivalReportedAt: '2026-08-10T08:30:00.000Z'
    }));
    f.exceptions.push({id: 'ex-past', eventId: 'series', exdate: '2026-08-10T08:00:00.000Z'},
        {id: 'ex-future', eventId: 'series', exdate: '2026-08-24T08:00:00.000Z'});
    const result = await reassignFutureAppointments('tenant', 'schema', 'source', 'replacement', transaction, reassignmentNow, 'premise-a');
    assert.equal(result.reassignedRecurringSeries, 1);
    const old = f.events.find(row => row.id === 'series'), next = f.created[0];
    assert.equal(old.calendarId, 'source');
    assert.equal(old.end, '2026-08-17T07:59:59.000Z');
    assert.equal(next.start, '2026-08-17T08:00:00.000Z');
    assert.equal(next.end, '2026-09-28T08:00:00.000Z');
    assert.equal(next.structureId, 'premise-a'); assert.equal(next.calendarId, 'replacement');
    assert.equal(next.invoiceId, null); assert.equal(next.appointmentPaidAmount, null); assert.equal(next.missedArrivalReportedAt, null);
    assert.equal(f.exceptions.find(row => row.id === 'ex-past').eventId, 'series');
    assert.equal(f.exceptions.find(row => row.id === 'ex-future').eventId, next.id);
    assert.equal(f.events.find(row => row.id === 'b').calendarId, 'source');
});
it('deferred reassignment recognizes an active user with calendar disabled only in the event premise', async t => {
    const f = reassignmentFixture(t);
    const result = await reassignDeferredOperatorAppointments('tenant', 'schema', [{eventId: 'a', replacementUserId: 'replacement'}], {}, transaction, reassignmentNow);
    assert.equal(result.reassignedAppointments, 1);
    assert.equal(f.events[0].calendarId, 'replacement');
    await assert.rejects(reassignDeferredOperatorAppointments('tenant', 'schema', [{eventId: 'b', replacementUserId: 'replacement'}], {}, transaction, reassignmentNow), /non presenta piu'/);
});
it('deferred reassignment rejects a destination with disabled calendar and keeps historical appointments untouched', async t => {
    const f = reassignmentFixture(t);
    f.structureMembers.find(row => row.userId === 'replacement' && row.structureId === 'premise-a').calendarEnabled = false;
    await assert.rejects(reassignDeferredOperatorAppointments('tenant', 'schema', [{eventId: 'a', replacementUserId: 'replacement'}], {}, transaction, reassignmentNow), /agenda abilitata/);
    f.structureMembers.find(row => row.userId === 'replacement' && row.structureId === 'premise-a').calendarEnabled = true;
    await assert.rejects(reassignDeferredOperatorAppointments('tenant', 'schema', [{eventId: 'history', replacementUserId: 'replacement'}], {}, transaction, reassignmentNow), InvalidDeferredOperatorReassignmentError);
    assert.equal(f.events[0].calendarId, 'source');
    assert.equal(f.events.find(row => row.id === 'history').calendarId, 'source');
});
it('deferred recurring reassignment extracts only the chosen future occurrence and clears financial history', async t => {
    const f = reassignmentFixture(t);
    f.events.push(f.appointment('series', 'premise-a', '2026-08-03T08:00:00.000Z', {end: '2026-09-28T08:00:00.000Z',
        recurrence: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO', duration: 30, invoiceId: 'old-invoice', appointmentPaidAmount: 50}));
    const result = await reassignDeferredOperatorAppointments('tenant', 'schema', [{eventId: 'series',
        occurrenceStart: '2026-08-17T08:00:00.000Z', replacementUserId: 'replacement'}], {}, transaction, reassignmentNow);
    assert.deepEqual(result, {reassignedAppointments: 1, reassignedRecurringOccurrences: 1});
    assert.equal(f.events.find(row => row.id === 'series').calendarId, 'source');
    assert.equal(f.created[0].recurrence, null); assert.equal(f.created[0].end, '2026-08-17T08:30:00.000Z');
    assert.equal(f.created[0].structureId, 'premise-a'); assert.equal(f.created[0].invoiceId, null);
    assert.equal(f.created[0].appointmentPaidAmount, null);
    assert.deepEqual(f.exceptions.map(row => ({eventId: row.eventId, exdate: row.exdate})),
        [{eventId: 'series', exdate: '2026-08-17T08:00:00.000Z'}]);
});
it('immediate reassignment locks source and destination memberships in deterministic order before events', async t => {
    const f = reassignmentFixture(t);
    await reassignFutureAppointments('tenant', 'schema', 'source', 'replacement', transaction, reassignmentNow, 'premise-a');
    const membership = f.trace.find(row => row.kind === 'membership-lock'), eventLock = f.trace.find(row => row.kind === 'event-lock');
    assert.deepEqual(membership.order, [['userId', 'ASC'], ['structureId', 'ASC']]);
    assert.deepEqual(membership.where.userId[Op.in].sort(), ['replacement', 'source']);
    assert.deepEqual(membership.where.structureId[Op.in], ['premise-a']);
    assert.equal(membership.transaction, transaction); assert.equal(eventLock.transaction, transaction);
    assert.ok(f.trace.indexOf(membership) < f.trace.indexOf(eventLock));
});
it('deferred reassignment resolves context without a lock then locks memberships before its event', async t => {
    const f = reassignmentFixture(t);
    await reassignDeferredOperatorAppointments('tenant', 'schema', [{eventId: 'a', replacementUserId: 'replacement'}], {}, transaction, reassignmentNow);
    const preview = f.trace.find(row => row.kind === 'event-preview'), membership = f.trace.find(row => row.kind === 'membership-lock'),
        eventLock = f.trace.find(row => row.kind === 'event-lock');
    assert.equal(preview.lock, undefined);
    assert.deepEqual(membership.order, [['userId', 'ASC'], ['structureId', 'ASC']]);
    assert.deepEqual(membership.where.userId[Op.in].sort(), ['replacement', 'source']);
    assert.ok(f.trace.indexOf(preview) < f.trace.indexOf(membership));
    assert.ok(f.trace.indexOf(membership) < f.trace.indexOf(eventLock));
    for (const operation of [preview, membership, eventLock]) assert.equal(operation.transaction, transaction);
});
