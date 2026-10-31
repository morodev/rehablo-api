import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after, before, test} from 'node:test';
import {createActivitiesHarness, type ActivitiesHarness, type ApiResult} from './activitiesTestHarness.js';

let h: ActivitiesHarness;
let core: typeof import('../services/activityRecurrence.service.js');
let policy: typeof import('../utils/activityRecurrence.policy.js');
before(async () => {
    h = await createActivitiesHarness();
    core = await import('../services/activityRecurrence.service.js');
    policy = await import('../utils/activityRecurrence.policy.js');
}, {timeout: 180_000});
after(async () => {if (h) await h.cleanup();}, {timeout: 60_000});
const command = () => ({operationId: randomUUID()});
function ok(result: ApiResult, status = 200) {assert.equal(result.status, status, JSON.stringify(result.body)); return result.body.data;}
function denied(result: ApiResult, status = 409) {assert.equal(result.status, status, JSON.stringify(result.body));}
function date(offset = 0) {return policy.recurrenceLocalDate(new Date(Date.now() + offset * 86_400_000), 'Europe/Rome');}
function rule(startsOn = date(), frequency: 'daily' | 'weekly' = 'daily') {return {frequency, interval: 1, startsOn, endsOn: null};}
function templateInput(template: any) {
    const {title, description, priority, assigneeIds, reviewerUserId, patientId, agendaEventId, checklist} = template;
    return {title, description, priority, assigneeIds, reviewerUserId, patientId, agendaEventId, checklist};
}
async function create(fields: Record<string, unknown> = {}) {
    return ok(await h.api(h.actors.ownerA, 'POST', '/activities', {...command(), title: 'Recurring ' + randomUUID(),
        recurrence: rule(), checklist: [{text: 'A'}, {text: 'B'}], ...fields}), 201);
}
async function detail(id: string, executionId?: string, actor = h.actors.ownerA) {
    return ok(await h.api(actor, 'GET', `/activities/${id}${executionId ? '/executions/' + executionId : ''}`));
}
async function cycleFixture(review = false) {
    const result = ok(await h.api(h.actors.ownerA, 'POST', '/activities', {...command(), title: 'Historical routine'}), 201);
    const id = result.activity.id;
    await h.sequelize.transaction(async transaction => {
        const board = await h.activities.ActivityBoard.schema(h.schemas.a).findOne({where: {structureId: h.ids.structureA}, transaction, lock: transaction.LOCK.UPDATE});
        const parent = await h.activities.Activity.schema(h.schemas.a).findByPk(id, {transaction});
        assert.ok(board && parent);
        const context = {schema: h.schemas.a, tenantId: h.ids.tenantA, structureId: h.ids.structureA, timezone: board.timezone, userId: h.ids.ownerA};
        await core.configureActivityRecurrence(parent, rule(date(-1)), {title: parent.title, description: null, priority: 'NORMAL',
            assigneeIds: [h.ids.therapistA], reviewerUserId: review ? h.ids.ownerA : null, patientId: null, agendaEventId: null,
            checklist: [{text: 'A'}, {text: 'B'}]}, board, context, transaction, new Date(Date.now() - 86_400_000));
        const first = await h.activities.ActivityChecklistItem.schema(h.schemas.a).findOne({where: {executionId: parent.currentExecutionId}, transaction});
        assert.ok(first);
        await first.update({checked: true, checkedByUserId: h.ids.therapistA, checkedAt: new Date(Date.now() - 80_000_000)}, {transaction});
        await parent.update({status: 'IN_PROGRESS', checklistRevision: parent.checklistRevision + 1}, {transaction});
        await core.captureCurrentExecution(context, parent, transaction, new Date(Date.now() - 79_000_000));
        await core.synchronizeActivityRecurrence(context, board, parent, transaction);
    });
    const rows = await h.activities.ActivityExecution.schema(h.schemas.a).findAll({where: {activityId: id}, order: [['occurrenceDate', 'ASC']]});
    assert.equal(rows.length, 2);
    return {id, old: rows[0], current: rows[1]};
}

test('public recurrence creation makes one current card and rejects commands with no execution identity', async () => {
    const created = await create(), current = await detail(created.activity.id);
    assert.ok(current.activity.currentExecutionId);
    assert.equal(current.activity.executionDate, date());
    assert.equal(current.checklist.length, 2);
    const url = `/activities/${created.activity.id}/checklist/${current.checklist[0].id}`;
    denied(await h.api(h.actors.ownerA, 'PATCH', url, {...command(), expectedVersion: 1, changes: {checked: true}}));
    const response = ok(await h.api(h.actors.ownerA, 'PATCH', url, {...command(), expectedExecutionId: current.activity.currentExecutionId,
        expectedVersion: 1, changes: {checked: true}}));
    assert.equal(response.activity.status, 'IN_PROGRESS');
    const stored = await h.activities.ActivityExecution.schema(h.schemas.a).findByPk(current.activity.currentExecutionId);
    assert.equal(stored?.status, 'IN_PROGRESS');
    assert.equal(await h.activities.Activity.schema(h.schemas.a).count({where: {id: created.activity.id}}), 1);
});

test('future routines stay out of the normal board until their first day and remain configurable', async () => {
    const created = await create({recurrence: rule(date(2))});
    assert.equal(created.activity.currentExecutionId, null);
    const board = ok(await h.api(h.actors.ownerA, 'GET', '/activities?view=list'));
    assert.ok(!board.items.some((item: any) => item.id === created.activity.id));
    const routines = ok(await h.api(h.actors.ownerA, 'GET', '/activities?view=recurring'));
    assert.ok(routines.items.some((item: any) => item.id === created.activity.id));
    denied(await h.api(h.actors.ownerA, 'POST', `/activities/${created.activity.id}/comments`, {...command(), expectedExecutionId: null, text: 'Too early'}));
    const changed = ok(await h.api(h.actors.ownerA, 'PATCH', `/activities/${created.activity.id}`, {...command(),
        expectedVersion: created.activity.version, changes: {recurrence: rule(date(3)),
            recurrenceTemplate: {...templateInput(created.activity.recurrence.template), title: 'Future instructions'}}}));
    assert.equal(changed.activity.recurrence.template.title, 'Future instructions');
    const history = ok(await h.api(h.actors.ownerA, 'GET', `/activities/${created.activity.id}/history?scope=routine`));
    assert.ok(history.items.some((item: any) => item.eventType === 'RECURRENCE_UPDATED'));
});

test('historical checklist corrections keep the deadline snapshot and do not touch the new card or board order', async () => {
    const fixture = await cycleFixture();
    const today = await detail(fixture.id), past = await detail(fixture.id, fixture.old.id, h.actors.therapistA);
    assert.equal(past.execution.outcomeAtDeadline, 'partial');
    const immutable = JSON.stringify(past.execution.deadlineSnapshot);
    const unchecked = past.checklist.find((item: any) => !item.checked);
    const path = `/activities/${fixture.id}/executions/${fixture.old.id}/checklist/${unchecked.id}`;
    const body = {...command(), expectedExecutionId: fixture.old.id, expectedVersion: unchecked.version, changes: {checked: true}};
    const completed = ok(await h.api(h.actors.therapistA, 'PATCH', path, body));
    assert.equal(completed.activity.status, 'COMPLETED');
    assert.equal(completed.executionId, fixture.old.id);
    const fresh = await detail(fixture.id);
    assert.equal(fresh.activity.version, today.activity.version);
    assert.equal(fresh.activity.status, 'TODO');
    assert.equal(fresh.activity.position, today.activity.position);
    assert.equal(fresh.orderRevision, today.orderRevision);
    assert.ok(fresh.checklist.every((item: any) => !item.checked));
    const updatedPast = await detail(fixture.id, fixture.old.id);
    assert.equal(JSON.stringify(updatedPast.execution.deadlineSnapshot), immutable);
    assert.ok(updatedPast.execution.lateUpdatedAt);
    assert.equal(updatedPast.execution.lateUpdatedByUserId, h.ids.therapistA);
    assert.equal(updatedPast.execution.lateUpdatedBy.name, 'Integration');
    const replay = ok(await h.api(h.actors.therapistA, 'PATCH', path, body));
    assert.equal(replay.executionId, fixture.old.id);
    assert.equal(replay.activity.currentExecutionId, fixture.old.id);
    assert.equal(replay.activity.status, 'COMPLETED');
    denied(await h.api(h.actors.ownerA, 'GET', `/activities/${fixture.id}/comments?expectedExecutionId=${fixture.old.id}`));
    denied(await h.api(h.actors.ownerA, 'PATCH', `/activities/${fixture.id}/checklist/${unchecked.id}`, {...body, operationId: randomUUID()}));
});

test('historical review requires the designated reviewer and review comments belong only to that execution', async () => {
    const fixture = await cycleFixture(true);
    const past = await detail(fixture.id, fixture.old.id, h.actors.therapistA);
    const unchecked = past.checklist.find((item: any) => !item.checked);
    const pending = ok(await h.api(h.actors.therapistA, 'PATCH', `/activities/${fixture.id}/executions/${fixture.old.id}/checklist/${unchecked.id}`,
        {...command(), expectedExecutionId: fixture.old.id, expectedVersion: unchecked.version, changes: {checked: true}}));
    assert.equal(pending.activity.status, 'WAITING');
    const body = {...command(), expectedExecutionId: fixture.old.id, expectedVersion: pending.activity.version,
        expectedOrderRevision: pending.orderRevision, expectedChecklistRevision: pending.activity.checklistRevision,
        action: 'returnToProgress', comment: 'Late review correction'};
    const path = `/activities/${fixture.id}/executions/${fixture.old.id}/review`;
    denied(await h.api(h.actors.therapistA, 'POST', path, body), 403);
    ok(await h.api(h.actors.ownerA, 'POST', path, body));
    const historical = await detail(fixture.id, fixture.old.id);
    assert.equal(historical.commentsPage.items[0].text, 'Late review correction');
    assert.equal((await detail(fixture.id)).commentsPage.total, 0);
});

test('deleted historical comments never return from snapshot or idempotent replay', async () => {
    const fixture = await cycleFixture();
    const path = `/activities/${fixture.id}/executions/${fixture.old.id}/comments`;
    const body = {...command(), expectedExecutionId: fixture.old.id, text: 'Sensitive old note'};
    const added = ok(await h.api(h.actors.therapistA, 'POST', path, body), 201);
    ok(await h.api(h.actors.therapistA, 'DELETE', `${path}/${added.comment.id}`, {...command(),
        expectedExecutionId: fixture.old.id, expectedVersion: added.comment.version}));
    const replay = ok(await h.api(h.actors.therapistA, 'POST', path, body), 201);
    assert.equal(replay.comment.text, null);
    assert.ok(replay.comment.deletedAt);
    const past = await detail(fixture.id, fixture.old.id);
    assert.ok(!JSON.stringify(past.execution.deadlineSnapshot).includes('Sensitive old note'));
    assert.equal(past.activity.commentCount, 0);
    assert.equal((await detail(fixture.id)).commentsPage.total, 0);
});

test('history filters and cursors identify execution dates and distinguish deadline outcome from corrections', async () => {
    const fixture = await cycleFixture();
    const base = `/activities/${fixture.id}/executions`;
    const first = ok(await h.api(h.actors.ownerA, 'GET', base + '?limit=1'));
    assert.equal(first.total, 2); assert.equal(first.items[0].id, fixture.current.id); assert.ok(first.nextCursor);
    const second = ok(await h.api(h.actors.ownerA, 'GET', base + '?limit=1&cursor=' + encodeURIComponent(first.nextCursor)));
    assert.equal(second.items[0].id, fixture.old.id);
    const filtered = ok(await h.api(h.actors.ownerA, 'GET', base + '?outcome=partial&outcomeBasis=deadline'));
    assert.equal(filtered.items.length, 1); assert.equal(filtered.items[0].id, fixture.old.id);
    const day = ok(await h.api(h.actors.ownerA, 'GET', base + '?from=' + date() + '&to=' + date()));
    assert.equal(day.items.length, 1); assert.equal(day.items[0].id, fixture.current.id);
    const statusEvents = ok(await h.api(h.actors.ownerA, 'GET', base + '?eventType=status'));
    assert.equal(statusEvents.items.length, 2);
    denied(await h.api(h.actors.ownerA, 'GET', base + '?outcome=partial&limit=1&cursor=' + encodeURIComponent(first.nextCursor)));
});

test('archiving one execution hides the current card while stopping and restoring the routine does not resume it', async () => {
    const created = await create();
    const archived = ok(await h.api(h.actors.ownerA, 'POST', `/activities/${created.activity.id}/archive`, {...command(),
        expectedExecutionId: created.activity.currentExecutionId, expectedVersion: created.activity.version,
        expectedOrderRevision: created.orderRevision, scope: 'execution'}));
    const listing = ok(await h.api(h.actors.ownerA, 'GET', '/activities?view=list'));
    assert.ok(!listing.items.some((item: any) => item.id === created.activity.id));
    const stored = await h.activities.Activity.schema(h.schemas.a).findByPk(created.activity.id);
    assert.equal(stored?.recurrence?.status, 'active'); assert.equal(stored?.archivedAt, null);
    assert.equal((await detail(created.activity.id)).activity.capabilities.canComment, false);
    denied(await h.api(h.actors.ownerA, 'POST', `/activities/${created.activity.id}/comments`, {...command(),
        expectedExecutionId: created.activity.currentExecutionId, text: 'Archived execution is read only'}));
    const stopped = ok(await h.api(h.actors.ownerA, 'POST', `/activities/${created.activity.id}/archive`, {...command(),
        expectedExecutionId: created.activity.currentExecutionId, expectedVersion: archived.activity.version,
        expectedOrderRevision: archived.orderRevision, scope: 'routine'}));
    const restored = ok(await h.api(h.actors.ownerA, 'POST', `/activities/${created.activity.id}/restore`, {...command(),
        expectedExecutionId: created.activity.currentExecutionId, expectedVersion: stopped.activity.version, expectedOrderRevision: stopped.orderRevision}));
    assert.equal(restored.activity.recurrence.status, 'stopped');
});

test('editing future instructions preserves the current execution and ordinary activities still accept existing commands', async () => {
    const created = await create();
    const changed = ok(await h.api(h.actors.ownerA, 'PATCH', `/activities/${created.activity.id}`, {...command(),
        expectedExecutionId: created.activity.currentExecutionId, expectedVersion: created.activity.version,
        changes: {recurrence: rule(), recurrenceTemplate: {...templateInput(created.activity.recurrence.template),
            title: 'Unique future instructions', priority: 'HIGH', assigneeIds: [h.ids.therapistA], checklist: [{text: 'Future checklist'}]}}}));
    assert.equal(changed.activity.title, created.activity.title);
    assert.equal(changed.activity.recurrence.template.assignees[0].name, 'Integration');
    assert.deepEqual((await detail(created.activity.id)).checklist.map((item: any) => item.text), ['A', 'B']);
    const routineMatches = ok(await h.api(h.actors.therapistA, 'GET', '/activities?view=recurring&mine=true&priority=HIGH&search=Unique%20future%20instructions'));
    assert.ok(routineMatches.items.some((item: any) => item.id === created.activity.id));
    assert.equal(routineMatches.items.find((item: any) => item.id === created.activity.id).recurrence.template.title, 'Unique future instructions');
    const parentMatches = ok(await h.api(h.actors.therapistA, 'GET', '/activities?view=list&mine=true&priority=HIGH&search=Unique%20future%20instructions'));
    assert.ok(!parentMatches.items.some((item: any) => item.id === created.activity.id));
    const ordinary = ok(await h.api(h.actors.ownerA, 'POST', '/activities', {...command(), title: 'Ordinary'}), 201);
    assert.equal(ordinary.activity.recurrence, undefined);
    const changedOrdinary = ok(await h.api(h.actors.ownerA, 'PATCH', `/activities/${ordinary.activity.id}`, {...command(),
        expectedVersion: ordinary.activity.version, changes: {title: 'Still ordinary'}}));
    ok(await h.api(h.actors.ownerA, 'DELETE', `/activities/${ordinary.activity.id}/alert`, {...command(), expectedVersion: changedOrdinary.activity.version}));
});

test('historical assignees retain corrections after reassignment, but current membership still gates every write', async () => {
    const fixture = await cycleFixture();
    const current = await detail(fixture.id);
    ok(await h.api(h.actors.ownerA, 'PATCH', `/activities/${fixture.id}`, {...command(), expectedExecutionId: fixture.current.id,
        expectedVersion: current.activity.version, changes: {assigneeIds: [h.ids.ownerA]}}));
    assert.equal((await detail(fixture.id, undefined, h.actors.therapistA)).activity.capabilities.canEdit, false);
    const historic = await detail(fixture.id, fixture.old.id, h.actors.therapistA);
    assert.equal(historic.activity.capabilities.canEdit, true);
    const path = `/activities/${fixture.id}/executions/${fixture.old.id}/comments`;
    ok(await h.api(h.actors.therapistA, 'POST', path, {...command(), expectedExecutionId: fixture.old.id, text: 'Historic assignee'}), 201);
    await h.auth.StructureUser.update({role: 'VIEWER'}, {where: {structureId: h.ids.structureA, userId: h.ids.therapistA}});
    try {
        denied(await h.api(h.actors.therapistA, 'POST', path, {...command(), expectedExecutionId: fixture.old.id, text: 'No longer permitted'}), 403);
        assert.equal((await detail(fixture.id, fixture.old.id, h.actors.therapistA)).activity.capabilities.canComment, false);
    } finally {
        await h.auth.StructureUser.update({role: null}, {where: {structureId: h.ids.structureA, userId: h.ids.therapistA}});
    }
    const eventPage = ok(await h.api(h.actors.ownerA, 'GET', `/activities/${fixture.id}/executions?eventType=comments`));
    assert.deepEqual(eventPage.items.map((item: any) => item.id), [fixture.old.id]);
});

test('a weekly closed day requires explicit historical targeting before the following occurrence', async () => {
    const created = await create({recurrence: rule(date(), 'weekly')});
    const id = created.activity.id, executionId = created.activity.currentExecutionId;
    ok(await h.api(h.actors.ownerA, 'POST', `/activities/${id}/comments`,
        {...command(), expectedExecutionId: executionId, text: 'Comment before closing'}), 201);
    await h.sequelize.transaction(async transaction => {
        const parent = await h.activities.Activity.schema(h.schemas.a).findByPk(id, {transaction});
        const execution = await h.activities.ActivityExecution.schema(h.schemas.a).findByPk(executionId, {transaction});
        assert.ok(parent && execution);
        // Close the fixture's current day while preserving its identity during the weekly gap.
        await core.sealActivityExecution({schema: h.schemas.a, tenantId: h.ids.tenantA, structureId: h.ids.structureA,
            timezone: 'Europe/Rome'}, parent, execution, transaction, new Date(Date.now() + 86_400_000));
    });
    const current = await detail(id);
    assert.equal(current.activity.capabilities.canComment, false);
    assert.equal(current.commentsPage.items[0].capabilities.canEdit, false);
    assert.equal((await detail(id, executionId)).commentsPage.items[0].capabilities.canEdit, true);
    ok(await h.api(h.actors.ownerA, 'PATCH', `/activities/${id}`, {...command(), expectedExecutionId: executionId,
        expectedVersion: current.activity.version, changes: {recurrence: rule(date(), 'weekly'),
            recurrenceTemplate: {...templateInput(current.activity.recurrence.template), title: 'Only future instructions change'}}}));
    assert.equal((await detail(id, executionId)).execution.lateUpdatedAt, null);
    denied(await h.api(h.actors.ownerA, 'POST', `/activities/${id}/comments`, {...command(), expectedExecutionId: executionId, text: 'Stale current form'}));
    ok(await h.api(h.actors.ownerA, 'POST', `/activities/${id}/executions/${executionId}/comments`,
        {...command(), expectedExecutionId: executionId, text: 'Explicit late correction'}), 201);
    assert.equal((await detail(id)).activity.currentExecutionId, executionId);
});

test('only active routines bypass the completed cutoff while ended and stopped routines remain in their own view', async () => {
    const ids: Record<string, string> = {};
    for (const status of ['active', 'ended', 'stopped'] as const) {
        const created = await create(), activity = await h.activities.Activity.schema(h.schemas.a).findByPk(created.activity.id);
        assert.ok(activity?.recurrence);
        ids[status] = activity.id;
        const completedAt = new Date(Date.now() - 40 * 86_400_000);
        const completed = await h.activities.Activity.schema(h.schemas.a).findAll({where: {boardId: activity.boardId, status: 'COMPLETED', archivedAt: null}});
        const position = String(completed.reduce((maximum, row) => BigInt(row.position) > maximum ? BigInt(row.position) : maximum, 0n) + 1024n);
        const state = {status: 'COMPLETED', position, completedAt, completedByUserId: h.ids.ownerA, dueDate: date(-40)};
        await activity.update({...state, recurrence: {...activity.recurrence, startsOn: date(-40), interval: 60,
            nextDate: status === 'active' ? date(20) : null, status}});
        await h.activities.ActivityExecution.schema(h.schemas.a).update({...state, occurrenceDate: date(-40)},
            {where: {id: activity.currentExecutionId!}});
    }
    const ordinary = ok(await h.api(h.actors.ownerA, 'GET', '/activities?view=list&limit=200'));
    assert.ok(ordinary.items.some((item: any) => item.id === ids.active));
    assert.ok(!ordinary.items.some((item: any) => item.id === ids.ended || item.id === ids.stopped));
    const routines = ok(await h.api(h.actors.ownerA, 'GET', '/activities?view=recurring&limit=200'));
    assert.ok(Object.values(ids).every(id => routines.items.some((item: any) => item.id === id)));
});
