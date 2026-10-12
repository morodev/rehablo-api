import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after, afterEach, before, test} from 'node:test';
import {Op} from 'sequelize';
import {createActivitiesHarness, type ActivitiesHarness, type ApiResult} from './activitiesTestHarness.js';

let harness: ActivitiesHarness;
const activityIds: string[] = [];
const eventIds: string[] = [];
before(async () => {harness = await createActivitiesHarness();}, {timeout: 180_000});
after(async () => {if (harness) await harness.cleanup();}, {timeout: 60_000});
afterEach(async () => {
    const {auth, activities, ids, schemas} = harness;
    if (activityIds.length) await activities.Activity.schema(schemas.a).destroy({where: {id: {[Op.in]: activityIds.splice(0)}}});
    if (eventIds.length) {
        const {default: AgendaEvent} = await import('../../agenda/models/agendaEvent.model.js');
        await AgendaEvent.schema(schemas.a).destroy({where: {id: {[Op.in]: eventIds.splice(0)}}});
    }
    await auth.TenantUser.upsert({tenantId: ids.tenantA, userId: ids.therapistA, role: 'THERAPIST', deactivatedAt: null});
    await auth.StructureUser.upsert({structureId: ids.structureA, userId: ids.therapistA, role: null, calendarEnabled: false});
    await auth.StructureUser.destroy({where: {userId: ids.therapistA, structureId: ids.structureA2}});
    await auth.StructureUser.destroy({where: {userId: ids.outsiderA, structureId: ids.structureA}});
    await auth.StructureUser.update({role: null}, {where: {userId: ids.ownerA, structureId: ids.structureA2}});
    await auth.StructureUser.update({calendarEnabled: false}, {where: {userId: ids.ownerA, structureId: ids.structureA}});
    await auth.TenantUser.update({role: 'VIEWER'}, {where: {tenantId: ids.tenantA, userId: ids.viewerA}});
    await auth.TenantUser.update({role: 'THERAPIST'}, {where: {tenantId: ids.tenantA, userId: ids.outsiderA}});
    await auth.User.update({deactivatedAt: null}, {where: {id: ids.outsiderA}});
});

function success(result: ApiResult, status = 200): any {
    assert.equal(result.status, status, JSON.stringify(result.body));
    return result.body.data;
}
function failure(result: ApiResult, status: number, code: string) {
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.equal(result.body.error?.code, code, JSON.stringify(result.body));
}
async function create(fields: Record<string, unknown> = {}, actor = harness.actors.ownerA) {
    const result = success(await harness.api(actor, 'POST', '/activities', {
        operationId: randomUUID(), title: 'Team fixture ' + randomUUID(), assigneeIds: [harness.ids.therapistA], ...fields
    }), 201);
    activityIds.push(result.activity.id);
    return result.activity;
}
async function preflight(change: any, actor = harness.actors.ownerA, target = harness.ids.therapistA) {
    return success(await harness.api(actor, 'POST', `/user/${target}/offboarding-impact`, {change}));
}
async function detail(id: string) { return success(await harness.api(harness.actors.ownerA, 'GET', `/activities/${id}`)).activity; }
function options(impact: any, mode: 'defer' | 'replace' = 'defer', replacement = harness.ids.ownerA) {
    return {operationId: randomUUID(), impactFingerprint: impact.fingerprint,
        resolutions: impact.structures.map((row: any) => ({structureId: row.structureId,
            ...(row.activities.orphanCount ? {activities: mode === 'defer' ? {kind: 'defer'} : {kind: 'replace', userId: replacement}} : {}),
            ...(row.appointments.hasFutureAppointments ? {appointments: {kind: 'defer'}} : {})}))};
}
async function deactivate(impact: any, mode: 'defer' | 'replace' = 'defer') {
    return harness.api(harness.actors.ownerA, 'PATCH', `/user/${harness.ids.therapistA}/status`, {active: false, ...options(impact, mode)});
}

test('Team preflight is authorized from current membership and does not accept patient/foreign principals', async () => {
    await create();
    for (const actor of [harness.actors.therapistA, harness.actors.viewerA, harness.actors.patient]) {
        const response = await harness.api(actor, 'POST', `/user/${harness.ids.therapistA}/offboarding-impact`, {change: {kind: 'status', active: false}});
        assert.equal(response.status, 403);
    }
    failure(await harness.api(harness.actors.ownerB, 'POST', `/user/${harness.ids.therapistA}/offboarding-impact`,
        {change: {kind: 'status', active: false}}), 404, 'TEAM_MEMBER_NOT_FOUND');
});

test('unknown and inherited change discriminators are validation failures', async () => {
    for (const kind of ['toString', '__proto__', 'unknown']) {
        failure(await harness.api(harness.actors.ownerA, 'POST', `/user/${harness.ids.therapistA}/offboarding-impact`,
            {change: {kind}}), 422, 'TEAM_VALIDATION_FAILED');
    }
});

test('preflight separates orphan/shared activity counts and excludes completed/archived assignments', async () => {
    const orphan = await create();
    await create({assigneeIds: [harness.ids.therapistA, harness.ids.ownerA]});
    await create({status: 'COMPLETED'});
    const impact = await preflight({kind: 'status', active: false});
    assert.equal(impact.structures.length, 1);
    assert.equal(impact.structures[0].activities.openAssignedCount, 2);
    assert.equal(impact.structures[0].activities.orphanCount, 1);
    assert.equal(impact.structures[0].appointments.hasFutureAppointments, false);
    assert.ok(impact.structures[0].activities.items.some((item: any) => item.id === orphan.id && item.wouldBecomeUnassigned));
});

test('missing explicit orphan decision rolls back status, assignments and audit; legacy agenda defer does not decide activities', async () => {
    const activity = await create();
    const impact = await preflight({kind: 'status', active: false});
    const before = await harness.activities.ActivityHistory.schema(harness.schemas.a).count({where: {activityId: activity.id}});
    failure(await harness.api(harness.actors.ownerA, 'PATCH', `/user/${harness.ids.therapistA}/status`, {
        active: false, operationId: randomUUID(), impactFingerprint: impact.fingerprint, deferReassignment: true
    }), 409, 'OPEN_ACTIVITIES_REQUIRE_REASSIGNMENT');
    assert.equal((await detail(activity.id)).version, activity.version);
    assert.deepEqual((await detail(activity.id)).assigneeIds, [harness.ids.therapistA]);
    assert.equal(await harness.activities.ActivityHistory.schema(harness.schemas.a).count({where: {activityId: activity.id}}), before);
    assert.equal((await harness.auth.TenantUser.findOne({where: {tenantId: harness.ids.tenantA, userId: harness.ids.therapistA}}))?.deactivatedAt, null);
});

test('deferred offboarding clears orphan assignments, cancels alert and leased delivery atomically, and keeps completed history', async () => {
    const due = new Date(Date.now() + 86_400_000).toISOString();
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    const activity = await create({due: {kind: 'timed', at: due}, alert: {scheduledAt, channels: ['inApp']}});
    const completed = await create({status: 'COMPLETED'});
    const alert = await harness.activities.ActivityAlert.schema(harness.schemas.a).findOne({where: {activityId: activity.id}});
    assert.ok(alert);
    const delivery = await harness.activities.ActivityDelivery.schema(harness.schemas.a).create({alertId: alert.id,
        recipientUserId: harness.ids.therapistA, scheduleVersion: alert.scheduleVersion, channel: 'inApp', status: 'PROCESSING',
        scheduledAt, leaseUntil: new Date(Date.now() + 60_000), leaseToken: randomUUID()});
    const boardBefore = success(await harness.api(harness.actors.ownerA, 'GET', '/activities/board'));
    const impact = await preflight({kind: 'status', active: false});
    assert.equal(impact.structures[0].activities.alertsDisabledCount, 1);
    success(await deactivate(impact));
    const updated = await detail(activity.id);
    assert.equal(updated.reassignmentRequired, true);
    assert.deepEqual(updated.assigneeIds, []);
    assert.equal(updated.version, activity.version + 1);
    assert.equal(updated.alert.enabled, false);
    assert.equal(updated.alert.scheduleVersion, 2);
    await alert.reload(); await delivery.reload();
    assert.equal(alert.enabled, false); assert.equal(alert.scheduleVersion, 2);
    assert.equal(delivery.status, 'CANCELLED'); assert.equal(delivery.leaseToken, null); assert.equal(delivery.leaseUntil, null);
    assert.deepEqual((await detail(completed.id)).assigneeIds, [harness.ids.therapistA]);
    const afterBoard = success(await harness.api(harness.actors.ownerA, 'GET', '/activities/board'));
    assert.equal(afterBoard.orderRevision, boardBefore.orderRevision);
    assert.equal(afterBoard.snapshotRevision, boardBefore.snapshotRevision + 1);
    const history = await harness.activities.ActivityHistory.schema(harness.schemas.a).findAll({where: {activityId: activity.id}, raw: true});
    assert.ok(history.some(row => row.eventType === 'ASSIGNEE_OFFBOARDED'));
    assert.ok(history.some(row => row.eventType === 'ALERT_CANCELLED' && row.data.reason === 'LAST_ELIGIBLE_ASSIGNEE_REMOVED'));
});

test('replacement applies only to orphan activities while shared activities keep their valid responsible users', async () => {
    const orphan = await create();
    await harness.auth.StructureUser.create({userId: harness.ids.outsiderA, structureId: harness.ids.structureA, calendarEnabled: false});
    const shared = await create({assigneeIds: [harness.ids.therapistA, harness.ids.outsiderA]});
    success(await deactivate(await preflight({kind: 'status', active: false}), 'replace'));
    assert.deepEqual((await detail(orphan.id)).assigneeIds, [harness.ids.ownerA]);
    assert.deepEqual((await detail(shared.id)).assigneeIds, [harness.ids.outsiderA]);
    assert.equal((await detail(orphan.id)).reassignmentRequired, false);
});

test('stale preflight after an assignment/core change rejects everything with refreshed impact', async () => {
    const activity = await create();
    const impact = await preflight({kind: 'status', active: false});
    success(await harness.api(harness.actors.ownerA, 'PATCH', `/activities/${activity.id}`, {
        operationId: randomUUID(), expectedVersion: activity.version, changes: {title: 'Updated by a colleague'}
    }));
    const failed = await deactivate(impact);
    failure(failed, 409, 'OFFBOARDING_IMPACT_CHANGED');
    assert.notEqual(failed.body.error.impact.fingerprint, impact.fingerprint);
    assert.deepEqual((await detail(activity.id)).assigneeIds, [harness.ids.therapistA]);
});

test('revoked replacement is rejected and leaves membership plus orphan untouched', async () => {
    const activity = await create();
    const impact = await preflight({kind: 'status', active: false});
    const request = options(impact, 'replace', harness.ids.viewerA);
    failure(await harness.api(harness.actors.ownerA, 'PATCH', `/user/${harness.ids.therapistA}/status`, {active: false, ...request}), 409, 'INVALID_ASSIGNEE');
    assert.deepEqual((await detail(activity.id)).assigneeIds, [harness.ids.therapistA]);
});

for (const entry of [
    {kind: 'role', path: 'role', change: () => ({kind: 'role', role: 'VIEWER'}), body: () => ({role: 'VIEWER'})},
    {kind: 'structureRole', path: 'structure-role', change: () => ({kind: 'structureRole', structureId: harness.ids.structureA, role: 'VIEWER'}),
        body: () => ({structureId: harness.ids.structureA, role: 'VIEWER'})},
    {kind: 'structures', path: 'structures', change: () => ({kind: 'structures', structureIds: [harness.ids.structureA2]}),
        body: () => ({structureIds: [harness.ids.structureA2]})},
    {kind: 'profile', path: 'team-profile', change: () => ({kind: 'profile', role: 'VIEWER', structureIds: [harness.ids.structureA]}),
        body: () => ({role: 'VIEWER', structureIds: [harness.ids.structureA], user: {name: 'Updated profile'}})}
]) test(`legacy ${entry.path} mutation invokes the same atomic activity offboarding`, async () => {
    const activity = await create();
    const impact = await preflight(entry.change());
    success(await harness.api(harness.actors.ownerA, entry.kind === 'structures' ? 'PUT' : 'PATCH',
        `/user/${harness.ids.therapistA}/${entry.path}`, {...entry.body(), ...options(impact)}));
    assert.deepEqual((await detail(activity.id)).assigneeIds, []);
    assert.equal((await detail(activity.id)).reassignmentRequired, true);
});

test('a local operational override preserves assignments when the tenant role becomes viewer', async () => {
    await harness.auth.StructureUser.update({role: 'THERAPIST'}, {where: {structureId: harness.ids.structureA, userId: harness.ids.therapistA}});
    const activity = await create();
    const change = {kind: 'role', role: 'VIEWER'};
    const impact = await preflight(change);
    assert.equal(impact.structures.length, 0);
    success(await harness.api(harness.actors.ownerA, 'PATCH', `/user/${harness.ids.therapistA}/role`, {role: 'VIEWER', ...options(impact)}));
    assert.deepEqual((await detail(activity.id)).assigneeIds, [harness.ids.therapistA]);
    assert.equal((await detail(activity.id)).version, activity.version);
});

test('removal receipt replays before missing membership, applies once and rejects reused key with another body', async () => {
    const activity = await create();
    const impact = await preflight({kind: 'remove'});
    const body = options(impact);
    const path = `/user/${harness.ids.therapistA}`;
    success(await harness.api(harness.actors.ownerA, 'DELETE', path, body));
    const replay = success(await harness.api(harness.actors.ownerA, 'DELETE', path, body));
    assert.equal(replay.deleted, 1);
    assert.equal((await detail(activity.id)).version, activity.version + 1);
    failure(await harness.api(harness.actors.ownerA, 'DELETE', path, {...body, resolutions: []}), 409, 'OPERATION_ID_REUSED');
    assert.ok(await harness.auth.User.findByPk(harness.ids.therapistA), 'Global historical identity is preserved');
});

test('calendar-only profile change does not offboard activity assignments or disable their alerts', async () => {
    await harness.auth.StructureUser.update({calendarEnabled: true}, {where: {structureId: harness.ids.structureA, userId: harness.ids.therapistA}});
    const activity = await create({due: {kind: 'timed', at: new Date(Date.now() + 86_400_000).toISOString()},
        alert: {scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), channels: ['inApp']}});
    success(await harness.api(harness.actors.ownerA, 'PATCH', `/user/${harness.ids.therapistA}/team-profile`, {
        operationId: randomUUID(), user: {calendarEnabled: false}, deferReassignment: true
    }));
    const unchanged = await detail(activity.id);
    assert.deepEqual(unchanged.assigneeIds, [harness.ids.therapistA]);
    assert.equal(unchanged.version, activity.version);
    assert.ok(unchanged.alert);
});

test('multi-structure impact gives independent resolution and hides rows from an unreadable board', async () => {
    await harness.auth.TenantUser.update({role: 'SECRETARY'}, {where: {tenantId: harness.ids.tenantA, userId: harness.ids.therapistA}});
    await harness.auth.StructureUser.create({structureId: harness.ids.structureA2, userId: harness.ids.therapistA, calendarEnabled: false});
    await create();
    await create({}, harness.actors.ownerA2);
    await harness.auth.StructureUser.update({role: 'PATIENT'}, {where: {userId: harness.ids.ownerA, structureId: harness.ids.structureA2}});
    // OWNER has no effective local override; remove the actor's local membership to test board visibility.
    await harness.auth.StructureUser.destroy({where: {userId: harness.ids.ownerA, structureId: harness.ids.structureA2}});
    try {
        const impact = await preflight({kind: 'status', active: false});
        assert.equal(impact.structures.length, 2);
        const hidden = impact.structures.find((row: any) => row.structureId === harness.ids.structureA2);
        assert.equal(hidden.activities.canReadDetails, false);
        assert.deepEqual(hidden.activities.items, []);
        assert.equal(hidden.activities.orphanCount, 1);
        success(await deactivate(impact));
    } finally {
        await harness.auth.StructureUser.upsert({userId: harness.ids.ownerA, structureId: harness.ids.structureA2, role: null});
    }
});

test('an audit insertion failure rolls back the Team membership, activity and operation receipt together', async () => {
    const activity = await create();
    const impact = await preflight({kind: 'status', active: false});
    const body = {active: false, ...options(impact)};
    const schema = harness.schemas.a;
    await harness.sequelize.query(`CREATE FUNCTION "${schema}"."test_fail_team_history"() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW."eventType" = 'ASSIGNEE_OFFBOARDED' THEN RAISE EXCEPTION 'isolated Team audit failure'; END IF; RETURN NEW; END $$`);
    await harness.sequelize.query(`CREATE TRIGGER "test_fail_team_history" BEFORE INSERT ON "${schema}"."activity_history"
        FOR EACH ROW EXECUTE FUNCTION "${schema}"."test_fail_team_history"()`);
    try {
        const response = await harness.api(harness.actors.ownerA, 'PATCH', `/user/${harness.ids.therapistA}/status`, body);
        assert.equal(response.status, 500);
        assert.equal((await detail(activity.id)).version, activity.version);
        assert.deepEqual((await detail(activity.id)).assigneeIds, [harness.ids.therapistA]);
        assert.equal(await harness.activities.ActivityOperation.schema(schema).count({where: {operationId: body.operationId}}), 0);
    } finally {
        await harness.sequelize.query(`DROP TRIGGER "test_fail_team_history" ON "${schema}"."activity_history"`);
        await harness.sequelize.query(`DROP FUNCTION "${schema}"."test_fail_team_history"()`);
    }
    success(await harness.api(harness.actors.ownerA, 'PATCH', `/user/${harness.ids.therapistA}/status`, body));
});

test('appointment defer and activity replacement are independent choices within the same atomic offboarding', async () => {
    const activity = await create();
    const {default: AgendaEvent} = await import('../../agenda/models/agendaEvent.model.js');
    const event = await AgendaEvent.schema(harness.schemas.a).create({structureId: harness.ids.structureA,
        calendarId: harness.ids.therapistA, title: 'Isolated appointment', start: new Date(Date.now() + 86_400_000).toISOString(), allDay: false});
    eventIds.push(event.id);
    const impact = await preflight({kind: 'status', active: false});
    assert.equal(impact.structures[0].appointments.futureSingleAppointments, 1);
    const request = options(impact, 'replace');
    success(await harness.api(harness.actors.ownerA, 'PATCH', `/user/${harness.ids.therapistA}/status`, {active: false, ...request}));
    assert.deepEqual((await detail(activity.id)).assigneeIds, [harness.ids.ownerA]);
    await event.reload();
    assert.equal(event.calendarId, harness.ids.therapistA, 'Deferred agenda is not reassigned by an activity choice');
});

for (const appointmentChoice of ['defer', 'replace'] as const) test(`combined profile calendar disable honors ${appointmentChoice} already approved by offboarding`, async () => {
    const activity = await create();
    const {default: AgendaEvent} = await import('../../agenda/models/agendaEvent.model.js');
    await harness.auth.StructureUser.update({calendarEnabled: true}, {where: {
        structureId: harness.ids.structureA, userId: harness.ids.therapistA}});
    if (appointmentChoice === 'replace') await harness.auth.StructureUser.update({calendarEnabled: true}, {where: {
        structureId: harness.ids.structureA, userId: harness.ids.ownerA}});
    const event = await AgendaEvent.schema(harness.schemas.a).create({structureId: harness.ids.structureA,
        calendarId: harness.ids.therapistA, title: 'Combined isolated appointment',
        start: new Date(Date.now() + 86_400_000).toISOString(), allDay: false});
    eventIds.push(event.id);
    const impact = await preflight({kind: 'profile', role: 'VIEWER'});
    const appointment = appointmentChoice === 'defer' ? {kind: 'defer'} : {kind: 'replace', userId: harness.ids.ownerA};
    success(await harness.api(harness.actors.ownerA, 'PATCH', `/user/${harness.ids.therapistA}/team-profile`, {
        role: 'VIEWER', user: {calendarEnabled: false}, operationId: randomUUID(), impactFingerprint: impact.fingerprint,
        resolutions: [{structureId: harness.ids.structureA, activities: {kind: 'defer'}, appointments: appointment}]
    }));
    await event.reload();
    assert.equal(event.calendarId, appointmentChoice === 'defer' ? harness.ids.therapistA : harness.ids.ownerA);
    assert.deepEqual((await detail(activity.id)).assigneeIds, []);
    assert.equal((await detail(activity.id)).reassignmentRequired, true);
    assert.equal((await harness.auth.StructureUser.findOne({where: {structureId: harness.ids.structureA,
        userId: harness.ids.therapistA}}))?.calendarEnabled, false);
});

test('globally deactivated owners cannot satisfy the last operational owner safeguard', async () => {
    await harness.auth.TenantUser.update({role: 'OWNER'}, {where: {tenantId: harness.ids.tenantA, userId: harness.ids.outsiderA}});
    await harness.auth.User.update({deactivatedAt: new Date()}, {where: {id: harness.ids.outsiderA}});
    await harness.auth.TenantUser.update({role: 'SECRETARY'}, {where: {tenantId: harness.ids.tenantA, userId: harness.ids.viewerA}});
    failure(await harness.api(harness.actors.viewerA, 'POST', `/user/${harness.ids.ownerA}/offboarding-impact`,
        {change: {kind: 'status', active: false}}), 409, 'TEAM_OWNER_REQUIRED');
    failure(await harness.api(harness.actors.viewerA, 'PATCH', `/user/${harness.ids.ownerA}/status`,
        {active: false, operationId: randomUUID()}), 409, 'TEAM_OWNER_REQUIRED');
    assert.equal((await harness.auth.TenantUser.findOne({where: {tenantId: harness.ids.tenantA,
        userId: harness.ids.ownerA}}))?.deactivatedAt, null);
});

test('agenda updatedAt changes invalidate the offboarding fingerprint even when schedule stays identical', async () => {
    const {default: AgendaEvent} = await import('../../agenda/models/agendaEvent.model.js');
    const event = await AgendaEvent.schema(harness.schemas.a).create({structureId: harness.ids.structureA,
        calendarId: harness.ids.therapistA, title: 'Fingerprint fixture',
        start: new Date(Date.now() + 86_400_000).toISOString(), allDay: false});
    eventIds.push(event.id);
    const impact = await preflight({kind: 'status', active: false});
    await harness.sequelize.query(`UPDATE "${harness.schemas.a}"."agenda_events" SET "updatedAt" = "updatedAt" + interval '1 second' WHERE "id" = :id`,
        {replacements: {id: event.id}});
    failure(await deactivate(impact), 409, 'OFFBOARDING_IMPACT_CHANGED');
});

test('an offboarding fingerprint is bound to its tenant and selected site', async () => {
    const impact = await preflight({kind: 'profile'});
    const otherSite = await preflight({kind: 'profile'}, harness.actors.ownerA2);
    assert.notEqual(otherSite.fingerprint, impact.fingerprint);
    failure(await harness.api(harness.actors.ownerA2, 'PATCH', `/user/${harness.ids.therapistA}/team-profile`, {
        operationId: randomUUID(), impactFingerprint: impact.fingerprint
    }), 409, 'OFFBOARDING_IMPACT_CHANGED');
});

test('the tenant gate makes assignment versus offboarding resolve as a conflict or an ineligible-assignee rejection', async () => {
    const activity = await create();
    const unassigned = await create({assigneeIds: []});
    const impact = await preflight({kind: 'status', active: false});
    const [offboarding, assigning] = await Promise.all([
        deactivate(impact),
        harness.api(harness.actors.ownerA, 'PATCH', `/activities/${unassigned.id}`, {operationId: randomUUID(),
            expectedVersion: unassigned.version, changes: {assigneeIds: [harness.ids.therapistA]}})
    ]);
    if (offboarding.status === 200) {
        failure(assigning, 422, 'INVALID_ASSIGNEE');
        assert.deepEqual((await detail(activity.id)).assigneeIds, []);
        assert.deepEqual((await detail(unassigned.id)).assigneeIds, []);
    } else {
        failure(offboarding, 409, 'OFFBOARDING_IMPACT_CHANGED');
        success(assigning);
        assert.equal((await harness.auth.TenantUser.findOne({where: {
            tenantId: harness.ids.tenantA, userId: harness.ids.therapistA}}))?.deactivatedAt, null);
    }
});

test('a replay cannot bypass revocation of the current administrator', async () => {
    await create();
    const impact = await preflight({kind: 'status', active: false});
    const body = {active: false, ...options(impact)};
    success(await harness.api(harness.actors.ownerA, 'PATCH', `/user/${harness.ids.therapistA}/status`, body));
    await harness.auth.TenantUser.update({deactivatedAt: new Date()}, {where: {tenantId: harness.ids.tenantA, userId: harness.ids.ownerA}});
    try {
        const result = await harness.api(harness.actors.ownerA, 'PATCH', `/user/${harness.ids.therapistA}/status`, body);
        failure(result, 401, 'AUTH_SESSION_INVALID');
    } finally {
        await harness.auth.TenantUser.update({deactivatedAt: null}, {where: {tenantId: harness.ids.tenantA, userId: harness.ids.ownerA}});
    }
});
