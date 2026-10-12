import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after, before, test} from 'node:test';
import {createActivitiesHarness, type ActivitiesHarness, type ApiResult} from './activitiesTestHarness.js';

let h: ActivitiesHarness;
before(async () => {h = await createActivitiesHarness();}, {timeout: 180_000});
after(async () => {if (h) await h.cleanup();});
function data(result: {status: number; body: any}, status = 200) {assert.equal(result.status, status, JSON.stringify(result.body)); return result.body.data;}
function invalidSession(result: ApiResult) {
    assert.equal(result.status, 401, JSON.stringify(result.body));
    assert.equal(result.body.error?.code, 'AUTH_SESSION_INVALID');
}
async function delivered(actor = h.actors.ownerA, recipientUserId = actor.userId) {
    const created = data(await h.api(actor, 'POST', '/activities', {operationId: randomUUID(), title: 'Titolo corrente ' + randomUUID()}), 201);
    const activity = created.activity;
    const schema = actor.tenantId === h.ids.tenantA ? h.schemas.a : h.schemas.b;
    const alert = await h.activities.ActivityAlert.schema(schema).create({activityId: activity.id, enabled: false, channels: [], scheduleVersion: 1});
    const delivery = await h.activities.ActivityDelivery.schema(schema).create({alertId: alert.id, recipientUserId,
        scheduleVersion: 1, channel: 'inApp', status: 'SENT', scheduledAt: new Date(Date.now() - 120_000), sentAt: new Date(Date.now() - 60_000)});
    return {activity, delivery, schema};
}
test('feed include soltanto avvisi in app consegnati al destinatario nella sede corrente e GET non segna letto', async () => {
    const own = await delivered(); await delivered(h.actors.ownerA2); await delivered(h.actors.ownerB); await delivered(h.actors.ownerA, h.ids.therapistA);
    const page = data(await h.api(h.actors.ownerA, 'GET', '/activities/alerts'));
    assert.ok(page.items.some((row: any) => row.id === own.delivery.id));
    assert.ok(page.items.every((row: any) => row.structureId === h.ids.structureA && row.tenantId === h.ids.tenantA));
    assert.equal(page.items.length, 1); assert.equal(page.unreadCount, 1);
    await own.delivery.reload(); assert.equal(own.delivery.readAt, null);
    assert.equal((await h.api(h.actors.patient, 'GET', '/activities/alerts')).status, 403);
    invalidSession(await h.api(h.actors.outsiderA, 'GET', '/activities/alerts'));
});
test('gli avvisi già consegnati conservano il titolo corrente di attività completate e archiviate', async () => {
    const {activity, delivery, schema} = await delivered();
    await h.activities.Activity.schema(schema).update({title: 'Titolo dopo consegna', status: 'COMPLETED', completedAt: new Date(),
        completedByUserId: h.ids.ownerA, archivedAt: new Date(), archivedByUserId: h.ids.ownerA}, {where: {id: activity.id}});
    const row = data(await h.api(h.actors.ownerA, 'GET', '/activities/alerts')).items.find((item: any) => item.id === delivery.id);
    assert.equal(row.title, 'Titolo dopo consegna'); assert.equal(row.status, 'COMPLETED'); assert.equal(row.archived, true);
});
test('lettura idempotente aggiorna soltanto readAt e rifiuta recipient diverso', async () => {
    const {activity, delivery, schema} = await delivered();
    const board = await h.activities.ActivityBoard.schema(schema).findByPk(activity.boardId);
    const revisions = [board!.snapshotRevision, board!.orderRevision]; const version = activity.version;
    const operationId = randomUUID();
    const first = data(await h.api(h.actors.ownerA, 'POST', `/activities/alerts/${delivery.id}/read`, {operationId}));
    const second = data(await h.api(h.actors.ownerA, 'POST', `/activities/alerts/${delivery.id}/read`, {operationId}));
    assert.equal(first.readAt, second.readAt); assert.equal(first.id, delivery.id);
    await board!.reload(); assert.deepEqual([board!.snapshotRevision, board!.orderRevision], revisions);
    assert.equal((await h.activities.Activity.schema(schema).findByPk(activity.id))!.version, version);
    assert.equal((await h.api(h.actors.therapistA, 'POST', `/activities/alerts/${delivery.id}/read`, {operationId: randomUUID()})).status, 404);
    const other = await delivered();
    assert.equal((await h.api(h.actors.ownerA, 'POST', `/activities/alerts/${other.delivery.id}/read`, {operationId})).status, 409);
});
test('cursor keyset non duplica e non attraversa sedi utenti o firme alterate', async () => {
    await delivered(); await delivered();
    const first = data(await h.api(h.actors.ownerA, 'GET', '/activities/alerts?limit=1'));
    assert.ok(first.nextCursor);
    const second = data(await h.api(h.actors.ownerA, 'GET', '/activities/alerts?limit=1&cursor=' + encodeURIComponent(first.nextCursor)));
    assert.notEqual(first.items[0].id, second.items[0].id);
    assert.equal((await h.api(h.actors.ownerA2, 'GET', '/activities/alerts?cursor=' + encodeURIComponent(first.nextCursor))).status, 409);
    assert.equal((await h.api(h.actors.therapistA, 'GET', '/activities/alerts?cursor=' + encodeURIComponent(first.nextCursor))).status, 409);
    assert.equal((await h.api(h.actors.ownerA, 'GET', '/activities/alerts?cursor=' + encodeURIComponent(first.nextCursor + 'x'))).status, 409);
    assert.equal((await h.api(h.actors.ownerA, 'GET', '/activities/alerts?limit=51')).status, 422);
});
test('revoca della sede elimina accesso anche a ricevute storiche già lette', async () => {
    const {delivery} = await delivered(h.actors.ownerA2); const operationId = randomUUID();
    data(await h.api(h.actors.ownerA2, 'POST', `/activities/alerts/${delivery.id}/read`, {operationId}));
    await h.auth.StructureUser.destroy({where: {structureId: h.ids.structureA2, userId: h.ids.ownerA}});
    try {
        invalidSession(await h.api(h.actors.ownerA2, 'GET', '/activities/alerts'));
        invalidSession(await h.api(h.actors.ownerA2, 'POST', `/activities/alerts/${delivery.id}/read`, {operationId}));
    } finally {await h.auth.StructureUser.create({structureId: h.ids.structureA2, userId: h.ids.ownerA});}
});
test('riepilogo contesti staff elenca soltanto sedi assegnate nel relativo tenant', async () => {
    const result = data(await h.api(h.actors.ownerA, 'GET', '/auth/session/contexts'));
    const staff = result.contexts.find((context: any) => context.id === 'staff:' + h.ids.tenantA);
    assert.deepEqual([...staff.accessibleStructureIds].sort(), [h.ids.structureA, h.ids.structureA2].sort());
    await h.auth.StructureUser.destroy({where: {structureId: h.ids.structureA2, userId: h.ids.ownerA}});
    try {
        const fresh = data(await h.api(h.actors.ownerA, 'GET', '/auth/session/contexts'));
        assert.deepEqual(fresh.contexts.find((context: any) => context.id === 'staff:' + h.ids.tenantA).accessibleStructureIds, [h.ids.structureA]);
    } finally {await h.auth.StructureUser.create({structureId: h.ids.structureA2, userId: h.ids.ownerA});}
});
