import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after, before, test} from 'node:test';
import {createActivitiesHarness, type ActivitiesHarness, type ApiResult} from './activitiesTestHarness.js';

let h: ActivitiesHarness;
before(async () => {h = await createActivitiesHarness();}, {timeout: 180_000});
after(async () => {if (h) await h.cleanup();}, {timeout: 60_000});
const ok = (result: ApiResult, status = 200) => {
    assert.equal(result.status, status, JSON.stringify(result.body)); assert.equal(result.body.status, 'success'); return result.body.data;
};
const fail = (result: ApiResult, status: number, code: string) => {
    assert.equal(result.status, status, JSON.stringify(result.body)); assert.equal(result.body.error?.code, code, JSON.stringify(result.body));
};
const command = () => ({operationId: randomUUID()});
async function create(fields: Record<string, unknown> = {}) {
    return ok(await h.api(h.actors.ownerA, 'POST', '/activities', {...command(), title: 'Collaboration ' + randomUUID(), ...fields}), 201);
}
async function detail(id: string, actor = h.actors.ownerA) {return ok(await h.api(actor, 'GET', `/activities/${id}`));}
async function add(id: string, revision: number, text = 'Passo') {
    return ok(await h.api(h.actors.ownerA, 'POST', `/activities/${id}/checklist`, {...command(), expectedChecklistRevision: revision, text}), 201);
}
async function comment(id: string, text = 'Commento', actor = h.actors.ownerA) {
    return ok(await h.api(actor, 'POST', `/activities/${id}/comments`, {...command(), text}), 201);
}

test('checklist CRUD increments aggregate/snapshot and preserves core/order versions and actor summaries', async () => {
    const initial = await create(), id = initial.activity.id;
    const first = await add(id, 0, 'Controllo');
    assert.equal(first.checklistRevision, 1); assert.equal(first.snapshotRevision, initial.snapshotRevision + 1);
    assert.equal(first.item.createdBy.id, h.ids.ownerA); assert.equal(first.item.checkedBy, null);
    const checked = ok(await h.api(h.actors.ownerA, 'PATCH', `/activities/${id}/checklist/${first.item.id}`,
        {...command(), expectedVersion: 1, changes: {checked: true, text: 'Verificato'}}));
    assert.equal(checked.item.version, 2); assert.equal(checked.item.checkedBy.id, h.ids.ownerA); assert.ok(checked.item.checkedAt);
    const current = await detail(id);
    assert.equal(current.activity.version, 1); assert.equal(current.orderRevision, initial.orderRevision);
    assert.equal(current.activity.checklistProgress.checked, 1); assert.equal(current.activity.checklistRevision, 2);
    assert.equal(current.historyPage.items[0].actor.id, h.ids.ownerA);
    assert.deepEqual(current.history, current.historyPage.items);
    const removed = ok(await h.api(h.actors.ownerA, 'DELETE', `/activities/${id}/checklist/${first.item.id}`,
        {...command(), expectedVersion: 2, expectedChecklistRevision: 2}));
    assert.equal(removed.item, null); assert.equal(removed.checklist.length, 0); assert.equal(removed.checklistRevision, 3);
    const get = ok(await h.api(h.actors.ownerA, 'GET', `/activities/${id}/checklist`));
    assert.equal(get.items.length, 0); assert.equal(get.checklistRevision, 3);
});

test('independent checklist item patches succeed concurrently while same-item version conflict is explicit', async () => {
    const {activity} = await create({checklist: [{text: 'A'}, {text: 'B'}]});
    const original = await detail(activity.id);
    const [a, b] = original.checklist;
    const results = await Promise.all([a, b].map(item => h.api(h.actors.ownerA, 'PATCH', `/activities/${activity.id}/checklist/${item.id}`,
        {...command(), expectedVersion: 1, changes: {checked: true}})));
    results.forEach(result => ok(result));
    const current = await detail(activity.id);
    assert.equal(current.activity.checklistRevision, 3); assert.equal(current.activity.version, 1);
    assert.equal(current.activity.checklistProgress.checked, 2);
    fail(await h.api(h.actors.ownerA, 'PATCH', `/activities/${activity.id}/checklist/${a.id}`,
        {...command(), expectedVersion: 1, changes: {text: 'Stale'}}), 409, 'CHECKLIST_ITEM_VERSION_CONFLICT');
    fail(await h.api(h.actors.ownerA, 'DELETE', `/activities/${activity.id}/checklist/${b.id}`,
        {...command(), expectedVersion: 2, expectedChecklistRevision: 1}), 409, 'CHECKLIST_VERSION_CONFLICT');
    fail(await h.api(h.actors.ownerA, 'POST', `/activities/${activity.id}/checklist`,
        {...command(), expectedChecklistRevision: 1, text: 'Stale'}), 409, 'CHECKLIST_VERSION_CONFLICT');
});

test('anchor reorder compacts a gap of one without colliding with the moved item original/final rank', async () => {
    const {activity} = await create({checklist: [{text: 'A'}, {text: 'B'}, {text: 'C'}]});
    const initial = await detail(activity.id), [a, b, c] = initial.checklist;
    const Checklist = h.activities.ActivityChecklistItem.schema(h.schemas.a);
    await Checklist.update({position: '1'}, {where: {id: a.id}});
    await Checklist.update({position: '2'}, {where: {id: b.id}});
    await Checklist.update({position: '1536'}, {where: {id: c.id}});
    const moved = ok(await h.api(h.actors.ownerA, 'POST', `/activities/${activity.id}/checklist/${c.id}/move`,
        {...command(), expectedChecklistRevision: 1, placement: {kind: 'before', itemId: b.id}}));
    assert.deepEqual(moved.checklist.map((item: any) => item.id), [a.id, c.id, b.id]);
    assert.equal(moved.item.position, '1536'); assert.equal(moved.item.version, 1);
    assert.equal(new Set(moved.checklist.map((item: any) => item.position)).size, 3);
    const latest = await detail(activity.id);
    assert.equal(latest.activity.version, 1); assert.equal(latest.orderRevision, initial.orderRevision);
    fail(await h.api(h.actors.ownerA, 'POST', `/activities/${activity.id}/checklist/${c.id}/move`,
        {...command(), expectedChecklistRevision: 2, placement: {kind: 'before', itemId: c.id}}), 409, 'CHECKLIST_VERSION_CONFLICT');
});

test('checklist receipts contain identifiers only and replay after delete returns the current collection', async () => {
    const {activity} = await create(), id = activity.id;
    const body = {...command(), expectedChecklistRevision: 0, text: 'PRIVATE CHECKLIST TEXT'};
    const first = ok(await h.api(h.actors.ownerA, 'POST', `/activities/${id}/checklist`, body), 201);
    ok(await h.api(h.actors.ownerA, 'DELETE', `/activities/${id}/checklist/${first.item.id}`,
        {...command(), expectedVersion: 1, expectedChecklistRevision: 1}));
    const replay = ok(await h.api(h.actors.ownerA, 'POST', `/activities/${id}/checklist`, body), 201);
    assert.equal(replay.item, null); assert.equal(replay.checklist.length, 0); assert.equal(replay.checklistRevision, 2);
    const operation = await h.activities.ActivityOperation.schema(h.schemas.a).findOne({where: {operationId: body.operationId}});
    assert.deepEqual(Object.keys(operation!.responseBody).sort(), ['activityId', 'itemId']);
    assert.equal(JSON.stringify(operation!.responseBody).includes(body.text), false);
    fail(await h.api(h.actors.ownerA, 'POST', `/activities/${id}/checklist`, {...body, text: 'Different'}), 409, 'OPERATION_ID_REUSED');
});

test('comments allow author and managers while other colleagues/viewers get fresh capability denial', async () => {
    const {activity} = await create(), id = activity.id;
    const first = await comment(id, 'Autore', h.actors.therapistA);
    assert.equal(first.comment.author.id, h.ids.therapistA); assert.equal(first.comment.capabilities.canEdit, true);
    const ownerPage = ok(await h.api(h.actors.ownerA, 'GET', `/activities/${id}/comments`));
    assert.equal(ownerPage.items[0].capabilities.canDelete, true);
    const ownerComment = await comment(id, 'Gestore');
    const therapistPage = ok(await h.api(h.actors.therapistA, 'GET', `/activities/${id}/comments`));
    assert.equal(therapistPage.items.find((row: any) => row.id === ownerComment.comment.id).capabilities.canEdit, false);
    fail(await h.api(h.actors.therapistA, 'PATCH', `/activities/${id}/comments/${ownerComment.comment.id}`,
        {...command(), expectedVersion: 1, text: 'Forbidden'}), 403, 'ACTIVITY_FORBIDDEN');
    fail(await h.api(h.actors.viewerA, 'POST', `/activities/${id}/comments`, {...command(), text: 'Forbidden'}), 403, 'ACTIVITY_FORBIDDEN');
    const viewerPage = ok(await h.api(h.actors.viewerA, 'GET', `/activities/${id}/comments`));
    assert.ok(viewerPage.items.every((row: any) => !row.capabilities.canEdit && !row.capabilities.canDelete));
    const moderated = ok(await h.api(h.actors.ownerA, 'PATCH', `/activities/${id}/comments/${first.comment.id}`,
        {...command(), expectedVersion: 1, text: 'Moderato'}));
    assert.equal(moderated.comment.version, 2); assert.ok(moderated.comment.editedAt);
    fail(await h.api(h.actors.therapistA, 'PATCH', `/activities/${id}/comments/${first.comment.id}`,
        {...command(), expectedVersion: 1, text: 'Stale'}), 409, 'COMMENT_VERSION_CONFLICT');
});

test('secretary moderation uses the effective current structure role rather than JWT role', async () => {
    const {activity} = await create(), first = await comment(activity.id);
    await h.auth.StructureUser.update({role: 'SECRETARY'}, {where: {structureId: h.ids.structureA, userId: h.ids.therapistA}});
    try {
        const result = ok(await h.api(h.actors.therapistA, 'DELETE', `/activities/${activity.id}/comments/${first.comment.id}`,
            {...command(), expectedVersion: 1}));
        assert.equal(result.comment.text, null); assert.ok(result.comment.deletedAt);
    } finally {
        await h.auth.StructureUser.update({role: null}, {where: {structureId: h.ids.structureA, userId: h.ids.therapistA}});
    }
});

test('comment tombstones scrub text, preserve ordering/author and replay creation as a fresh tombstone', async () => {
    const initial = await create(), id = initial.activity.id;
    const body = {...command(), text: 'PRIVATE COMMENT TEXT'};
    const first = ok(await h.api(h.actors.ownerA, 'POST', `/activities/${id}/comments`, body), 201);
    const removed = ok(await h.api(h.actors.ownerA, 'DELETE', `/activities/${id}/comments/${first.comment.id}`,
        {...command(), expectedVersion: 1}));
    assert.equal(removed.comment.text, null); assert.equal(removed.comment.version, 2);
    assert.deepEqual(removed.comment.capabilities, {canEdit: false, canDelete: false});
    const replay = ok(await h.api(h.actors.ownerA, 'POST', `/activities/${id}/comments`, body), 201);
    assert.deepEqual(replay.comment, removed.comment);
    const latest = await detail(id);
    assert.equal(latest.activity.commentCount, 0); assert.equal(latest.commentsPage.total, 1);
    assert.equal(latest.activity.version, 1); assert.equal(latest.orderRevision, initial.orderRevision);
    const receipts = await h.activities.ActivityOperation.schema(h.schemas.a).findAll({where: {boardId: initial.activity.boardId}});
    const history = await h.activities.ActivityHistory.schema(h.schemas.a).findAll({where: {activityId: id}});
    assert.equal(JSON.stringify(receipts.map(row => row.responseBody)).includes(body.text), false);
    assert.equal(JSON.stringify(history.map(row => row.data)).includes(body.text), false);
});

test('completed activities accept comments, archived activities reject every child write atomically', async () => {
    const initial = await create({status: 'COMPLETED'}), id = initial.activity.id;
    const first = await comment(id, 'Completata');
    fail(await h.api(h.actors.ownerA, 'POST', `/activities/${id}/checklist`,
        {...command(), expectedChecklistRevision: 0, text: 'Forbidden'}), 403, 'ACTIVITY_FORBIDDEN');
    const archived = ok(await h.api(h.actors.ownerA, 'POST', `/activities/${id}/archive`,
        {...command(), expectedVersion: 1, expectedOrderRevision: initial.orderRevision}));
    fail(await h.api(h.actors.ownerA, 'POST', `/activities/${id}/comments`, {...command(), text: 'Forbidden'}), 403, 'ACTIVITY_FORBIDDEN');
    fail(await h.api(h.actors.ownerA, 'PATCH', `/activities/${id}/comments/${first.comment.id}`,
        {...command(), expectedVersion: 1, text: 'Forbidden'}), 403, 'ACTIVITY_FORBIDDEN');
    fail(await h.api(h.actors.ownerA, 'DELETE', `/activities/${id}/comments/${first.comment.id}`,
        {...command(), expectedVersion: 1}), 403, 'ACTIVITY_FORBIDDEN');
    const latest = await detail(id);
    assert.equal(latest.snapshotRevision, archived.snapshotRevision); assert.equal(latest.commentsPage.total, 1);
    assert.equal(latest.commentsPage.items[0].capabilities.canEdit, false);
});

test('child IDs and signed cursor are isolated across activities, structures, tenants and actors', async () => {
    const {activity} = await create(), other = await create();
    const item = await add(activity.id, 0), first = await comment(activity.id);
    fail(await h.api(h.actors.ownerA, 'PATCH', `/activities/${other.activity.id}/checklist/${item.item.id}`,
        {...command(), expectedVersion: 1, changes: {text: 'Wrong parent'}}), 404, 'ACTIVITY_NOT_FOUND');
    fail(await h.api(h.actors.ownerA, 'DELETE', `/activities/${other.activity.id}/comments/${first.comment.id}`,
        {...command(), expectedVersion: 1}), 404, 'ACTIVITY_NOT_FOUND');
    for (const actor of [h.actors.ownerA2, h.actors.ownerB]) {
        fail(await h.api(actor, 'GET', `/activities/${activity.id}/comments`), 404, 'ACTIVITY_NOT_FOUND');
        fail(await h.api(actor, 'GET', `/activities/${activity.id}/checklist`), 404, 'ACTIVITY_NOT_FOUND');
    }
});

test('comment cursor pages and loaded-range refresh are stable for tied timestamps and expire on mutation', async () => {
    const {activity} = await create(), id = activity.id, createdAt = new Date();
    await h.activities.ActivityComment.schema(h.schemas.a).bulkCreate(Array.from({length: 45}, (_, index) =>
        ({activityId: id, authorUserId: h.ids.ownerA, text: `Pagina ${index}`, version: 1, createdAt, updatedAt: createdAt})));
    const first = ok(await h.api(h.actors.ownerA, 'GET', `/activities/${id}/comments`));
    assert.equal(first.items.length, 20); assert.equal(first.total, 45); assert.ok(first.nextCursor);
    const second = ok(await h.api(h.actors.ownerA, 'GET', `/activities/${id}/comments?cursor=${encodeURIComponent(first.nextCursor)}`));
    assert.equal(second.items.length, 20); assert.equal(second.evaluationAt, first.evaluationAt);
    const refreshed = ok(await h.api(h.actors.ownerA, 'GET', `/activities/${id}/comments?limit=40`));
    assert.deepEqual(refreshed.items.map((row: any) => row.id), [...first.items, ...second.items].map(row => row.id));
    assert.equal(new Set(refreshed.items.map((row: any) => row.id)).size, 40);
    fail(await h.api(h.actors.viewerA, 'GET', `/activities/${id}/comments?cursor=${encodeURIComponent(first.nextCursor)}`), 409, 'ACTIVITY_CURSOR_EXPIRED');
    fail(await h.api(h.actors.ownerA, 'GET', `/activities/${id}/history?cursor=${encodeURIComponent(first.nextCursor)}`), 409, 'ACTIVITY_CURSOR_EXPIRED');
    await comment(id, 'Nuovo');
    fail(await h.api(h.actors.ownerA, 'GET', `/activities/${id}/comments?cursor=${encodeURIComponent(first.nextCursor)}`), 409, 'ACTIVITY_CURSOR_EXPIRED');
});

test('history supports cursor paging, enriched actors and the existing offset contract', async () => {
    const {activity} = await create(), id = activity.id, createdAt = new Date();
    await h.activities.ActivityHistory.schema(h.schemas.a).bulkCreate(Array.from({length: 44}, (_, index) =>
        ({activityId: id, actorUserId: h.ids.ownerA, eventType: 'TEST', data: {index}, createdAt})));
    const first = ok(await h.api(h.actors.ownerA, 'GET', `/activities/${id}/history?pagination=cursor`));
    assert.equal(first.items.length, 20); assert.ok(first.nextCursor); assert.equal(first.items[0].actor.id, h.ids.ownerA);
    const next = ok(await h.api(h.actors.ownerA, 'GET', `/activities/${id}/history?cursor=${encodeURIComponent(first.nextCursor)}`));
    const offset = ok(await h.api(h.actors.ownerA, 'GET', `/activities/${id}/history?offset=20&limit=20`));
    assert.deepEqual(next.items.map((row: any) => row.id), offset.items.map((row: any) => row.id));
    assert.equal(offset.nextOffset, 40); assert.equal(new Set([...first.items, ...next.items].map(row => row.id)).size, 40);
});

test('current role revocation denies new commands and refreshes capabilities on safe replay', async () => {
    const {activity} = await create(), body = {...command(), text: 'Autore'};
    const first = ok(await h.api(h.actors.therapistA, 'POST', `/activities/${activity.id}/comments`, body), 201);
    assert.equal(first.comment.author.eligible, true);
    const expectInactiveAuthor = async () => {
        const current = await detail(activity.id);
        const author = current.commentsPage.items.find((row: any) => row.id === first.comment.id).author;
        const actor = current.historyPage.items.find((row: any) => row.eventType === 'COMMENT_ADDED').actor;
        for (const summary of [author, actor]) {
            assert.equal(summary.id, h.ids.therapistA); assert.equal(summary.name, 'Integration');
            assert.equal(summary.surname, h.ids.therapistA.slice(0, 8)); assert.equal(summary.eligible, false);
        }
    };
    await h.auth.StructureUser.update({role: 'VIEWER'}, {where: {structureId: h.ids.structureA, userId: h.ids.therapistA}});
    try {
        const replay = ok(await h.api(h.actors.therapistA, 'POST', `/activities/${activity.id}/comments`, body), 201);
        assert.equal(replay.comment.id, first.comment.id); assert.equal(replay.comment.capabilities.canEdit, false);
        assert.equal(replay.comment.author.eligible, false);
        fail(await h.api(h.actors.therapistA, 'PATCH', `/activities/${activity.id}/comments/${first.comment.id}`,
            {...command(), expectedVersion: 1, text: 'Forbidden'}), 403, 'ACTIVITY_FORBIDDEN');
        await expectInactiveAuthor();
        await h.auth.StructureUser.update({role: null}, {where: {structureId: h.ids.structureA, userId: h.ids.therapistA}});
        await h.auth.TenantUser.update({deactivatedAt: new Date()}, {where: {tenantId: h.ids.tenantA, userId: h.ids.therapistA}});
        await expectInactiveAuthor();
        await h.auth.TenantUser.update({deactivatedAt: null}, {where: {tenantId: h.ids.tenantA, userId: h.ids.therapistA}});
        await h.auth.StructureUser.destroy({where: {structureId: h.ids.structureA, userId: h.ids.therapistA}});
        await expectInactiveAuthor();
    } finally {
        await h.auth.TenantUser.update({deactivatedAt: null}, {where: {tenantId: h.ids.tenantA, userId: h.ids.therapistA}});
        await h.auth.StructureUser.upsert({structureId: h.ids.structureA, userId: h.ids.therapistA, role: null, calendarEnabled: false});
    }
});

test('a history failure rolls back child, aggregate, snapshot and operation receipt in the same transaction', async () => {
    const initial = await create(), id = initial.activity.id, body = {...command(), expectedChecklistRevision: 0, text: 'Rollback'};
    const schema = h.schemas.a;
    await h.sequelize.query(`CREATE FUNCTION "${schema}".reject_collaboration_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated test rollback'; END $$`);
    await h.sequelize.query(`CREATE TRIGGER reject_collaboration_history BEFORE INSERT ON "${schema}".activity_history FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_collaboration_history()`);
    try {
        fail(await h.api(h.actors.ownerA, 'POST', `/activities/${id}/checklist`, body), 500, 'ACTIVITY_INTERNAL_ERROR');
    } finally {
        await h.sequelize.query(`DROP TRIGGER reject_collaboration_history ON "${schema}".activity_history`);
        await h.sequelize.query(`DROP FUNCTION "${schema}".reject_collaboration_history()`);
    }
    const current = await detail(id);
    assert.equal(current.checklist.length, 0); assert.equal(current.activity.checklistRevision, 0);
    assert.equal(current.snapshotRevision, initial.snapshotRevision);
    assert.equal(await h.activities.ActivityOperation.schema(schema).count({where: {operationId: body.operationId}}), 0);
    ok(await h.api(h.actors.ownerA, 'POST', `/activities/${id}/checklist`, body), 201);
});
