import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after, before, test} from 'node:test';
import {createActivitiesHarness, type ActivitiesHarness} from './activitiesTestHarness.js';

let h: ActivitiesHarness;
let delivery: typeof import('../services/activityDelivery.service.js');
let policy: typeof import('../utils/activityRecurrence.policy.js');
before(async () => {
    h = await createActivitiesHarness();
    delivery = await import('../services/activityDelivery.service.js');
    policy = await import('../utils/activityRecurrence.policy.js');
    const activation = await import('../services/activityDeliveryActivation.service.js');
    await activation.ensureActivityDeliveryActivation(h.schemas.a, undefined, {force: true, now: new Date(Date.now() - 86400000)});
}, {timeout: 180000});
after(async () => {if (h) await h.cleanup();}, {timeout: 60000});

async function routine() {
    const now = new Date(), today = policy.recurrenceLocalDate(now, 'Europe/Rome');
    const scheduledAt = new Date(now.getTime() + 60000);
    const result = await h.api(h.actors.ownerA, 'POST', '/activities', {operationId: randomUUID(), title: 'Avviso ricorrente',
        recurrence: {frequency: 'daily', interval: 1, startsOn: today, endsOn: null},
        alert: {scheduledAt: scheduledAt.toISOString(), channels: ['inApp']}});
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const activity = result.body.data.activity;
    const alert = await h.activities.ActivityAlert.schema(h.schemas.a).findOne({where: {activityId: activity.id}});
    assert.ok(alert);
    return {activity, alert, today, scheduledAt};
}
async function receipts(alertId: string) {
    return h.activities.ActivityDelivery.schema(h.schemas.a).findAll({where: {alertId}});
}

test('a manual recurring alert stores the execution identity and notification link permanently', async () => {
    const fixture = await routine();
    await delivery.sweepActivityDeliveries({force: true, tenantIds: [h.ids.tenantA], now: fixture.scheduledAt});
    const sent = (await receipts(fixture.alert.id)).find(row => row.status === 'SENT');
    assert.ok(sent);
    assert.equal(sent.executionId, fixture.activity.currentExecutionId);
    const transport = await import('../services/activityDeliveryTransport.service.js');
    const address = {tenantId: h.ids.tenantA, structureId: h.ids.structureA, activityId: fixture.activity.id, deliveryId: sent.id};
    assert.equal(new URL('https://example.test/' + transport.activityNotificationPath(address)).searchParams.has('executionId'), false);
    assert.equal(new URL('https://example.test/' + transport.activityNotificationPath({...address, executionId: sent.executionId!})).searchParams.get('executionId'), sent.executionId);
    await fixture.alert.update({executionId: null, enabled: false, scheduleVersion: fixture.alert.scheduleVersion + 1});
    await sent.reload();
    assert.equal(sent.executionId, fixture.activity.currentExecutionId);
});

test('a recurring alert cannot be delivered after its day expires even before the recurrence sweep', async () => {
    const fixture = await routine();
    const deadline = policy.activityExecutionDeadline(fixture.today, 'Europe/Rome');
    await delivery.sweepActivityDeliveries({force: true, tenantIds: [h.ids.tenantA], now: deadline});
    const rows = await receipts(fixture.alert.id);
    assert.ok(rows.length > 0);
    assert.ok(rows.every(row => row.status === 'CANCELLED'));
});

test('an old queued receipt cannot follow an alert rebound to a different execution', async () => {
    const fixture = await routine();
    await fixture.alert.update({executionId: null});
    await delivery.sweepActivityDeliveries({force: true, tenantIds: [h.ids.tenantA], now: fixture.scheduledAt});
    assert.ok((await receipts(fixture.alert.id)).every(row => row.status === 'CANCELLED'));
});
