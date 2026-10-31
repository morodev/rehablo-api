import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after, before, test} from 'node:test';
import type {Transaction} from 'sequelize';
import {createActivitiesHarness, type ActivitiesHarness} from './activitiesTestHarness.js';
import type {Activity, ActivityBoard} from '../models/index.js';
import type {ActivityRecurrenceContext} from '../services/activityRecurrence.service.js';
import type {ActivityRecurrenceRule, ActivityRecurrenceTemplate} from '../utils/activityRecurrence.policy.js';

let h: ActivitiesHarness;
let core: typeof import('../services/activityRecurrence.service.js');
let policy: typeof import('../utils/activityRecurrence.policy.js');
let gate: typeof import('../../../utils/tenantActivityGate.js');
before(async () => {
    h = await createActivitiesHarness();
    core = await import('../services/activityRecurrence.service.js');
    policy = await import('../utils/activityRecurrence.policy.js');
    gate = await import('../../../utils/tenantActivityGate.js');
}, {timeout: 180_000});
after(async () => {if (h) await h.cleanup();}, {timeout: 60_000});

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

async function createRoutine(overrides: Partial<ActivityRecurrenceRule> = {}, templateChanges: Partial<ActivityRecurrenceTemplate> = {}) {
    const response = await h.api(h.actors.ownerA, 'POST', '/activities', {operationId: randomUUID(), title: 'Routine ' + randomUUID()});
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const id = response.body.data.activity.id;
    const template: ActivityRecurrenceTemplate = {title: response.body.data.activity.title, description: 'Istruzioni permanenti', priority: 'NORMAL',
        assigneeIds: [h.ids.ownerA], reviewerUserId: null, patientId: null, agendaEventId: null,
        checklist: [{text: 'Controllo A'}, {text: 'Controllo B'}], ...templateChanges};
    const rule: ActivityRecurrenceRule = {frequency: 'daily', interval: 1, startsOn: '2030-03-30', endsOn: null, ...overrides};
    await locked(id, (context, board, parent, tx) => core.configureActivityRecurrence(parent, rule, template, board, context, tx, new Date('2030-03-30T09:00:00Z')));
    return {id, template, rule};
}

async function synchronize(id: string, at: string) {
    await locked(id, (context, board, parent, tx) => core.synchronizeActivityRecurrence(context, board, parent, tx, new Date(at)));
    return h.activities.Activity.schema(h.schemas.a).findByPk(id);
}
async function executions(id: string) {
    return h.activities.ActivityExecution.schema(h.schemas.a).findAll({where: {activityId: id}, order: [['occurrenceDate', 'ASC']]});
}

test('standard-provisioned tenants pass recurrence readiness without a legacy migration receipt', async () => {
    const {inspectActivities} = await import('../../../scripts/migrateActivities.js');
    for (const schema of [h.schemas.a, h.schemas.b]) {
        const [legacy] = await h.sequelize.query(`SELECT 1 FROM "${schema}"."schema_migrations" WHERE "version"=:version`,
            {replacements: {version: '20261031-activity-recurrences'}});
        assert.equal(legacy.length, 0, 'The regression must exercise the managed migration path, before the legacy CLI writes its receipt.');
        const [managed] = await h.sequelize.query(`SELECT 1 FROM "${schema}"."SequelizeMeta" WHERE "name"=:name`,
            {replacements: {name: '202610310002-activity-recurrences.js'}});
        assert.equal(managed.length, 1);
        const report = await inspectActivities(h.sequelize, schema);
        assert.equal(report.recurrenceVersionApplied, true);
        assert.equal(report.ready, true, JSON.stringify(report));
    }
});

test('a managed recurrence receipt cannot hide missing physical schema metadata', async () => {
    const {inspectActivities} = await import('../../../scripts/migrateActivities.js');
    await assert.rejects(() => h.sequelize.transaction(async transaction => {
        await h.sequelize.query(`DROP INDEX "${h.schemas.a}"."activity_executions_activity_date_unique"`, {transaction});
        const report = await inspectActivities({query: (sql, options = {}) => h.sequelize.query(sql, {...options, transaction})}, h.schemas.a);
        assert.equal(report.recurrenceVersionApplied, true);
        assert.equal(report.ready, false);
        assert.ok(report.missingIndexes.includes('activity_executions_activity_date_unique'));
        throw new Error('rollback readiness fixture');
    }), /rollback readiness fixture/);
    assert.equal((await inspectActivities(h.sequelize, h.schemas.a)).ready, true);
});

test('one stable card rolls forward with its original work frozen and new unchecked items', async () => {
    const {id} = await createRoutine();
    const initial = (await executions(id))[0];
    assert.equal(initial.occurrenceDate, '2030-03-30');
    await locked(id, async (context, board, parent, tx) => {
        const items = await h.activities.ActivityChecklistItem.schema(h.schemas.a).findAll({where: {activityId: id, executionId: initial.id}, order: [['position', 'ASC']], transaction: tx});
        await items[0].update({checked: true, checkedByUserId: h.ids.ownerA, checkedAt: new Date('2030-03-30T10:00:00Z')}, {transaction: tx});
        await parent.update({status: 'IN_PROGRESS', checklistRevision: parent.checklistRevision + 1}, {transaction: tx});
        await core.captureCurrentExecution({...context, userId: h.ids.ownerA}, parent, tx, new Date('2030-03-30T10:00:00Z'));
        await h.activities.ActivityComment.schema(h.schemas.a).create({activityId: id, executionId: initial.id,
            authorUserId: h.ids.ownerA, text: 'Nota solo del primo giorno'}, {transaction: tx});
    });
    const parent = await synchronize(id, '2030-03-31T08:00:00Z');
    assert.ok(parent);
    assert.equal(await h.activities.Activity.schema(h.schemas.a).count({where: {id}}), 1);
    assert.equal(parent.status, 'TODO');
    assert.notEqual(parent.currentExecutionId, initial.id);
    const days = await executions(id);
    assert.equal(days.length, 2);
    assert.equal(days[0].deadlineSnapshot?.outcome, 'partial');
    assert.equal((days[0].deadlineSnapshot?.checklist as any[])[0].checked, true);
    assert.equal(days[1].closedAt, null);
    const items = await h.activities.ActivityChecklistItem.schema(h.schemas.a).findAll({where: {activityId: id, executionId: days[1].id}});
    assert.equal(items.length, 2); assert.ok(items.every(item => !item.checked));
    assert.equal(await h.activities.ActivityComment.schema(h.schemas.a).count({where: {activityId: id, executionId: days[1].id}}), 0);
});

test('weekly execution is sealed at its own midnight without starting the following week early', async () => {
    const {id} = await createRoutine({frequency: 'weekly'});
    const first = (await executions(id))[0];
    await synchronize(id, '2030-04-01T09:00:00Z');
    const days = await executions(id);
    assert.equal(days.length, 1);
    assert.ok(days[0].closedAt);
    assert.equal(days[0].closedAt?.toISOString(), '2030-03-30T23:00:00.000Z');
    const parent = await h.activities.Activity.schema(h.schemas.a).findByPk(id);
    assert.equal(parent?.currentExecutionId, first.id);
    assert.equal(parent?.recurrence?.nextDate, '2030-04-06');
});

test('future first date remains a planned routine with no execution before its day', async () => {
    const {id} = await createRoutine({startsOn: '2030-04-03'});
    assert.equal((await executions(id)).length, 0);
    await synchronize(id, '2030-04-02T10:00:00Z');
    assert.equal((await executions(id)).length, 0);
    const parent = await synchronize(id, '2030-04-03T00:00:00Z');
    assert.ok(parent?.currentExecutionId);
    assert.equal((await executions(id))[0].occurrenceDate, '2030-04-03');
});

test('concurrent runs create one execution per scheduled date and never duplicate the card', async () => {
    const {id} = await createRoutine();
    await Promise.all([synchronize(id, '2030-04-01T09:00:00Z'), synchronize(id, '2030-04-01T09:00:00Z')]);
    const days = await executions(id);
    assert.deepEqual(days.map(day => day.occurrenceDate), ['2030-03-30', '2030-03-31', '2030-04-01']);
    assert.equal(new Set(days.map(day => day.id)).size, 3);
    assert.equal(await h.activities.Activity.schema(h.schemas.a).count({where: {id}}), 1);
});

test('a failed transaction does not advance the cursor, close snapshots or leave a half-created day', async () => {
    const {id} = await createRoutine();
    await assert.rejects(locked(id, async (context, board, parent, tx) => {
        await core.synchronizeActivityRecurrence(context, board, parent, tx, new Date('2030-04-01T09:00:00Z'));
        throw new Error('Rollback fixture');
    }), /Rollback fixture/);
    const days = await executions(id);
    assert.equal(days.length, 1); assert.equal(days[0].closedAt, null);
    assert.equal((await h.activities.Activity.schema(h.schemas.a).findByPk(id))?.recurrence?.nextDate, '2030-03-31');
});

test('recovering after the inclusive end preserves all missed days and then ends generation', async () => {
    const {id} = await createRoutine({endsOn: '2030-04-01'});
    const parent = await synchronize(id, '2030-04-05T09:00:00Z');
    const days = await executions(id);
    assert.deepEqual(days.map(day => day.occurrenceDate), ['2030-03-30', '2030-03-31', '2030-04-01']);
    assert.ok(days.every(day => day.closedAt && day.deadlineSnapshot?.outcome === 'not_recorded'));
    assert.equal(parent?.recurrence?.status, 'ended');
    assert.equal(parent?.recurrence?.nextDate, null);
    await synchronize(id, '2030-05-05T09:00:00Z');
    assert.equal((await executions(id)).length, 3);
});

test('stopped routines do not backfill; archiving only an execution does not stop its next day', async () => {
    const stopped = await createRoutine();
    await locked(stopped.id, (_context, _board, parent, tx) => core.stopActivityRecurrence(parent, tx));
    await synchronize(stopped.id, '2030-04-05T09:00:00Z');
    assert.equal((await executions(stopped.id)).length, 1);

    const running = await createRoutine();
    const first = (await executions(running.id))[0];
    await first.update({archivedAt: new Date('2030-03-30T11:00:00Z'), archivedByUserId: h.ids.ownerA});
    const parent = await synchronize(running.id, '2030-03-31T09:00:00Z');
    assert.equal(parent?.archivedAt, null);
    assert.equal(parent?.recurrence?.status, 'active');
    assert.equal((await executions(running.id)).length, 2);
    assert.equal((await executions(running.id))[0].deadlineSnapshot?.outcome, 'archived');
});

test('deadline snapshot is immutable and never stores comment text that could be deleted', async () => {
    const {id} = await createRoutine({frequency: 'weekly'});
    const first = (await executions(id))[0];
    const comment = await h.activities.ActivityComment.schema(h.schemas.a).create({activityId: id, executionId: first.id,
        authorUserId: h.ids.ownerA, text: 'Contenuto da rimuovere'});
    await synchronize(id, '2030-03-31T09:00:00Z');
    const sealed = (await executions(id))[0];
    const original = JSON.stringify(sealed.deadlineSnapshot);
    assert.ok(!original.includes('Contenuto da rimuovere'));
    await comment.update({text: null, deletedAt: new Date()});
    await sealed.update({status: 'COMPLETED', completedAt: new Date('2030-04-01T09:00:00Z'), completedByUserId: h.ids.ownerA,
        lateUpdatedAt: new Date('2030-04-01T09:00:00Z'), lateUpdatedByUserId: h.ids.ownerA});
    await synchronize(id, '2030-04-01T10:00:00Z');
    assert.equal(JSON.stringify((await executions(id))[0].deadlineSnapshot), original);
});

test('historical projection helper leaves the newer card and its current assignments intact', async () => {
    const {id} = await createRoutine();
    await synchronize(id, '2030-03-31T09:00:00Z');
    const days = await executions(id);
    await days[0].update({status: 'COMPLETED', completedAt: new Date(), completedByUserId: h.ids.ownerA, assigneeIds: [h.ids.therapistA]});
    await locked(id, (context, board, parent, tx) => core.projectExecution(context, board, parent, days[0], tx));
    const parent = await h.activities.Activity.schema(h.schemas.a).findByPk(id);
    assert.equal(parent?.status, 'TODO');
    assert.equal(parent?.currentExecutionId, days[1].id);
    const ids = await h.activities.ActivityAssignment.schema(h.schemas.a).findAll({where: {activityId: id}});
    assert.deepEqual(ids.map(row => row.userId), [h.ids.ownerA]);
});

test('a missing last assignee blocks generation and does not silently discard future ownership', async () => {
    const missing = randomUUID();
    const {id} = await createRoutine({}, {assigneeIds: [missing]});
    const parent = await h.activities.Activity.schema(h.schemas.a).findByPk(id);
    assert.equal(parent?.recurrence?.blockedReason, 'ASSIGNEE_UNAVAILABLE');
    assert.deepEqual(parent?.recurrence?.template.assigneeIds, [missing]);
    assert.equal((await executions(id)).length, 0);
});

test('missing reviewers block generation without silently removing the approval requirement', async () => {
    const missing = randomUUID();
    const {id} = await createRoutine({}, {reviewerUserId: missing});
    const parent = await h.activities.Activity.schema(h.schemas.a).findByPk(id);
    assert.equal(parent?.recurrence?.blockedReason, 'REVIEWER_UNAVAILABLE');
    assert.equal(parent?.recurrence?.template.reviewerUserId, missing);
    assert.equal((await executions(id)).length, 0);
});
