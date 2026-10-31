import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after, afterEach, before, test} from 'node:test';
import {Op, type Transaction} from 'sequelize';
import {createActivitiesHarness, type ActivitiesHarness, type ApiResult} from './activitiesTestHarness.js';
import type {Activity, ActivityBoard} from '../models/index.js';
import type {ActivityRecurrenceContext} from '../services/activityRecurrence.service.js';
import type {ActivityRecurrenceTemplate} from '../utils/activityRecurrence.policy.js';

let h: ActivitiesHarness;
let core: typeof import('../services/activityRecurrence.service.js');
let policy: typeof import('../utils/activityRecurrence.policy.js');
let gate: typeof import('../../../utils/tenantActivityGate.js');
const activityIds: string[] = [];
before(async () => {
    h = await createActivitiesHarness();
    core = await import('../services/activityRecurrence.service.js');
    policy = await import('../utils/activityRecurrence.policy.js');
    gate = await import('../../../utils/tenantActivityGate.js');
}, {timeout: 180_000});
after(async () => {if (h) await h.cleanup();}, {timeout: 60_000});
afterEach(async () => {
    if (!h) return;
    if (activityIds.length) await h.activities.Activity.schema(h.schemas.a).update({archivedAt: new Date(), archivedByUserId: h.ids.ownerA},
        {where: {id: {[Op.in]: activityIds.splice(0)}}});
    await h.auth.TenantUser.upsert({tenantId: h.ids.tenantA, userId: h.ids.therapistA, role: 'THERAPIST', deactivatedAt: null});
    await h.auth.StructureUser.upsert({structureId: h.ids.structureA, userId: h.ids.therapistA, role: null, calendarEnabled: false});
});

function success(result: ApiResult, status = 200): any {
    assert.equal(result.status, status, JSON.stringify(result.body));
    return result.body.data;
}
function failure(result: ApiResult, status: number, code: string) {
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.equal(result.body.error?.code, code, JSON.stringify(result.body));
}
async function locked<T>(id: string, apply: (context: ActivityRecurrenceContext, board: ActivityBoard, parent: Activity, transaction: Transaction) => Promise<T>): Promise<T> {
    return h.sequelize.transaction(async transaction => {
        await gate.acquireTenantActivityGate(h.ids.tenantA, transaction, 'shared');
        const board = await h.activities.ActivityBoard.schema(h.schemas.a).findOne({where: {structureId: h.ids.structureA}, transaction, lock: transaction.LOCK.UPDATE});
        assert.ok(board);
        const parent = await h.activities.Activity.schema(h.schemas.a).findByPk(id, {transaction});
        assert.ok(parent);
        return apply({schema: h.schemas.a, tenantId: h.ids.tenantA, structureId: h.ids.structureA, timezone: board.timezone}, board, parent, transaction);
    });
}
async function createRoutine(templateChanges: Partial<ActivityRecurrenceTemplate> = {}, previousDay = false) {
    const title = 'Recurring offboarding ' + randomUUID();
    const row = success(await h.api(h.actors.ownerA, 'POST', '/activities', {operationId: randomUUID(), title,
        assigneeIds: [h.ids.therapistA]}), 201).activity;
    activityIds.push(row.id);
    const today = policy.recurrenceLocalDate(new Date());
    const startsOn = policy.addRecurrenceDays(today, previousDay ? -1 : 3);
    const template: ActivityRecurrenceTemplate = {title, description: null, priority: 'NORMAL',
        assigneeIds: [h.ids.therapistA], reviewerUserId: null, patientId: null, agendaEventId: null,
        checklist: [{text: 'Verifica quotidiana'}], ...templateChanges};
    await locked(row.id, async (context, board, parent, tx) => {
        await core.configureActivityRecurrence(parent, {frequency: 'weekly', interval: 1, startsOn, endsOn: null},
            template, board, context, tx, previousDay ? new Date(startsOn + 'T12:00:00Z') : new Date());
        if (previousDay) await core.synchronizeActivityRecurrence(context, board, parent, tx, new Date());
    });
    return {id: row.id as string, startsOn};
}
async function parent(id: string) {
    const result = await h.activities.Activity.schema(h.schemas.a).findByPk(id);
    assert.ok(result); return result;
}
async function preflight() {
    return success(await h.api(h.actors.ownerA, 'POST', `/user/${h.ids.therapistA}/offboarding-impact`, {change: {kind: 'status', active: false}}));
}
function site(impact: any) {return impact.structures.find((row: any) => row.structureId === h.ids.structureA);}
async function deactivate(impact: any, mode: 'replace' | 'defer' = 'replace') {
    return h.api(h.actors.ownerA, 'PATCH', `/user/${h.ids.therapistA}/status`, {active: false,
        operationId: randomUUID(), impactFingerprint: impact.fingerprint,
        resolutions: impact.structures.map((row: any) => ({structureId: row.structureId,
            ...(row.activities.orphanCount ? {activities: mode === 'replace' ? {kind: 'replace', userId: h.ids.ownerA} : {kind: 'defer'}} : {}),
            ...(row.appointments.hasFutureAppointments ? {appointments: {kind: 'defer'}} : {})}))});
}
async function synchronize(id: string, date: string) {
    await locked(id, (context, board, row, tx) => core.synchronizeActivityRecurrence(context, board, row, tx, new Date(date + 'T12:00:00Z')));
}

test('future routine appears in preflight and explicit replacement supplies the first execution', async () => {
    const routine = await createRoutine();
    assert.equal((await parent(routine.id)).currentExecutionId, null);
    const impact = await preflight();
    assert.equal(site(impact).activities.recurringCount, 1);
    assert.equal(site(impact).activities.orphanCount, 1);
    failure(await h.api(h.actors.ownerA, 'PATCH', `/user/${h.ids.therapistA}/status`, {active: false,
        operationId: randomUUID(), impactFingerprint: impact.fingerprint}), 409, 'OPEN_ACTIVITIES_REQUIRE_REASSIGNMENT');
    success(await deactivate(impact));
    const updated = await parent(routine.id);
    assert.deepEqual(updated.recurrence?.template.assigneeIds, [h.ids.ownerA]);
    assert.equal(updated.recurrence?.blockedReason, null);
    await synchronize(routine.id, routine.startsOn);
    const execution = await h.activities.ActivityExecution.schema(h.schemas.a).findOne({where: {activityId: routine.id}});
    assert.deepEqual(execution?.assigneeIds, [h.ids.ownerA]);
});

test('shared future assignment removes the departed operator without blocking the routine', async () => {
    const routine = await createRoutine({assigneeIds: [h.ids.therapistA, h.ids.ownerA]});
    const impact = await preflight();
    assert.equal(site(impact).activities.orphanCount, 0);
    assert.equal(site(impact).activities.openAssignedCount, 1);
    success(await deactivate(impact));
    const updated = await parent(routine.id);
    assert.deepEqual(updated.recurrence?.template.assigneeIds, [h.ids.ownerA]);
    assert.equal(updated.recurrence?.blockedReason, null);
    await synchronize(routine.id, routine.startsOn);
    assert.ok((await parent(routine.id)).currentExecutionId);
});

test('deferring reassignment leaves a future routine visibly blocked and creates no execution', async () => {
    const routine = await createRoutine();
    success(await deactivate(await preflight(), 'defer'));
    const updated = await parent(routine.id);
    assert.deepEqual(updated.recurrence?.template.assigneeIds, []);
    assert.equal(updated.recurrence?.blockedReason, 'ASSIGNEE_REASSIGNMENT_REQUIRED');
    await synchronize(routine.id, routine.startsOn);
    assert.equal(await h.activities.ActivityExecution.schema(h.schemas.a).count({where: {activityId: routine.id}}), 0);
});

test('future reviewer departure remains explicit and cannot silently remove the approval requirement', async () => {
    const routine = await createRoutine({assigneeIds: [h.ids.ownerA], reviewerUserId: h.ids.therapistA});
    const impact = await preflight();
    assert.equal(site(impact).activities.reviewCount, 1);
    assert.equal(site(impact).activities.orphanCount, 0);
    success(await deactivate(impact));
    const updated = await parent(routine.id);
    assert.equal(updated.recurrence?.template.reviewerUserId, h.ids.therapistA);
    assert.equal(updated.recurrence?.blockedReason, 'REVIEWER_REASSIGNMENT_REQUIRED');
    await synchronize(routine.id, routine.startsOn);
    assert.equal(await h.activities.ActivityExecution.schema(h.schemas.a).count({where: {activityId: routine.id}}), 0);
});

test('future replacement with its reviewer is rejected atomically', async () => {
    const routine = await createRoutine({reviewerUserId: h.ids.ownerA});
    failure(await deactivate(await preflight()), 409, 'INVALID_ASSIGNEE');
    assert.deepEqual((await parent(routine.id)).recurrence?.template.assigneeIds, [h.ids.therapistA]);
    const member = await h.auth.TenantUser.findOne({where: {tenantId: h.ids.tenantA, userId: h.ids.therapistA}});
    assert.equal(member?.deactivatedAt, null);
});

test('closed historical participants and deadline snapshot survive future template replacement', async () => {
    const routine = await createRoutine({}, true);
    const previous = await h.activities.ActivityExecution.schema(h.schemas.a).findOne({where: {activityId: routine.id}});
    assert.ok(previous?.closedAt);
    const snapshot = structuredClone(previous.deadlineSnapshot);
    const version = previous.version;
    const impact = await preflight();
    assert.equal(site(impact).activities.recurringCount, 1);
    assert.equal(site(impact).activities.orphanCount, 1);
    success(await deactivate(impact));
    await previous.reload();
    assert.deepEqual(previous.assigneeIds, [h.ids.therapistA]);
    assert.deepEqual(previous.deadlineSnapshot, snapshot);
    assert.equal(previous.version, version);
    const updated = await parent(routine.id);
    assert.deepEqual(updated.recurrence?.template.assigneeIds, [h.ids.ownerA]);
    assert.ok(updated.recurrence?.nextDate);
    await synchronize(routine.id, updated.recurrence.nextDate);
    const next = await h.activities.ActivityExecution.schema(h.schemas.a).findOne({where: {activityId: routine.id,
        occurrenceDate: updated.recurrence.nextDate}});
    assert.deepEqual(next?.assigneeIds, [h.ids.ownerA]);
    await previous.reload();
    assert.deepEqual(previous.deadlineSnapshot, snapshot);
});

test('a future template change invalidates preflight without partially offboarding its member', async () => {
    const routine = await createRoutine();
    const impact = await preflight();
    const row = await parent(routine.id);
    assert.ok(row.recurrence);
    await row.update({recurrence: {...row.recurrence, template: {...row.recurrence.template, title: 'New routine instruction'}}, version: row.version + 1});
    failure(await deactivate(impact), 409, 'OFFBOARDING_IMPACT_CHANGED');
    const member = await h.auth.TenantUser.findOne({where: {tenantId: h.ids.tenantA, userId: h.ids.therapistA}});
    assert.equal(member?.deactivatedAt, null);
    assert.deepEqual((await parent(routine.id)).recurrence?.template.assigneeIds, [h.ids.therapistA]);
});
