import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {after, before, test} from 'node:test';
import {createActivitiesHarness, type ActivitiesHarness, type ApiResult} from './activitiesTestHarness.js';
import type {ActivityDeliveryTransport} from '../services/activityDeliveryTransport.service.js';

let h: ActivitiesHarness;
let delivery: typeof import('../services/activityDelivery.service.js');
let activation: typeof import('../services/activityDeliveryActivation.service.js');
let Preference: typeof import('../models/activityNotificationPreference.model.js').default;
let Subscription: typeof import('../../notes/models/reminderPushSubscription.model.js').default;
const baseline = new Date(Date.now() - 86_400_000);
before(async () => {
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = 'activities-test-public-key';
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = 'activities-test-private-key';
    h = await createActivitiesHarness();
    delivery = await import('../services/activityDelivery.service.js');
    activation = await import('../services/activityDeliveryActivation.service.js');
    Preference = (await import('../models/activityNotificationPreference.model.js')).default;
    Subscription = (await import('../../notes/models/reminderPushSubscription.model.js')).default;
}, {timeout: 180_000});
after(async () => {
    if (!h) return;
    await Preference.destroy({where: {userId: Object.values(h.ids).filter(id => [h.ids.ownerA, h.ids.ownerB, h.ids.therapistA].includes(id))}});
    await Subscription.destroy({where: {userId: [h.ids.ownerA, h.ids.ownerB, h.ids.therapistA]}});
    await h.cleanup();
}, {timeout: 60_000});
function success(result: ApiResult, status = 200) {
    assert.equal(result.status, status, JSON.stringify(result.body)); return result.body.data;
}
async function makeAlert(channels = ['inApp'], actor = h.actors.ownerA, time = new Date(Date.now() + 60_000)) {
    const created = success(await h.api(actor, 'POST', '/activities', {operationId: randomUUID(), title: 'Delivery fixture ' + randomUUID(),
        description: 'Private clinical description must never enter providers', due: {kind: 'timed', at: new Date(time.getTime() + 60_000).toISOString()},
        alert: {scheduledAt: time.toISOString(), channels}}), 201);
    const schema = h.tenantSchema.getTenantSchemaName(actor.tenantId);
    const alert = await h.activities.ActivityAlert.schema(schema).findOne({where: {activityId: created.activity.id}});
    assert.ok(alert); return {activity: created.activity, alert, schema, tenantId: actor.tenantId, time};
}
async function enableEmail(userId = h.ids.ownerA, enabledAt = baseline) {
    await Preference.upsert({userId, emailEnabled: true, emailEnabledAt: enabledAt});
}
async function device(userId = h.ids.ownerA, enabledAt = baseline) {
    const endpoint = 'https://fcm.googleapis.com/activities-test/' + randomUUID();
    return Subscription.create({userId, endpoint, endpointHash: createHash('sha256').update(endpoint).digest('hex'),
        p256dh: 'test-only-p256dh', auth: 'test-only-auth', remindersEnabled: true, activitiesEnabled: true, activitiesEnabledAt: enabledAt});
}
async function activate(schema = h.schemas.a, now = baseline) {
    await activation.ensureActivityDeliveryActivation(schema, undefined, {force: true, now});
}
const noProviders: ActivityDeliveryTransport = {email: async () => {throw new Error('Unexpected email');}, push: async () => {throw new Error('Unexpected push');}};
async function sweep(tenantId: string, now: Date, transport = noProviders) {
    await delivery.sweepActivityDeliveries({force: true, tenantIds: [tenantId], now, transport});
}
async function receipts(fixture: Awaited<ReturnType<typeof makeAlert>>) {
    return h.activities.ActivityDelivery.schema(fixture.schema).findAll({where: {alertId: fixture.alert.id}, order: [['channel', 'ASC']]});
}
async function stopAlert(fixture: Awaited<ReturnType<typeof makeAlert>>) {
    const current = success(await h.api(h.actors.ownerA, 'GET', '/activities/' + fixture.activity.id));
    success(await h.api(h.actors.ownerA, 'PATCH', '/activities/' + fixture.activity.id, {
        operationId: randomUUID(), expectedVersion: current.activity.version, changes: {alert: null}}));
}

test('migrations add receipts and consent flags without an activation row or any delivered alert', async () => {
    assert.equal(await h.activities.ActivityNotificationActivation.schema(h.schemas.a).count(), 0);
    const require = createRequire(import.meta.url);
    const publicMigration = require('../../../../migrations/20261011-activities-notifications-public.js');
    const tenantMigration = require('../../../../migrations/20261011-activities-delivery.js');
    await publicMigration.up(h.sequelize.getQueryInterface());
    await tenantMigration.up(h.sequelize.getQueryInterface(), {schema: h.schemas.a});
    assert.equal(await h.activities.ActivityNotificationActivation.schema(h.schemas.a).count(), 0);
    assert.equal(await h.activities.ActivityDelivery.schema(h.schemas.a).count(), 0);
    assert.equal(await h.migrations.isTenantSchemaCurrent(h.schemas.a), true);
});
test('first activation skips the backlog, while future alerts recover after a later outage', async () => {
    const skipped = await makeAlert(['inApp'], h.actors.ownerB);
    await h.activities.ActivityDelivery.schema(h.schemas.b).create({alertId: skipped.alert.id, recipientUserId: h.ids.ownerB,
        scheduleVersion: skipped.alert.scheduleVersion, channel: 'inApp', scheduledAt: skipped.time,
        nextAttemptAt: skipped.time, status: 'PENDING', attempts: 0});
    const cutoff = new Date(skipped.time.getTime() + 1);
    await activate(h.schemas.b, cutoff);
    await sweep(h.ids.tenantB, new Date(cutoff.getTime() + 60_000));
    assert.equal((await receipts(skipped)).length, 1);
    assert.equal((await receipts(skipped))[0].status, 'CANCELLED');
    const read = success(await h.api(h.actors.ownerB, 'GET', '/activities/' + skipped.activity.id));
    assert.equal(read.activity.alert.deliveryState, 'reprogramRequired');
    const recovered = await makeAlert(['inApp'], h.actors.ownerB, new Date(cutoff.getTime() + 60_000));
    await sweep(h.ids.tenantB, new Date(recovered.time.getTime() + 86_400_000));
    assert.deepEqual((await receipts(recovered)).map(row => row.status), ['SENT']);
    assert.equal((await h.activities.ActivityNotificationActivation.schema(h.schemas.b).findByPk('activities'))!.activatedAt.getTime(), cutoff.getTime());
});
test('alert and recipients materialize atomically; concurrent workers deliver one in-app receipt', async () => {
    await activate();
    const fixture = await makeAlert();
    assert.deepEqual((await receipts(fixture)).map(row => row.status), ['PENDING']);
    await Promise.all([sweep(fixture.tenantId, fixture.time), sweep(fixture.tenantId, fixture.time)]);
    const rows = await receipts(fixture);
    assert.equal(rows.length, 1); assert.equal(rows[0].status, 'SENT'); assert.equal(rows[0].attempts, 1);
    await sweep(fixture.tenantId, new Date(fixture.time.getTime() + 60_000));
    assert.equal((await receipts(fixture))[0].attempts, 1);
});
test('email preference defaults off and a post-due consent does not send a backlog', async () => {
    const prefs = success(await h.api(h.actors.ownerA, 'GET', '/activities/notification-preferences'));
    assert.equal(prefs.emailEnabled, false); assert.equal(prefs.emailEnabledAt, null);
    const fixture = await makeAlert(['inApp', 'email']);
    await enableEmail(h.ids.ownerA, new Date(fixture.time.getTime() + 1));
    await sweep(fixture.tenantId, fixture.time);
    assert.deepEqual((await receipts(fixture)).map(row => [row.channel, row.status]), [['email', 'CANCELLED'], ['inApp', 'SENT']]);
    await Preference.destroy({where: {userId: h.ids.ownerA}});
});
test('shared push registration preserves each domain and ownership transfer resets the other account consent', async () => {
    const endpoint = 'https://fcm.googleapis.com/activities-contract/' + randomUUID(), keys = {p256dh: 'dummy', auth: 'dummy'};
    const reminder = success(await h.api(h.actors.ownerA, 'POST', '/notifications/push-subscriptions', {domain: 'reminders', subscription: {endpoint, keys}}));
    assert.equal(reminder.remindersEnabled, true); assert.equal(reminder.activitiesEnabled, false);
    const enabled = success(await h.api(h.actors.ownerA, 'POST', '/notifications/push-subscriptions', {domain: 'activities', subscription: {endpoint, keys}}));
    assert.equal(enabled.remindersEnabled, true); assert.equal(enabled.activitiesEnabled, true);
    const removed = success(await h.api(h.actors.ownerA, 'DELETE', '/notifications/push-subscriptions', {endpoint, domain: 'activities'}));
    assert.equal(removed.retained, true); assert.equal(removed.remindersEnabled, true); assert.equal(removed.activitiesEnabled, false);
    const transferred = success(await h.api(h.actors.ownerB, 'POST', '/notifications/push-subscriptions', {domain: 'activities', subscription: {endpoint, keys}}));
    assert.equal(transferred.remindersEnabled, false); assert.equal(transferred.activitiesEnabled, true);
    assert.equal(success(await h.api(h.actors.ownerA, 'POST', '/notifications/push-subscriptions/status', {endpoint})).subscribed, false);
    const logout = success(await h.api(h.actors.ownerB, 'DELETE', '/notifications/push-subscriptions', {endpoint}));
    assert.equal(logout.retained, false);
    success(await h.api(h.actors.ownerA, 'POST', '/notifications/push-subscriptions', {domain: 'activities', subscription: {endpoint, keys}}));
    assert.equal((await h.api(h.actors.patient, 'POST', '/notifications/push-subscriptions', {domain: 'activities', subscription: {endpoint, keys}})).status, 403);
    const patientLogout = success(await h.api(h.actors.patient, 'DELETE', '/notifications/push-subscriptions', {endpoint}));
    assert.equal(patientLogout.retained, false);
});
test('explicit temporary email rejection retries five times with no fallback from push', async () => {
    await enableEmail();
    const fixture = await makeAlert(['inApp', 'email']);
    let calls = 0;
    const transport: ActivityDeliveryTransport = {email: async () => {calls++; throw {responseCode: 451};}, push: noProviders.push};
    let now = fixture.time;
    for (let index = 0; index < 5; index++) {
        await sweep(fixture.tenantId, now, transport);
        const email = (await receipts(fixture)).find(row => row.channel === 'email')!;
        assert.equal(email.attempts, index + 1);
        if (index < 4) {assert.equal(email.status, 'PENDING'); now = email.nextAttemptAt;}
        else assert.equal(email.status, 'FAILED');
    }
    assert.equal(calls, 5);
    await stopAlert(fixture);
});
test('an ambiguous email timeout remains uncertain and is never retried automatically', async () => {
    await enableEmail();
    const fixture = await makeAlert(['inApp', 'email']);
    let calls = 0;
    const transport: ActivityDeliveryTransport = {email: async () => {calls++; throw {code: 'ETIMEDOUT'};}, push: noProviders.push};
    await sweep(fixture.tenantId, fixture.time, transport);
    assert.equal((await receipts(fixture)).find(row => row.channel === 'email')!.status, 'UNCERTAIN');
    await sweep(fixture.tenantId, new Date(fixture.time.getTime() + 600_000), transport);
    assert.equal(calls, 1);
    await stopAlert(fixture);
    assert.equal((await receipts(fixture)).find(row => row.channel === 'email')!.status, 'CANCELLED');
});
test('successful devices are not resent when another device retries, and no email fallback is introduced', async () => {
    const one = await device(), two = await device();
    const fixture = await makeAlert(['inApp', 'push']);
    const calls = new Map<string, number>();
    const transport: ActivityDeliveryTransport = {email: noProviders.email, push: async subscription => {
        const count = (calls.get(subscription.id) ?? 0) + 1; calls.set(subscription.id, count);
        if (subscription.id === two.id && count === 1) throw {statusCode: 503};
        return 'accepted-test-reference';
    }};
    await sweep(fixture.tenantId, fixture.time, transport);
    const first = (await receipts(fixture)).find(row => row.channel === 'push')!;
    assert.equal(first.status, 'PENDING');
    await sweep(fixture.tenantId, first.nextAttemptAt, transport);
    assert.equal((await receipts(fixture)).find(row => row.channel === 'push')!.status, 'SENT');
    assert.equal(calls.get(one.id), 1); assert.equal(calls.get(two.id), 2);
    assert.equal((await receipts(fixture)).some(row => row.channel === 'email'), false);
    await one.destroy(); await two.destroy();
});
test('disabling a device between attempts cancels just that target while preserving the delivered device', async () => {
    const one = await device(), two = await device();
    const fixture = await makeAlert(['inApp', 'push']);
    let calls = 0;
    const transport: ActivityDeliveryTransport = {email: noProviders.email, push: async subscription => {
        calls++; if (subscription.id === two.id) throw {statusCode: 429}; return null;
    }};
    await sweep(fixture.tenantId, fixture.time, transport);
    const push = (await receipts(fixture)).find(row => row.channel === 'push')!;
    await two.update({activitiesEnabled: false, activitiesEnabledAt: null});
    await sweep(fixture.tenantId, push.nextAttemptAt, transport);
    const targets = await h.activities.ActivityPushTarget.schema(fixture.schema).findAll({where: {deliveryId: push.id}});
    assert.deepEqual(targets.map(row => row.status).sort(), ['CANCELLED', 'SENT']); assert.equal(calls, 2);
    await one.destroy(); await two.destroy();
});
test('an unstarted expired lease recovers; an email dispatch fence becomes uncertain without sending', async () => {
    await enableEmail();
    const fixture = await makeAlert(['inApp', 'email']);
    const rows = await receipts(fixture), email = rows.find(row => row.channel === 'email')!, inApp = rows.find(row => row.channel === 'inApp')!;
    for (const row of rows) await row.update({status: 'PROCESSING', leaseToken: randomUUID(), leaseUntil: fixture.time,
        dispatchStartedAt: row.channel === 'email' ? new Date(fixture.time.getTime() - 1) : null});
    await sweep(fixture.tenantId, fixture.time);
    await email.reload(); await inApp.reload(); assert.equal(email.status, 'UNCERTAIN'); assert.equal(inApp.status, 'SENT');
    await stopAlert(fixture);
});
test('a crashed push dispatch marks just the unknown target uncertain and delivers other pending devices', async () => {
    const one = await device(), two = await device();
    const fixture = await makeAlert(['inApp', 'push']);
    const push = (await receipts(fixture)).find(row => row.channel === 'push')!;
    await push.update({status: 'PROCESSING', leaseToken: randomUUID(), leaseUntil: fixture.time, dispatchStartedAt: fixture.time});
    for (const sub of [one, two]) await h.activities.ActivityPushTarget.schema(fixture.schema).create({deliveryId: push.id, subscriptionId: sub.id,
        endpointHash: sub.endpointHash, status: sub.id === one.id ? 'PROCESSING' : 'PENDING', attempts: sub.id === one.id ? 1 : 0,
        nextAttemptAt: fixture.time, dispatchStartedAt: sub.id === one.id ? fixture.time : null});
    const sent: string[] = [];
    await sweep(fixture.tenantId, fixture.time, {email: noProviders.email, push: async sub => {sent.push(sub.id); return null;}});
    assert.deepEqual(sent, [two.id]); await push.reload(); assert.equal(push.status, 'UNCERTAIN');
    await stopAlert(fixture);
    const targets = await h.activities.ActivityPushTarget.schema(fixture.schema).findAll({where: {deliveryId: push.id}});
    assert.deepEqual(targets.map(row => row.status).sort(), ['CANCELLED', 'SENT']);
    await one.destroy(); await two.destroy();
});
test('cancellation during provider IO wins over a late successful provider answer', async () => {
    await enableEmail();
    const fixture = await makeAlert(['inApp', 'email']);
    let entered!: () => void, release!: () => void;
    const dispatched = new Promise<void>(resolve => {entered = resolve;}), finish = new Promise<void>(resolve => {release = resolve;});
    const running = sweep(fixture.tenantId, fixture.time, {email: async () => {entered(); await finish; return 'late-accepted';}, push: noProviders.push});
    await dispatched;
    await stopAlert(fixture); release(); await running;
    const rows = await receipts(fixture);
    assert.equal(rows.find(row => row.channel === 'email')!.status, 'CANCELLED');
    assert.equal(rows.find(row => row.channel === 'inApp')!.status, 'SENT');
});
test('role or assignment revocation is rechecked immediately before dispatch, without sending', async () => {
    const fixture = await makeAlert(['inApp', 'email'], h.actors.therapistA);
    await enableEmail(h.ids.therapistA);
    const membership = await h.auth.StructureUser.findOne({where: {structureId: h.ids.structureA, userId: h.ids.therapistA}});
    await membership!.update({role: 'VIEWER'});
    try {await sweep(fixture.tenantId, fixture.time); assert.ok((await receipts(fixture)).every(row => row.status === 'CANCELLED'));}
    finally {await membership!.update({role: null});}
});
test('one consent cannot change another user preference and patient sessions cannot use notification settings', async () => {
    const otherBefore = await Preference.findByPk(h.ids.ownerB);
    assert.equal((await h.api(h.actors.patient, 'GET', '/activities/notification-preferences')).status, 403);
    const updated = success(await h.api(h.actors.ownerA, 'PATCH', '/activities/notification-preferences', {emailEnabled: false}));
    assert.equal(updated.emailEnabled, false); assert.equal(updated.emailEnabledAt, null);
    assert.equal((await Preference.findByPk(h.ids.ownerB))?.emailEnabled ?? false, otherBefore?.emailEnabled ?? false);
});

test('provider templates contain only generic text and the contextual activity destination', async () => {
    const {defaultActivityDeliveryTransport} = await import('../services/activityDeliveryTransport.service.js');
    const {transporter} = await import('../../../services/email.service.js');
    const webpush = (await import('web-push')).default;
    const originalMail = transporter.sendMail, originalPush = webpush.sendNotification, originalVapid = webpush.setVapidDetails;
    let mail: any, payload: any;
    const sub = await device();
    try {
        transporter.sendMail = (async options => {mail = options; return {messageId: 'mocked-email-reference'};}) as any;
        webpush.setVapidDetails = () => undefined;
        webpush.sendNotification = (async (_subscription, value) => {payload = JSON.parse(value as string); return {statusCode: 201, headers: {}, body: ''};}) as any;
        const address = {tenantId: h.ids.tenantA, structureId: h.ids.structureA, activityId: randomUUID(), deliveryId: randomUUID()};
        await defaultActivityDeliveryTransport().email('fixture@example.invalid', address);
        await defaultActivityDeliveryTransport().push(sub, address);
        assert.equal(mail.subject, 'Hai un’attività su Rehablo');
        assert.match(mail.text, /activities\/open\?tenantId=/); assert.doesNotMatch(mail.text, /clinical|Delivery fixture/i);
        assert.equal(payload.kind, 'activity'); assert.equal(payload.version, 1); assert.equal(payload.activityId, address.activityId);
        assert.equal(payload.body, 'Hai un’attività da controllare.');
        assert.equal(Object.hasOwn(payload, 'description'), false); assert.equal(Object.hasOwn(payload, 'patient'), false);
    } finally {transporter.sendMail = originalMail; webpush.sendNotification = originalPush; webpush.setVapidDetails = originalVapid; await sub.destroy();}
});

test('an assignee added after the scheduled instant is never enrolled by discovery or unrelated edits', async () => {
    const fixture = await makeAlert();
    await sweep(fixture.tenantId, fixture.time);
    const record = await h.activities.ActivityAssignment.schema(fixture.schema).create({activityId: fixture.activity.id,
        userId: h.ids.therapistA, assignedByUserId: h.ids.ownerA,
        createdAt: new Date(fixture.time.getTime() + 1), updatedAt: new Date(fixture.time.getTime() + 1)});
    assert.ok(record.createdAt > fixture.time);
    const persistence = await import('../services/activityDeliveryPersistence.service.js');
    await h.sequelize.transaction(transaction => persistence.materializeActivityDeliveries(fixture.schema, fixture.alert, transaction,
        {reactivateRecipients: true, now: new Date(fixture.time.getTime() + 60_000)}));
    await sweep(fixture.tenantId, new Date(fixture.time.getTime() + 120_000));
    const rows = await receipts(fixture);
    assert.equal(rows.length, 1); assert.equal(rows[0].recipientUserId, h.ids.ownerA); assert.equal(rows[0].status, 'SENT');
});

test('every push device renews its lease with the current clock during a delivery longer than two minutes', async () => {
    const devices = await Promise.all(Array.from({length: 7}, () => device()));
    const fixture = await makeAlert(['inApp', 'push']);
    let elapsed = fixture.time.getTime(), calls = 0;
    try {
        await delivery.sweepActivityDeliveries({force: true, tenantIds: [fixture.tenantId], clock: () => new Date(elapsed),
            transport: {email: noProviders.email, push: async () => {
                elapsed += 20_000; calls++;
                if (calls === 7) await delivery.claimActivityDeliveryBatch(fixture.schema, new Date(elapsed));
                return 'accepted-after-slow-device';
            }}});
        const push = (await receipts(fixture)).find(row => row.channel === 'push')!;
        assert.equal(calls, 7); assert.equal(push.status, 'SENT');
        const targets = await h.activities.ActivityPushTarget.schema(fixture.schema).findAll({where: {deliveryId: push.id}});
        assert.equal(targets.length, 7); assert.ok(targets.every(target => target.status === 'SENT' && target.attempts === 1));
    } finally {for (const sub of devices) await sub.destroy();}
});
