import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after, before, test} from 'node:test';
import {createActivitiesHarness, type ActivitiesHarness, type ApiResult} from './activitiesTestHarness.js';

let h: ActivitiesHarness;
before(async () => {h = await createActivitiesHarness();}, {timeout: 180_000});
after(async () => {if (h) await h.cleanup();}, {timeout: 60_000});
function data(result: ApiResult, status = 200) {
    assert.equal(result.status, status, JSON.stringify(result.body));
    return result.body.data;
}
async function create(title: string, fields: Record<string, unknown> = {}, actor = h.actors.ownerA) {
    return data(await h.api(actor, 'POST', '/activities', {operationId: randomUUID(), title, assigneeIds: [], ...fields}), 201).activity;
}
async function resourcePair(structureId = h.ids.structureA) {
    const {default: Patient} = await import('../../patients/models/patient.model.js');
    const {default: AgendaEvent} = await import('../../agenda/models/agendaEvent.model.js');
    const patient = await Patient.schema(h.schemas.a).create({tenantId: h.ids.tenantA, structureId, userId: h.ids.ownerA,
        name: 'Ada', surname: 'Rossi', notes: 'This clinical text cannot appear in previews'});
    const event = await AgendaEvent.schema(h.schemas.a).create({structureId, calendarId: h.ids.ownerA,
        patientId: patient.id, title: 'Controllo', start: new Date(Date.now() + 86_400_000).toISOString(), allDay: false,
        recurrence: 'FREQ=WEEKLY', description: 'Confidential description', patient: {email: 'private@example.invalid'}});
    return {patient, event};
}

test('dashboard groups are disjoint, server-counted, limited, sorted and scoped to assignment', async () => {
    const {activityLocalDate, effectiveDueAt} = await import('../utils/activityValidation.js');
    const now = new Date(), today = activityLocalDate(now);
    const day = new Date(today + 'T00:00:00Z'); day.setUTCDate(day.getUTCDate() - 1);
    const yesterday = day.toISOString().slice(0, 10); day.setUTCDate(day.getUTCDate() + 2);
    const tomorrow = day.toISOString().slice(0, 10);
    const end = effectiveDueAt({kind: 'allDay', date: today, timezone: 'Europe/Rome'})!;
    const urgent = await create('Urgent deadline', {priority: 'URGENT', assigneeIds: [h.ids.ownerA], due: {kind: 'timed', at: end.toISOString()}});
    await create('Normal deadline', {due: {kind: 'timed', at: end.toISOString()}});
    for (let i = 0; i < 7; i++) await create('All-day task ' + i, {due: {kind: 'allDay', date: today, timezone: 'Europe/Rome'}});
    await create('Tomorrow task', {due: {kind: 'allDay', date: tomorrow, timezone: 'Europe/Rome'}});
    const timedPast = await create('Passed today'), allDayPast = await create('Passed yesterday');
    const completed = await create('Completed old task'), archived = await create('Archived old task');
    const model = h.activities.Activity.schema(h.schemas.a);
    await model.update({dueKind: 'timed', dueAt: new Date(now.getTime() - 60_000)}, {where: {id: timedPast.id}});
    await model.update({dueKind: 'allDay', dueDate: yesterday, dueTimezone: 'Europe/Rome'}, {where: {id: allDayPast.id}});
    await model.update({dueKind: 'timed', dueAt: new Date(now.getTime() - 120_000), status: 'COMPLETED', completedAt: now, completedByUserId: h.ids.ownerA}, {where: {id: completed.id}});
    await model.update({dueKind: 'timed', dueAt: new Date(now.getTime() - 120_000), archivedAt: now, archivedByUserId: h.ids.ownerA}, {where: {id: archived.id}});
    const summary = data(await h.api(h.actors.ownerA, 'GET', '/activities/summary?limit=5'));
    assert.equal(summary.overdue.total, 2); assert.equal(summary.today.total, 9);
    assert.equal(summary.today.items.length, 5); assert.equal(summary.today.items[0].id, urgent.id);
    const yesterdayEnd = effectiveDueAt({kind: 'allDay', date: yesterday, timezone: 'Europe/Rome'})!;
    const expectedOverdue = yesterdayEnd.getTime() < now.getTime() - 60_000 ? [allDayPast.id, timedPast.id] : [timedPast.id, allDayPast.id];
    assert.deepEqual(summary.overdue.items.map((item: any) => item.id), expectedOverdue);
    assert.ok(summary.overdue.items.every((item: any) => item.isOverdue));
    assert.ok(summary.today.items.every((item: any) => !item.isOverdue));
    const mine = data(await h.api(h.actors.ownerA, 'GET', '/activities/summary?mine=true&limit=5'));
    assert.equal(mine.overdue.total, 0); assert.equal(mine.today.total, 1); assert.equal(mine.today.items[0].id, urgent.id);
    const combined = data(await h.api(h.actors.ownerA, 'GET', '/activities?view=list&due=todayOrOverdue&limit=200'));
    assert.equal(combined.total, summary.overdue.total + summary.today.total);
    assert.equal(new Set(combined.items.map((item: any) => item.id)).size, combined.total);
    const other = data(await h.api(h.actors.ownerA2, 'GET', '/activities/summary'));
    assert.equal(other.today.total + other.overdue.total, 0);
});

test('summary and contextual link query validation reject unsupported values and staff restrictions remain enforced', async () => {
    for (const path of ['/activities/summary?limit=6', '/activities/summary?mine=1', '/activities/summary?day=2030-01-01',
        '/activities/links', '/activities/links?patientId=occurrence', '/activities/links?patientId=' + randomUUID() + '&unexpected=true']) {
        assert.equal((await h.api(h.actors.ownerA, 'GET', path)).status, 422, path);
    }
    assert.equal((await h.api(h.actors.patient, 'GET', '/activities/summary')).status, 403);
    assert.equal((await h.api(h.actors.missingStructure, 'GET', '/activities/summary')).status, 403);
});

test('contextual prefill returns fresh authorized labels and cannot expose another structure or mismatched patient', async () => {
    const {patient, event} = await resourcePair();
    const query = '/activities/links?patientId=' + patient.id + '&agendaEventId=' + event.id;
    const links = data(await h.api(h.actors.ownerA, 'GET', query));
    assert.deepEqual(links.patient, {id: patient.id, displayName: 'Ada Rossi'});
    assert.equal(links.agendaEvent.id, event.id); assert.equal(links.agendaEvent.isRecurring, true);
    assert.equal(links.capabilities.canCreate, true);
    assert.ok(!JSON.stringify(links).includes('Confidential')); assert.ok(!JSON.stringify(links).includes('private@example'));
    await patient.update({name: 'Elena'});
    assert.equal(data(await h.api(h.actors.ownerA, 'GET', query)).patient.displayName, 'Elena Rossi');
    assert.equal((await h.api(h.actors.ownerA2, 'GET', query)).status, 404);
    assert.equal((await h.api(h.actors.ownerB, 'GET', query)).status, 404);
    const other = await resourcePair();
    assert.equal((await h.api(h.actors.ownerA, 'GET', '/activities/links?patientId=' + other.patient.id + '&agendaEventId=' + event.id)).status, 422);
    assert.equal((await h.api(h.actors.ownerA, 'GET', '/activities?agendaEventId=' + randomUUID())).status, 404);
});

test('appointment filters use a persisted series UUID and cursors cannot cross resource filters', async () => {
    const first = await resourcePair(), second = await resourcePair();
    const firstA = await create('First linked A', {patientId: first.patient.id, agendaEventId: first.event.id});
    await create('First linked B', {patientId: first.patient.id, agendaEventId: first.event.id});
    await create('Second linked', {patientId: second.patient.id, agendaEventId: second.event.id});
    const page = data(await h.api(h.actors.ownerA, 'GET', '/activities?view=list&agendaEventId=' + first.event.id + '&limit=1'));
    assert.equal(page.total, 2); assert.equal(page.items[0].id, firstA.id); assert.ok(page.nextCursor);
    const changed = await h.api(h.actors.ownerA, 'GET', '/activities?view=list&agendaEventId=' + second.event.id + '&limit=1&cursor=' + encodeURIComponent(page.nextCursor));
    assert.equal(changed.status, 409); assert.equal(changed.body.error.code, 'ACTIVITY_CURSOR_EXPIRED');
    const next = data(await h.api(h.actors.ownerA, 'GET', '/activities?view=list&agendaEventId=' + first.event.id + '&limit=1&cursor=' + encodeURIComponent(page.nextCursor)));
    assert.equal(next.items.length, 1); assert.notEqual(next.items[0].id, firstA.id);
});
