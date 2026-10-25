import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {after, before, test} from 'node:test';
import {createActivitiesHarness, type ActivitiesHarness, type ApiResult} from './activitiesTestHarness.js';

let h: ActivitiesHarness;
before(async () => {h = await createActivitiesHarness();}, {timeout: 180_000});
after(async () => {if (h) await h.cleanup();}, {timeout: 60_000});
const command = () => ({operationId: randomUUID()});
function ok(result: ApiResult, status = 200) {assert.equal(result.status, status, JSON.stringify(result.body)); return result.body.data;}
function denied(result: ApiResult, status = 403) {assert.equal(result.status, status, JSON.stringify(result.body));}
async function create(fields: Record<string, unknown> = {}, actor = h.actors.ownerA) {
    return ok(await h.api(actor, 'POST', '/activities', {...command(), title: 'Workflow ' + randomUUID(), ...fields}), 201);
}
async function detail(id: string, actor = h.actors.ownerA) {return ok(await h.api(actor, 'GET', `/activities/${id}`));}
async function patchItem(current: any, item: any, checked: boolean, actor = h.actors.ownerA, extra = {}) {
    return h.api(actor, 'PATCH', `/activities/${current.activity.id}/checklist/${item.id}`,
        {...command(), expectedVersion: item.version, changes: {checked}, ...extra});
}
async function review(current: any, action: string, actor = h.actors.ownerA, extra = {}) {
    return h.api(actor, 'POST', `/activities/${current.activity.id}/review`, {...command(), expectedVersion: current.activity.version,
        expectedOrderRevision: current.orderRevision, expectedChecklistRevision: current.activity.checklistRevision, action, ...extra});
}

test('progress and automatic completion commit with canonical card, revision and alert cancellation; replay is idempotent', async () => {
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    const created = await create({checklist: [{text: 'A'}, {text: 'B'}], alert: {scheduledAt, channels: ['inApp']}});
    const initial = await detail(created.activity.id);
    const first = ok(await patchItem(initial, initial.checklist[0], true));
    assert.equal(first.activity.status, 'IN_PROGRESS'); assert.equal(first.activity.version, 2);
    assert.equal(first.orderRevision, initial.orderRevision + 1);
    const body = {...command(), expectedVersion: initial.checklist[1].version, changes: {checked: true}};
    const url = `/activities/${created.activity.id}/checklist/${initial.checklist[1].id}`;
    const completed = ok(await h.api(h.actors.ownerA, 'PATCH', url, body));
    assert.equal(completed.activity.status, 'COMPLETED'); assert.equal(completed.activity.completedByUserId, h.ids.ownerA);
    assert.equal(completed.activity.alert.enabled, false); assert.ok(completed.activity.completedAt);
    assert.equal(completed.orderRevision, initial.orderRevision + 2);
    const replay = ok(await h.api(h.actors.ownerA, 'PATCH', url, body));
    assert.equal(replay.activity.version, completed.activity.version); assert.equal(replay.orderRevision, completed.orderRevision);
});

test('a completed checkbox needs explicit reopening and current activity version, and never reactivates an alert', async () => {
    const created = await create({checklist: [{text: 'A'}]});
    const initial = await detail(created.activity.id);
    const completed = ok(await patchItem(initial, initial.checklist[0], true));
    const checked = completed.checklist[0];
    denied(await patchItem(completed, checked, false));
    denied(await patchItem(completed, checked, false, h.actors.ownerA, {allowReopen: true, expectedActivityVersion: 1}), 409);
    const reopened = ok(await patchItem(completed, checked, false, h.actors.ownerA,
        {allowReopen: true, expectedActivityVersion: completed.activity.version}));
    assert.equal(reopened.activity.status, 'IN_PROGRESS'); assert.equal(reopened.checklist[0].checked, false);
    assert.equal(reopened.activity.completedAt, null); assert.equal(reopened.activity.reviewStatus, 'not_requested');
});

test('an assignee cannot complete or remove the reviewer, but can close after explicit authorization', async () => {
    const created = await create({assigneeIds: [h.ids.therapistA], reviewerUserId: h.ids.ownerA, checklist: [{text: 'A'}]});
    const initial = await detail(created.activity.id, h.actors.therapistA);
    const pending = ok(await patchItem(initial, initial.checklist[0], true, h.actors.therapistA));
    assert.equal(pending.activity.status, 'WAITING'); assert.equal(pending.activity.reviewStatus, 'pending');
    denied(await h.api(h.actors.therapistA, 'PATCH', `/activities/${created.activity.id}`,
        {...command(), expectedVersion: pending.activity.version, changes: {reviewerUserId: null}}));
    const moveBody = () => ({...command(), expectedVersion: pending.activity.version, expectedOrderRevision: pending.orderRevision,
        expectedChecklistRevision: pending.activity.checklistRevision, targetStatus: 'COMPLETED', placement: {kind: 'end'}, allowIncompleteChecklist: true});
    denied(await h.api(h.actors.therapistA, 'POST', `/activities/${created.activity.id}/move`, moveBody()));
    denied(await review(pending, 'approveAndComplete', h.actors.therapistA));
    const approved = ok(await review(pending, 'authorizeCompletion'));
    assert.equal(approved.activity.status, 'WAITING'); assert.equal(approved.activity.reviewStatus, 'approved');
    const fresh = await detail(created.activity.id, h.actors.therapistA);
    assert.equal(fresh.activity.capabilities.canComplete, true);
    const completed = ok(await h.api(h.actors.therapistA, 'POST', `/activities/${created.activity.id}/move`,
        {...moveBody(), expectedVersion: fresh.activity.version, expectedOrderRevision: fresh.orderRevision}));
    assert.equal(completed.activity.status, 'COMPLETED'); assert.equal(completed.activity.completedByUserId, h.ids.therapistA);
    assert.equal(completed.activity.reviewApprovedByUserId, h.ids.ownerA);
});

test('a non-assigned designated reviewer may approve, return with a comment and change reviewer without core edit rights', async () => {
    const created = await create({reviewerUserId: h.ids.therapistA});
    const initial = await detail(created.activity.id);
    let pending = ok(await review(initial, 'request'));
    const reviewerDetail = await detail(created.activity.id, h.actors.therapistA);
    assert.equal(reviewerDetail.activity.capabilities.canReview, true); assert.equal(reviewerDetail.activity.capabilities.canEdit, false);
    denied(await review(pending, 'returnToProgress', h.actors.therapistA), 422);
    const returned = ok(await review(pending, 'returnToProgress', h.actors.therapistA, {comment: 'Correggere il risultato'}));
    assert.equal(returned.activity.status, 'IN_PROGRESS'); assert.equal(returned.activity.reviewStatus, 'not_requested');
    assert.equal((await detail(created.activity.id)).commentsPage.items[0].text, 'Correggere il risultato');
    pending = ok(await review(await detail(created.activity.id), 'request'));
    const completed = ok(await review(pending, 'approveAndComplete', h.actors.therapistA));
    assert.equal(completed.activity.status, 'COMPLETED'); assert.equal(completed.activity.reviewApprovedByUserId, h.ids.therapistA);
});

test('checklist composition recalculates completion, empty lists stay open and text edits never resubmit a returned task', async () => {
    const created = await create({reviewerUserId: h.ids.therapistA, checklist: [{text: 'A'}, {text: 'B'}]});
    let current = await detail(created.activity.id);
    current = ok(await patchItem(current, current.checklist[0], true));
    const second = current.checklist[1];
    current = ok(await h.api(h.actors.ownerA, 'DELETE', `/activities/${created.activity.id}/checklist/${second.id}`,
        {...command(), expectedVersion: second.version, expectedChecklistRevision: current.checklistRevision}));
    assert.equal(current.activity.status, 'WAITING'); assert.equal(current.activity.reviewStatus, 'pending');
    ok(await review(current, 'returnToProgress', h.actors.therapistA, {comment: 'Da correggere'}));
    current = await detail(created.activity.id);
    const textOnly = ok(await h.api(h.actors.ownerA, 'PATCH', `/activities/${created.activity.id}/checklist/${current.checklist[0].id}`,
        {...command(), expectedVersion: current.checklist[0].version, changes: {text: 'A corretta'}}));
    assert.equal(textOnly.activity.status, 'IN_PROGRESS'); assert.equal(textOnly.activity.reviewStatus, 'not_requested');
    const empty = ok(await h.api(h.actors.ownerA, 'DELETE', `/activities/${created.activity.id}/checklist/${textOnly.checklist[0].id}`,
        {...command(), expectedVersion: textOnly.checklist[0].version, expectedChecklistRevision: textOnly.checklistRevision}));
    assert.equal(empty.activity.status, 'IN_PROGRESS'); assert.equal(empty.checklist.length, 0);
});

test('work changes revoke approval, metadata changes preserve it and a new open step returns to progress', async () => {
    const created = await create({reviewerUserId: h.ids.therapistA});
    let pending = ok(await review(await detail(created.activity.id), 'request'));
    let approved = ok(await review(pending, 'authorizeCompletion', h.actors.therapistA));
    approved = ok(await h.api(h.actors.ownerA, 'PATCH', `/activities/${created.activity.id}`,
        {...command(), expectedVersion: approved.activity.version, changes: {priority: 'HIGH'}}));
    assert.equal(approved.activity.reviewStatus, 'approved');
    const changed = ok(await h.api(h.actors.ownerA, 'PATCH', `/activities/${created.activity.id}`,
        {...command(), expectedVersion: approved.activity.version, changes: {title: 'Lavoro aggiornato'}}));
    assert.equal(changed.activity.reviewStatus, 'not_requested'); assert.equal(changed.activity.status, 'IN_PROGRESS');
    pending = ok(await review(await detail(created.activity.id), 'request'));
    const added = ok(await h.api(h.actors.ownerA, 'POST', `/activities/${created.activity.id}/checklist`,
        {...command(), expectedChecklistRevision: pending.activity.checklistRevision, text: 'Nuovo passaggio'}), 201);
    assert.equal(added.activity.status, 'IN_PROGRESS'); assert.equal(added.activity.reviewStatus, 'not_requested');
});

test('reviewers must be eligible and distinct; archived work and stale reviews are rejected', async () => {
    denied(await h.api(h.actors.ownerA, 'POST', '/activities', {...command(), title: 'Invalid', reviewerUserId: h.ids.ownerA}), 422);
    denied(await h.api(h.actors.ownerA, 'POST', '/activities', {...command(), title: 'Invalid', reviewerUserId: h.ids.viewerA}), 422);
    const created = await create({reviewerUserId: h.ids.therapistA});
    const initial = await detail(created.activity.id), pending = ok(await review(initial, 'request'));
    denied(await review(initial, 'approveAndComplete', h.actors.therapistA), 409);
    ok(await h.api(h.actors.ownerA, 'POST', `/activities/${created.activity.id}/archive`,
        {...command(), expectedVersion: pending.activity.version, expectedOrderRevision: pending.orderRevision}));
    denied(await review(await detail(created.activity.id), 'approveAndComplete', h.actors.therapistA));
});

test('the additive review migration upgrades an existing board idempotently without completing old checked work', async () => {
    const schema = 'rehablo_' + randomUUID().replaceAll('-', ''); h.extraSchemas.push(schema);
    await h.sequelize.query(`CREATE SCHEMA "${schema}"`);
    await h.activitiesMigration.up(h.sequelize.getQueryInterface(), {schema});
    const board = await h.activities.ActivityBoard.schema(schema).create({structureId: h.ids.structureA, timezone: 'Europe/Rome'});
    const id = randomUUID();
    await h.sequelize.query(`INSERT INTO "${schema}"."activities" ("id", "boardId", "title", "status", "priority", "position", "createdByUserId")
        VALUES (:id, :boardId, 'Lavoro preesistente', 'TODO', 'NORMAL', 1024, :userId)`, {replacements: {id, boardId: board.id, userId: h.ids.ownerA}});
    await h.activities.ActivityChecklistItem.schema(schema).create({activityId: id, text: 'Già spuntata', position: '1024',
        checked: true, checkedByUserId: h.ids.ownerA, checkedAt: new Date(), createdByUserId: h.ids.ownerA, version: 1});
    const require = createRequire(import.meta.url);
    const migration = require('../../../../migrations/20261024-activities-review.js');
    await migration.up(h.sequelize.getQueryInterface(), {schema});
    await migration.up(h.sequelize.getQueryInterface(), {schema});
    const existing = await h.activities.Activity.schema(schema).findByPk(id);
    assert.equal(existing!.status, 'TODO'); assert.equal(existing!.reviewerUserId, null);
    assert.equal(existing!.reviewStatus, 'not_requested'); assert.equal(existing!.reviewApprovedAt, null);
});

test('removing the final check returns even an ordinary waiting activity to progress', async () => {
    const created = await create({checklist: [{text: 'A'}, {text: 'B'}]});
    let current = await detail(created.activity.id);
    current = ok(await patchItem(current, current.checklist[0], true));
    ok(await h.api(h.actors.ownerA, 'POST', `/activities/${created.activity.id}/move`, {...command(), expectedVersion: current.activity.version,
        expectedOrderRevision: current.orderRevision, targetStatus: 'WAITING', placement: {kind: 'end'}}));
    current = await detail(created.activity.id);
    const unchecked = ok(await patchItem(current, current.checklist[0], false));
    assert.equal(unchecked.activity.status, 'IN_PROGRESS'); assert.equal(unchecked.activity.checklistProgress.checked, 0);
});

test('operator search finds surname and name in reverse order with extra spaces', async () => {
    const user = await h.auth.User.findByPk(h.ids.ownerA);
    const search = encodeURIComponent(`  ${user!.get('surname')}   ${user!.get('name')}  `);
    const page = ok(await h.api(h.actors.ownerA, 'GET', `/activities/assignees?search=${search}`));
    assert.ok(page.items.some((person: any) => person.id === h.ids.ownerA));
});
