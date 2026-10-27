import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {after, before, test} from 'node:test';
import {Sequelize} from 'sequelize';
import type {ActivityAgendaLinkDto} from '../activities.types.js';
import {createActivitiesHarness, type ActivitiesHarness, type ApiResult} from './activitiesTestHarness.js';

let harness: ActivitiesHarness;
before(async () => {harness = await createActivitiesHarness();}, {timeout: 180_000});
after(async () => {if (harness) await harness.cleanup();}, {timeout: 60_000});

function success(result: ApiResult, status = 200) {
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.equal(result.body.status, 'success');
    return result.body.data;
}

function failure(result: ApiResult, status: number, code?: string) {
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.equal(result.body.status, 'error');
    if (code) assert.equal(result.body.error?.code, code, JSON.stringify(result.body));
}

async function create(label: string, fields: Record<string, unknown> = {}, actor = harness.actors.ownerA) {
    return success(await harness.api(actor, 'POST', '/activities', {
        operationId: randomUUID(), title: `${label} ${randomUUID()}`, ...fields
    }), 201);
}

async function board(actor = harness.actors.ownerA) {
    return success(await harness.api(actor, 'GET', '/activities/board'));
}

async function detail(id: string, actor = harness.actors.ownerA) {
    return success(await harness.api(actor, 'GET', `/activities/${id}`)).activity;
}

async function linkedResources(schema = harness.schemas.a, tenantId = harness.ids.tenantA,
    structureId = harness.ids.structureA, userId = harness.ids.ownerA) {
    // Import only after the harness has verified the explicitly isolated test database.
    const {default: Patient} = await import('../../patients/models/patient.model.js');
    const {default: AgendaEvent} = await import('../../agenda/models/agendaEvent.model.js');
    const patient = await Patient.schema(schema).create({tenantId, structureId, userId,
        name: 'Ada', surname: 'Rossi', notes: 'Clinical text must never enter link metadata'});
    const start = new Date(Date.now() + 86_400_000).toISOString();
    const event = await AgendaEvent.schema(schema).create({structureId, calendarId: userId,
        patientId: patient.id, title: 'Controllo', start, allDay: false,
        description: 'Private event description', patient: {email: 'private@example.invalid'}});
    return {patient, event, start};
}

function localDate(instant: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'})
        .formatToParts(instant);
    const value = (type: string) => parts.find(part => part.type === type)!.value;
    return `${value('year')}-${value('month')}-${value('day')}`;
}

async function migrationCli(mode: '--check' | '--apply', schema: string) {
    const require = createRequire(import.meta.url);
    try {
        const result = await promisify(execFile)(process.execPath, [require.resolve('tsx/cli'),
            'src/scripts/migrateActivities.ts', mode, '--schema', schema], {
            cwd: fileURLToPath(new URL('../../../../', import.meta.url)), timeout: 30_000, maxBuffer: 1024 * 1024, encoding: 'utf8',
            env: {...process.env, DATABASE_URL: harness.testDatabaseUrl, DB_SSL: 'false', NODE_ENV: 'test', TENANT_SCHEMA_SYNC: 'off'}
        });
        return {code: 0, stdout: result.stdout, stderr: result.stderr};
    } catch (error: any) {
        if (typeof error.code !== 'number' || typeof error.stdout !== 'string' || typeof error.stderr !== 'string') throw error;
        return {code: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string};
    }
}

function cliReport(stdout: string) {
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('{'));
    assert.ok(line, 'Migration CLI must emit its readiness report');
    return JSON.parse(line);
}

test('real bootstrap creates exactly one board for every existing structure in its own tenant', async () => {
    const {ActivityBoard} = harness.activities;
    assert.equal(await ActivityBoard.schema(harness.schemas.a).count(), 2);
    assert.equal(await ActivityBoard.schema(harness.schemas.b).count(), 1);
    const a = await board();
    const a2 = await board(harness.actors.ownerA2);
    const b = await board(harness.actors.ownerB);
    assert.equal(a.structureId, harness.ids.structureA);
    assert.equal(a2.structureId, harness.ids.structureA2);
    assert.equal(b.structureId, harness.ids.structureB);
    assert.equal(a.timezone, 'Europe/Rome');
    assert.deepEqual(a.columns.map((column: any) => column.status), ['TODO', 'IN_PROGRESS', 'WAITING', 'COMPLETED']);
    assert.ok(!Number.isNaN(Date.parse(a.serverNow)));
    await harness.tenantSchema.ensureTenantSchema(harness.ids.tenantA);
    assert.equal(await ActivityBoard.schema(harness.schemas.a).count(), 2);
    await assert.rejects(() => ActivityBoard.schema(harness.schemas.a).create({structureId: harness.ids.structureA}));
});

test('a real tenant upgrade is additive, preserves notes/reminders and serializes migration across two connections', {timeout: 120_000}, async () => {
    const {sequelize, notes, schemas, ids, migrations} = harness;
    const note = await notes.Note.schema(schemas.b).create({title: 'Existing note before activities', type: 'INTERNAL',
        ownerUserId: ids.ownerB, createdByUserId: ids.ownerB, structureId: ids.structureB, contentText: 'Preserved content'});
    const reminder = await notes.Reminder.schema(schemas.b).create({title: 'Existing reminder before activities',
        assigneeUserId: ids.ownerB, createdByUserId: ids.ownerB, structureId: ids.structureB,
        dueAt: new Date('2020-02-03T08:09:10.123Z'), remindAt: new Date('2020-02-03T07:09:10.123Z')});
    const oldNote = note.get({plain: true});
    const oldReminder = reminder.get({plain: true});
    const tables = ['activity_deliveries', 'activity_alerts', 'activity_operations', 'activity_history',
        'activity_comments', 'activity_checklist_items', 'activity_assignments', 'activities', 'activity_boards'];
    for (const table of tables) await sequelize.query(`DROP TABLE "${schemas.b}"."${table}" CASCADE`);
    await sequelize.query(`DELETE FROM "${schemas.b}"."schema_migrations" WHERE "version" IN (:versions)`, {
        replacements: {versions: [migrations.ACTIVITIES_FOUNDATION_VERSION, migrations.TENANT_MODEL_BASELINE_VERSION]}
    });
    await sequelize.query(`INSERT INTO "${schemas.b}"."schema_migrations" ("version") VALUES (:version)
        ON CONFLICT ("version") DO NOTHING`, {replacements: {version: '20261010-tenant-model-baseline-v13'}});

    // HTTP must report the missing deployment migration, without creating any tables.
    failure(await harness.api(harness.actors.ownerB, 'GET', '/activities/board'), 503, 'ACTIVITY_BOARD_UNAVAILABLE');
    const tableAbsent = async () => {
        const [rows] = await sequelize.query('SELECT to_regclass(:table) AS name', {
            replacements: {table: `"${schemas.b}"."activity_boards"`}
        });
        assert.equal((rows[0] as any).name, null);
    };
    await tableAbsent();
    const beforeCheck = await migrationCli('--check', schemas.b);
    assert.equal(beforeCheck.code, 2, beforeCheck.stderr);
    assert.equal(cliReport(beforeCheck.stdout).ready, false);
    await tableAbsent();
    const [unapplied] = await sequelize.query(`SELECT 1 FROM "${schemas.b}"."schema_migrations" WHERE "version" = :version`, {
        replacements: {version: migrations.ACTIVITIES_FOUNDATION_VERSION}
    });
    assert.equal(unapplied.length, 0, '--check must not insert a migration receipt');
    const applied = await migrationCli('--apply', schemas.b);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(cliReport(applied.stdout).ready, true);
    const afterCheck = await migrationCli('--check', schemas.b);
    assert.equal(afterCheck.code, 0, afterCheck.stderr);
    assert.equal(cliReport(afterCheck.stdout).ready, true);
    const boardBeforeReplay = await harness.activities.ActivityBoard.schema(schemas.b).findOne({where: {structureId: ids.structureB}});
    assert.ok(boardBeforeReplay);
    const reapplied = await migrationCli('--apply', schemas.b);
    assert.equal(reapplied.code, 0, reapplied.stderr);
    assert.equal((await harness.activities.ActivityBoard.schema(schemas.b).findOne({where: {structureId: ids.structureB}}))!.id, boardBeforeReplay.id);
    assert.equal(await harness.activities.ActivityBoard.schema(schemas.b).count(), 1);

    const missingSchema = harness.tenantSchema.getTenantSchemaName(randomUUID());
    harness.extraSchemas.push(missingSchema);
    const missing = await migrationCli('--apply', missingSchema);
    assert.equal(missing.code, 1, missing.stderr);
    const [schemaRows] = await sequelize.query('SELECT 1 FROM pg_namespace WHERE nspname = :schema', {replacements: {schema: missingSchema}});
    assert.equal(schemaRows.length, 0, 'Explicit selection of a nonexistent tenant must not CREATE SCHEMA');

    // Exercise the real advisory migration lock with two independent connection pools,
    // including an idempotent existing-table migration whose receipt still needs recording.
    await sequelize.query(`DELETE FROM "${schemas.b}"."schema_migrations" WHERE "version" = :version`, {
        replacements: {version: migrations.ACTIVITIES_FOUNDATION_VERSION}
    });

    const otherConnection = new Sequelize(process.env.DATABASE_URL!, {dialect: 'postgres', logging: false});
    try {
        const completed = await Promise.all([
            migrations.runTenantMigrations(schemas.b, false, sequelize),
            migrations.runTenantMigrations(schemas.b, false, otherConnection)
        ]);
        assert.equal(completed.flat().filter(version => version === migrations.ACTIVITIES_FOUNDATION_VERSION).length, 1);
    } finally {
        await otherConnection.close();
    }
    harness.tenantSchema.invalidateTenantSchemaCache(ids.tenantB);
    await harness.tenantSchema.ensureTenantSchema(ids.tenantB);
    assert.equal(await harness.activities.ActivityBoard.schema(schemas.b).count(), 1);
    assert.deepEqual((await notes.Note.schema(schemas.b).findByPk(note.id))!.get({plain: true}), oldNote);
    assert.deepEqual((await notes.Reminder.schema(schemas.b).findByPk(reminder.id))!.get({plain: true}), oldReminder);
    await harness.releaseControl.assertTenantReady(schemas.b, harness.databaseManifest, sequelize);
    assert.equal((await harness.activities.ActivityBoard.schema(schemas.b).findOne({where: {structureId: ids.structureB}}))!.id, boardBeforeReplay.id);
    const [versions] = await sequelize.query(`SELECT "version" FROM "${schemas.b}"."schema_migrations"
        WHERE "version" = :version`, {replacements: {version: migrations.ACTIVITIES_FOUNDATION_VERSION}});
    assert.equal(versions.length, 1);
});

test('migration DDL and seed rows roll back with the caller transaction on an empty tenant schema', async () => {
    const schema = harness.tenantSchema.getTenantSchemaName(randomUUID());
    harness.extraSchemas.push(schema);
    await harness.sequelize.query(`CREATE SCHEMA "${schema}"`);
    await assert.rejects(() => harness.sequelize.transaction(async transaction => {
        await harness.activitiesMigration.up(harness.sequelize.getQueryInterface(), {schema, transaction});
        const [rows] = await harness.sequelize.query('SELECT to_regclass(:table) AS name', {
            transaction, replacements: {table: `"${schema}"."activities"`}
        });
        assert.ok((rows[0] as any).name);
        throw new Error('forced migration rollback');
    }), /forced migration rollback/);
    const [rows] = await harness.sequelize.query('SELECT to_regclass(:table) AS name', {
        replacements: {table: `"${schema}"."activities"`}
    });
    assert.equal((rows[0] as any).name, null);
});

test('API checks authentication, active database context and patient exclusion instead of trusting JWT permissions', async () => {
    failure(await harness.api(null, 'GET', '/activities/board'), 401);
    failure(await harness.api(harness.actors.patient, 'GET', '/activities/board'), 403, 'ACTIVITY_FORBIDDEN');
    for (const actor of [harness.actors.outsiderA, harness.actors.foreignStructure]) {
        failure(await harness.api(actor, 'GET', '/activities/board'), 401, 'AUTH_SESSION_INVALID');
    }
    const missing = await harness.api(harness.actors.missingStructure, 'GET', '/activities/board');
    assert.ok([403, 422].includes(missing.status), JSON.stringify(missing.body));
    const viewer = await board(harness.actors.viewerA);
    assert.equal(viewer.capabilities.canCreate, false);
    failure(await harness.api(harness.actors.viewerA, 'POST', '/activities', {
        operationId: randomUUID(), title: 'JWT says owner, database says viewer'
    }), 403, 'ACTIVITY_FORBIDDEN');

    const portalWhere = {id: harness.actors.patient.patientAccessId};
    await harness.auth.PatientPortalAccess.update({status: 'REVOKED'}, {where: portalWhere});
    try {
        failure(await harness.api(harness.actors.patient, 'GET', '/activities/board'), 401, 'AUTH_SESSION_INVALID');
    } finally {
        await harness.auth.PatientPortalAccess.update({status: 'ACTIVE'}, {where: portalWhere});
    }

    await harness.auth.TenantUser.update({deactivatedAt: new Date()}, {
        where: {tenantId: harness.ids.tenantA, userId: harness.ids.therapistA}
    });
    try {
        failure(await harness.api(harness.actors.therapistA, 'GET', '/activities/board'), 401, 'AUTH_SESSION_INVALID');
    } finally {
        await harness.auth.TenantUser.update({deactivatedAt: null}, {
            where: {tenantId: harness.ids.tenantA, userId: harness.ids.therapistA}
        });
    }
});

test('selected structure filters reads and writes even for an owner with tenant permissions', async () => {
    const created = await create('Private to selected structure');
    for (const actor of [harness.actors.ownerA2, harness.actors.ownerB]) {
        failure(await harness.api(actor, 'GET', `/activities/${created.activity.id}`), 404);
        failure(await harness.api(actor, 'PATCH', `/activities/${created.activity.id}`, {
            operationId: randomUUID(), expectedVersion: created.activity.version, changes: {title: 'Unauthorized overwrite'}
        }), 404);
        const listed = success(await harness.api(actor, 'GET', '/activities?view=list'));
        assert.ok(!listed.items.some((item: any) => item.id === created.activity.id));
    }
    failure(await harness.api(harness.actors.ownerA, 'POST', '/activities', {
        operationId: randomUUID(), title: 'Reject client supplied board', boardId: (await board(harness.actors.ownerA2)).id
    }), 422);
});

test('create persists normalized fields, eligible assignments and the initial checklist atomically', async () => {
    const created = await create('Initial checklist', {
        description: 'Initial description', assigneeIds: [harness.ids.therapistA],
        checklist: [{text: 'First step'}, {text: 'Second step'}], priority: 'HIGH'
    });
    const activity = created.activity;
    assert.equal(activity.version, 1);
    assert.equal(activity.priority, 'HIGH');
    const assignment = await harness.activities.ActivityAssignment.schema(harness.schemas.a).findOne({
        where: {activityId: activity.id, userId: harness.ids.therapistA}
    });
    assert.ok(assignment, 'calendarEnabled=false must not make a team member ineligible');
    const checklist = await harness.activities.ActivityChecklistItem.schema(harness.schemas.a).findAll({
        where: {activityId: activity.id}, order: [['position', 'ASC']]
    });
    assert.deepEqual(checklist.map(item => item.get('text')), ['First step', 'Second step']);
    assert.ok(checklist.every(item => item.get('checked') === false));
    assert.equal(new Set(checklist.map(item => String(item.get('position')))).size, 2);
    assert.equal((await detail(activity.id)).checklistRevision, activity.checklistRevision);
    const before = await harness.activities.Activity.schema(harness.schemas.a).count();
    failure(await harness.api(harness.actors.ownerA, 'POST', '/activities', {
        operationId: randomUUID(), title: 'Invalid checklist must not partially create', checklist: [{text: 'valid'}, {text: '   '}]
    }), 422, 'ACTIVITY_VALIDATION_FAILED');
    assert.equal(await harness.activities.Activity.schema(harness.schemas.a).count(), before);
});

test('invalid assignees and unvalidated related-resource IDs cannot be persisted', async () => {
    for (const assigneeId of [harness.ids.outsiderA, harness.ids.ownerB, randomUUID()]) {
        failure(await harness.api(harness.actors.ownerA, 'POST', '/activities', {
            operationId: randomUUID(), title: 'Invalid assignee', assigneeIds: [assigneeId]
        }), 422, 'INVALID_ASSIGNEE');
    }
    for (const field of ['patientId', 'agendaEventId']) {
        failure(await harness.api(harness.actors.ownerA, 'POST', '/activities', {
            operationId: randomUUID(), title: 'Invalid related resource', [field]: randomUUID()
        }), 404, 'ACTIVITY_NOT_FOUND');
    }
});

test('own-scope update permits a creator or assignee, while other readable activities remain protected', async () => {
    const owned = await create('Therapist creator', {}, harness.actors.therapistA);
    success(await harness.api(harness.actors.therapistA, 'PATCH', `/activities/${owned.activity.id}`, {
        operationId: randomUUID(), expectedVersion: owned.activity.version, changes: {description: 'Creator update'}
    }));
    const assigned = await create('Therapist assigned', {assigneeIds: [harness.ids.therapistA]});
    success(await harness.api(harness.actors.therapistA, 'PATCH', `/activities/${assigned.activity.id}`, {
        operationId: randomUUID(), expectedVersion: assigned.activity.version, changes: {description: 'Assignee update'}
    }));
    const unrelated = await create('Readable but not owned');
    success(await harness.api(harness.actors.therapistA, 'GET', `/activities/${unrelated.activity.id}`));
    failure(await harness.api(harness.actors.therapistA, 'PATCH', `/activities/${unrelated.activity.id}`, {
        operationId: randomUUID(), expectedVersion: unrelated.activity.version, changes: {description: 'Forbidden'}
    }), 403);
});

test('strict due-date input rejects impossible civil dates, past instants and ambiguous local timestamps', async () => {
    const timezone = (await board()).timezone;
    const past = new Date(Date.now() - 60_000).toISOString();
    for (const due of [
        {kind: 'timed', at: past}, {kind: 'timed', at: '2030-03-31T02:30:00'},
        {kind: 'timed', at: '2030-02-30T10:00:00Z'}, {kind: 'timed', at: 'invalid'},
        {kind: 'allDay', date: '2030-02-30', timezone},
        {kind: 'allDay', date: '2020-01-01', timezone},
        {kind: 'allDay', date: '2030-01-01', timezone: 'America/New_York'},
        {kind: 'allDay', date: '2030-01-01', timezone, at: '2030-01-01T09:00:00Z'}
    ]) {
        failure(await harness.api(harness.actors.ownerA, 'POST', '/activities', {
            operationId: randomUUID(), title: 'Invalid due date', due
        }), 422, 'ACTIVITY_VALIDATION_FAILED');
    }
});

test('all-day today remains a civil date and optional scheduling does not create an alert', async () => {
    const timezone = (await board()).timezone;
    const today = localDate(new Date(), timezone);
    const created = await create('All-day today', {due: {kind: 'allDay', date: today, timezone}});
    const stored = await harness.activities.Activity.schema(harness.schemas.a).findByPk(created.activity.id);
    assert.equal(stored!.get('dueKind'), 'allDay');
    assert.equal(stored!.get('dueDate'), today);
    assert.equal(stored!.get('dueTimezone'), timezone);
    assert.equal(stored!.get('dueAt'), null);
    assert.equal(await harness.activities.ActivityAlert.schema(harness.schemas.a).count({where: {activityId: created.activity.id}}), 0);
    const unscheduled = await create('No schedule', {due: null});
    assert.equal((await harness.activities.Activity.schema(harness.schemas.a).findByPk(unscheduled.activity.id))!.get('dueKind'), null);
});

test('an unchanged historical due instant survives descriptive editing, while past rescheduling is rejected', async () => {
    const created = await create('Historical due', {due: {kind: 'timed', at: new Date(Date.now() + 3_600_000).toISOString()}});
    const historic = new Date('2020-02-03T08:09:10.123Z');
    await harness.activities.Activity.schema(harness.schemas.a).update({dueAt: historic}, {where: {id: created.activity.id}});
    const edited = success(await harness.api(harness.actors.ownerA, 'PATCH', `/activities/${created.activity.id}`, {
        operationId: randomUUID(), expectedVersion: created.activity.version, changes: {description: 'Still working on this overdue task'}
    }));
    const stored = await harness.activities.Activity.schema(harness.schemas.a).findByPk(created.activity.id);
    assert.equal((stored!.get('dueAt') as Date).toISOString(), historic.toISOString());
    failure(await harness.api(harness.actors.ownerA, 'PATCH', `/activities/${created.activity.id}`, {
        operationId: randomUUID(), expectedVersion: edited.activity.version,
        changes: {due: {kind: 'timed', at: '2020-02-03T08:10:00.000Z'}}
    }), 422, 'ACTIVITY_VALIDATION_FAILED');
});

test('explicit future alerts require eligible recipients and cannot occur after the due instant', async () => {
    const dueAt = new Date(Date.now() + 3_600_000).toISOString();
    const scheduledAt = new Date(Date.now() + 1_800_000).toISOString();
    const created = await create('Explicit alert', {assigneeIds: [harness.ids.therapistA],
        due: {kind: 'timed', at: dueAt}, alert: {scheduledAt, channels: ['inApp']}});
    const alert = await harness.activities.ActivityAlert.schema(harness.schemas.a).findOne({where: {activityId: created.activity.id}});
    assert.equal(alert!.get('enabled'), true);
    assert.equal((alert!.get('scheduledAt') as Date).toISOString(), scheduledAt);
    assert.equal(await harness.activities.ActivityDelivery.schema(harness.schemas.a).count({where: {alertId: alert!.get('id')}}), 0);
    for (const fields of [
        {alert: {scheduledAt}, assigneeIds: []},
        {alert: {scheduledAt: new Date(Date.now() - 60_000).toISOString()}, assigneeIds: [harness.ids.therapistA]},
        {alert: {scheduledAt: new Date(Date.now() + 7_200_000).toISOString()}, assigneeIds: [harness.ids.therapistA]}
    ]) {
        failure(await harness.api(harness.actors.ownerA, 'POST', '/activities', {
            operationId: randomUUID(), title: 'Invalid alert', due: {kind: 'timed', at: dueAt}, ...fields
        }), 422, 'INVALID_ALERT');
    }
    failure(await harness.api(harness.actors.ownerA, 'PATCH', `/activities/${created.activity.id}`, {
        operationId: randomUUID(), expectedVersion: created.activity.version, changes: {assigneeIds: []}
    }), 422, 'INVALID_ALERT');
    const disabled = success(await harness.api(harness.actors.ownerA, 'PATCH', `/activities/${created.activity.id}`, {
        operationId: randomUUID(), expectedVersion: created.activity.version, changes: {assigneeIds: [], alert: null}
    }));
    assert.equal(disabled.activity.version, created.activity.version + 1);
    assert.equal((await harness.activities.ActivityAlert.schema(harness.schemas.a).findByPk(alert!.get('id') as string))!.get('enabled'), false);
});

test('alert activation rechecks unchanged assignees after their structure role loses eligibility', async () => {
    const created = await create('Role changed before alert', {assigneeIds: [harness.ids.therapistA],
        due: {kind: 'timed', at: new Date(Date.now() + 7_200_000).toISOString()}});
    await harness.auth.StructureUser.update({role: 'VIEWER'}, {
        where: {structureId: harness.ids.structureA, userId: harness.ids.therapistA}
    });
    try {
        failure(await harness.api(harness.actors.ownerA, 'PATCH', `/activities/${created.activity.id}`, {
            operationId: randomUUID(), expectedVersion: created.activity.version,
            changes: {alert: {scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), channels: ['inApp']}}
        }), 422, 'INVALID_ALERT');
        assert.equal(await harness.activities.ActivityAlert.schema(harness.schemas.a).count({where: {activityId: created.activity.id}}), 0);
    } finally {
        await harness.auth.StructureUser.update({role: null}, {
            where: {structureId: harness.ids.structureA, userId: harness.ids.therapistA}
        });
    }
});

test('operation replay returns the original canonical result and concurrent create retries persist only once', async () => {
    const operationId = randomUUID();
    const request = {operationId, title: 'Concurrent operation ' + randomUUID(), checklist: [{text: 'One initial step'}]};
    const responses = await Promise.all([
        harness.api(harness.actors.ownerA, 'POST', '/activities', request),
        harness.api(harness.actors.ownerA, 'POST', '/activities', request)
    ]);
    const first = success(responses[0], 201);
    success(responses[1], 201);
    assert.deepEqual(responses[1].body, responses[0].body);
    assert.equal(await harness.activities.Activity.schema(harness.schemas.a).count({where: {id: first.activity.id}}), 1);
    assert.equal(await harness.activities.ActivityChecklistItem.schema(harness.schemas.a).count({where: {activityId: first.activity.id}}), 1);
    assert.equal(await harness.activities.ActivityOperation.schema(harness.schemas.a).count({where: {operationId}}), 1);
    failure(await harness.api(harness.actors.ownerA, 'POST', '/activities', {...request, title: 'Different payload'}), 409, 'OPERATION_ID_REUSED');
});

test('an existing operation receipt does not bypass a membership revoked after the original command', async () => {
    const request = {operationId: randomUUID(), title: 'Authorized receipt ' + randomUUID()};
    success(await harness.api(harness.actors.therapistA, 'POST', '/activities', request), 201);
    await harness.auth.StructureUser.destroy({where: {structureId: harness.ids.structureA, userId: harness.ids.therapistA}});
    try {
        failure(await harness.api(harness.actors.therapistA, 'POST', '/activities', request), 401, 'AUTH_SESSION_INVALID');
    } finally {
        await harness.auth.StructureUser.create({structureId: harness.ids.structureA, userId: harness.ids.therapistA, calendarEnabled: false});
    }
});

test('a failed history insert rolls back the activity, assignments, checklist and operation receipt together', async () => {
    const {sequelize, schemas, activities, ids} = harness;
    const title = 'Rollback transaction ' + randomUUID();
    const operationId = randomUUID();
    await sequelize.query(`CREATE FUNCTION "${schemas.a}"."test_fail_activity_history"() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'activities integration forced history failure'; END; $$`);
    await sequelize.query(`CREATE TRIGGER "test_fail_activity_history" BEFORE INSERT ON "${schemas.a}"."activity_history"
        FOR EACH ROW EXECUTE FUNCTION "${schemas.a}"."test_fail_activity_history"()`);
    try {
        failure(await harness.api(harness.actors.ownerA, 'POST', '/activities', {
            operationId, title, assigneeIds: [ids.therapistA], checklist: [{text: 'Must be rolled back'}]
        }), 500);
    } finally {
        await sequelize.query(`DROP TRIGGER "test_fail_activity_history" ON "${schemas.a}"."activity_history"`);
        await sequelize.query(`DROP FUNCTION "${schemas.a}"."test_fail_activity_history"()`);
    }
    assert.equal(await activities.Activity.schema(schemas.a).count({where: {title}}), 0);
    assert.equal(await activities.ActivityOperation.schema(schemas.a).count({where: {operationId}}), 0);
    const retried = success(await harness.api(harness.actors.ownerA, 'POST', '/activities', {
        operationId, title, assigneeIds: [ids.therapistA], checklist: [{text: 'Must be rolled back'}]
    }), 201);
    assert.equal(await activities.ActivityAssignment.schema(schemas.a).count({where: {activityId: retried.activity.id}}), 1);
    assert.equal(await activities.ActivityChecklistItem.schema(schemas.a).count({where: {activityId: retried.activity.id}}), 1);
});

test('concurrent core edits have one winner, preserve order revision and replay before checking stale versions', async () => {
    const created = await create('Concurrent edit');
    const initial = await board();
    const operationA = randomUUID();
    const requests = [
        {operationId: operationA, expectedVersion: created.activity.version, changes: {description: 'Editor A'}},
        {operationId: randomUUID(), expectedVersion: created.activity.version, changes: {description: 'Editor B'}}
    ];
    const responses = await Promise.all(requests.map(request =>
        harness.api(harness.actors.ownerA, 'PATCH', `/activities/${created.activity.id}`, request)));
    assert.deepEqual(responses.map(result => result.status).sort(), [200, 409]);
    const winnerIndex = responses.findIndex(result => result.status === 200);
    const winner = success(responses[winnerIndex]);
    failure(responses[1 - winnerIndex], 409, 'ACTIVITY_VERSION_CONFLICT');
    assert.equal(winner.activity.version, created.activity.version + 1);
    assert.equal(winner.orderRevision, initial.orderRevision);
    const replay = await harness.api(harness.actors.ownerA, 'PATCH', `/activities/${created.activity.id}`, requests[winnerIndex]);
    success(replay);
    assert.deepEqual(replay.body, responses[winnerIndex].body);
    assert.equal((await detail(created.activity.id)).version, created.activity.version + 1);
});

test('same-column anchor moves change order independently, stale order is rejected and foreign anchors never fall back to end', async () => {
    const group = randomUUID();
    const first = await create(group + ' first', {status: 'WAITING'});
    const second = await create(group + ' second', {status: 'WAITING'});
    const third = await create(group + ' third', {status: 'WAITING'});
    const initial = await board();
    const moved = success(await harness.api(harness.actors.ownerA, 'POST', `/activities/${third.activity.id}/move`, {
        operationId: randomUUID(), expectedVersion: third.activity.version, expectedOrderRevision: initial.orderRevision,
        targetStatus: 'WAITING', placement: {kind: 'before', activityId: second.activity.id}
    }));
    assert.equal(moved.activity.version, third.activity.version);
    assert.equal(moved.orderRevision, initial.orderRevision + 1);
    const listed = success(await harness.api(harness.actors.ownerA, 'GET', `/activities?view=list&statuses=WAITING&search=${group}`));
    assert.deepEqual(listed.items.map((item: any) => item.id), [first.activity.id, third.activity.id, second.activity.id]);
    failure(await harness.api(harness.actors.ownerA, 'POST', `/activities/${first.activity.id}/move`, {
        operationId: randomUUID(), expectedVersion: first.activity.version, expectedOrderRevision: initial.orderRevision,
        targetStatus: 'WAITING', placement: {kind: 'end'}
    }), 409, 'ORDER_CONFLICT');
    const foreign = await create('Foreign anchor', {status: 'WAITING'}, harness.actors.ownerA2);
    failure(await harness.api(harness.actors.ownerA, 'POST', `/activities/${first.activity.id}/move`, {
        operationId: randomUUID(), expectedVersion: first.activity.version, expectedOrderRevision: moved.orderRevision,
        targetStatus: 'WAITING', placement: {kind: 'before', activityId: foreign.activity.id}
    }), 409, 'ORDER_CONFLICT');
});

test('concurrent cross-column moves have one winner and update core and order exactly once', async () => {
    const created = await create('Concurrent move');
    const initial = await board();
    const responses = await Promise.all(['IN_PROGRESS', 'WAITING'].map(targetStatus =>
        harness.api(harness.actors.ownerA, 'POST', `/activities/${created.activity.id}/move`, {
            operationId: randomUUID(), expectedVersion: created.activity.version,
            expectedOrderRevision: initial.orderRevision, targetStatus, placement: {kind: 'end'}
        })));
    assert.deepEqual(responses.map(result => result.status).sort(), [200, 409]);
    const winner = success(responses.find(result => result.status === 200)!);
    assert.equal(winner.activity.version, created.activity.version + 1);
    assert.equal(winner.orderRevision, initial.orderRevision + 1);
    assert.equal((await detail(created.activity.id)).status, winner.activity.status);
});

test('completion requires the current checklist revision and an explicit incomplete-checklist decision, and disables alerts', async () => {
    const created = await create('Completion check', {checklist: [{text: 'Still open'}], assigneeIds: [harness.ids.therapistA],
        due: {kind: 'timed', at: new Date(Date.now() + 7_200_000).toISOString()},
        alert: {scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), channels: ['inApp']}});
    const initial = await board();
    const request = {expectedVersion: created.activity.version, expectedOrderRevision: initial.orderRevision,
        targetStatus: 'COMPLETED', placement: {kind: 'end'}, expectedChecklistRevision: created.activity.checklistRevision};
    failure(await harness.api(harness.actors.ownerA, 'POST', `/activities/${created.activity.id}/move`, {
        ...request, operationId: randomUUID(), allowIncompleteChecklist: true,
        expectedChecklistRevision: created.activity.checklistRevision + 1
    }), 409, 'CHECKLIST_VERSION_CONFLICT');
    const unconfirmed = await harness.api(harness.actors.ownerA, 'POST', `/activities/${created.activity.id}/move`, {
        ...request, operationId: randomUUID()
    });
    assert.ok([409, 422].includes(unconfirmed.status), JSON.stringify(unconfirmed.body));
    const completed = success(await harness.api(harness.actors.ownerA, 'POST', `/activities/${created.activity.id}/move`, {
        ...request, operationId: randomUUID(), allowIncompleteChecklist: true
    }));
    assert.equal(completed.activity.status, 'COMPLETED');
    const stored = await harness.activities.Activity.schema(harness.schemas.a).findByPk(created.activity.id);
    assert.ok(stored!.get('completedAt'));
    assert.equal((await harness.activities.ActivityAlert.schema(harness.schemas.a).findOne({where: {activityId: created.activity.id}}))!.get('enabled'), false);
});

test('archive and restore preserve status, move membership atomically and prevent writes while archived', async () => {
    const created = await create('Archive lifecycle', {status: 'IN_PROGRESS'});
    const initial = await board();
    const archived = success(await harness.api(harness.actors.ownerA, 'POST', `/activities/${created.activity.id}/archive`, {
        operationId: randomUUID(), expectedVersion: created.activity.version, expectedOrderRevision: initial.orderRevision
    }));
    assert.equal(archived.activity.status, 'IN_PROGRESS');
    assert.equal(archived.activity.version, created.activity.version + 1);
    failure(await harness.api(harness.actors.ownerA, 'PATCH', `/activities/${created.activity.id}`, {
        operationId: randomUUID(), expectedVersion: archived.activity.version, changes: {title: 'Blocked archived edit'}
    }), 409, 'INVALID_TRANSITION');
    const archiveList = success(await harness.api(harness.actors.ownerA, 'GET', `/activities?view=archived&search=${encodeURIComponent(created.activity.title)}`));
    assert.equal(archiveList.total, 1);
    assert.equal(archiveList.items[0].id, created.activity.id);
    const restored = success(await harness.api(harness.actors.ownerA, 'POST', `/activities/${created.activity.id}/restore`, {
        operationId: randomUUID(), expectedVersion: archived.activity.version, expectedOrderRevision: archived.orderRevision
    }));
    assert.equal(restored.activity.status, 'IN_PROGRESS');
    assert.equal(restored.activity.version, archived.activity.version + 1);
    assert.equal(restored.orderRevision, archived.orderRevision + 1);
});

test('list and board pagination share counts, keep evaluationAt stable and reject stale or cross-query cursors', async () => {
    const group = randomUUID();
    for (let index = 0; index < 5; index++) await create(`${group} card ${index}`, {status: 'TODO'});
    const path = `/activities?view=list&statuses=TODO&search=${group}&limit=2`;
    const first = success(await harness.api(harness.actors.ownerA, 'GET', path));
    assert.equal(first.total, 5);
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    const second = success(await harness.api(harness.actors.ownerA, 'GET', `${path}&cursor=${encodeURIComponent(first.nextCursor)}`));
    assert.equal(second.total, 5);
    assert.equal(second.evaluationAt, first.evaluationAt);
    assert.equal(second.snapshotRevision, first.snapshotRevision);
    assert.equal(new Set([...first.items, ...second.items].map((item: any) => item.id)).size, 4);
    const boardPage = success(await harness.api(harness.actors.ownerA, 'GET',
        `/activities?view=board&search=${group}&limits=${encodeURIComponent(JSON.stringify({TODO: 3}))}`));
    const todo = boardPage.columns.find((column: any) => column.status === 'TODO');
    assert.equal(todo.total, 5);
    assert.equal(todo.items.length, 3);
    assert.ok(todo.nextCursor);
    failure(await harness.api(harness.actors.ownerA, 'GET', `${path}&priority=URGENT&cursor=${encodeURIComponent(first.nextCursor)}`),
        409, 'ACTIVITY_CURSOR_EXPIRED');
    failure(await harness.api(harness.actors.ownerA2, 'GET', `${path}&cursor=${encodeURIComponent(first.nextCursor)}`),
        409, 'ACTIVITY_CURSOR_EXPIRED');
    const target = first.items[0];
    success(await harness.api(harness.actors.ownerA, 'PATCH', `/activities/${target.id}`, {
        operationId: randomUUID(), expectedVersion: target.version, changes: {priority: 'URGENT'}
    }));
    failure(await harness.api(harness.actors.ownerA, 'GET', `${path}&cursor=${encodeURIComponent(first.nextCursor)}`),
        409, 'ACTIVITY_CURSOR_EXPIRED');
});

test('assignment and temporal filters count only matching records without fabricating a due date', async () => {
    const group = randomUUID();
    const timezone = (await board()).timezone;
    const today = localDate(new Date(), timezone);
    const todayTask = await create(group + ' today', {due: {kind: 'allDay', date: today, timezone}, assigneeIds: [harness.ids.therapistA]});
    const overdueTask = await create(group + ' overdue', {due: {kind: 'timed', at: new Date(Date.now() + 3_600_000).toISOString()}, assigneeIds: []});
    const overdueInstant = new Date(Date.now() - 60_000);
    await harness.activities.Activity.schema(harness.schemas.a).update({dueAt: overdueInstant}, {where: {id: overdueTask.activity.id}});
    const noDueTask = await create(group + ' unscheduled', {due: null, assigneeIds: []});
    const todayIds = [todayTask.activity.id];
    if (localDate(overdueInstant, timezone) === today) todayIds.push(overdueTask.activity.id);
    for (const [due, expected] of [['today', todayIds],
        ['overdue', [overdueTask.activity.id]], ['none', [noDueTask.activity.id]]] as const) {
        const data = success(await harness.api(harness.actors.ownerA, 'GET', `/activities?view=list&search=${group}&due=${due}`));
        // A timed task overdue earlier today also belongs to the civil-day Today filter.
        assert.deepEqual(data.items.map((item: any) => item.id).sort(), [...expected].sort());
        assert.equal(data.total, expected.length);
    }
    const mine = success(await harness.api(harness.actors.therapistA, 'GET', `/activities?view=list&search=${group}&mine=true`));
    assert.deepEqual(mine.items.map((item: any) => item.id), [todayTask.activity.id]);
    const unassigned = success(await harness.api(harness.actors.ownerA, 'GET', `/activities?view=list&search=${group}&unassigned=true`));
    assert.equal(unassigned.total, 2);
});

test('the default completed window uses completion date, and explicit history includes older completions', async () => {
    const group = randomUUID();
    const recent = await create(group + ' recent', {status: 'COMPLETED'});
    const old = await create(group + ' old', {status: 'COMPLETED',
        due: {kind: 'timed', at: new Date(Date.now() + 7_200_000).toISOString()}});
    await harness.activities.Activity.schema(harness.schemas.a).update({completedAt: new Date(Date.now() - 40 * 86_400_000)},
        {where: {id: old.activity.id}});
    const path = `/activities?view=list&statuses=COMPLETED&search=${group}`;
    const current = success(await harness.api(harness.actors.ownerA, 'GET', path));
    assert.equal(current.total, 1);
    assert.deepEqual(current.items.map((item: any) => item.id), [recent.activity.id]);
    const all = success(await harness.api(harness.actors.ownerA, 'GET', path + '&includeAllCompleted=true'));
    assert.equal(all.total, 2);
    assert.deepEqual(all.items.map((item: any) => item.id).sort(), [recent.activity.id, old.activity.id].sort());
});

test('database constraints independently reject inconsistent due tuples and colliding active order positions', async () => {
    const first = await create('Constraint first', {status: 'WAITING'});
    const second = await create('Constraint second', {status: 'WAITING'});
    await assert.rejects(() => harness.sequelize.query(`UPDATE "${harness.schemas.a}"."activities"
        SET "dueKind" = 'allDay', "dueDate" = '2030-01-01', "dueTimezone" = 'Europe/Rome', "dueAt" = NOW()
        WHERE "id" = :id`, {replacements: {id: first.activity.id}}));
    const firstRow = await harness.activities.Activity.schema(harness.schemas.a).findByPk(first.activity.id);
    await assert.rejects(() => harness.activities.Activity.schema(harness.schemas.a).update({position: firstRow!.get('position')},
        {where: {id: second.activity.id}}));
    assert.equal((await harness.activities.Activity.schema(harness.schemas.a).findByPk(first.activity.id))!.get('dueKind'), null);
});

test('rank compaction persists a moved row even when its final rank equals its pre-compaction value', async () => {
    const actor = harness.actors.ownerA2;
    const group = randomUUID();
    const first = await create(group + ' first', {status: 'IN_PROGRESS'}, actor);
    const anchor = await create(group + ' anchor', {status: 'IN_PROGRESS'}, actor);
    const moved = await create(group + ' moved', {status: 'IN_PROGRESS'}, actor);
    const scoped = harness.activities.Activity.schema(harness.schemas.a);
    const targetBoard = await board(actor);
    assert.equal(await scoped.count({where: {boardId: targetBoard.id, status: 'IN_PROGRESS', archivedAt: null}}), 3);
    // The exhausted 1024/1025 gap triggers compaction. After spacing the remaining rows
    // at 1024/2048, the midpoint is 1536: exactly the moving model instance's old value.
    await scoped.update({position: '1024'}, {where: {id: first.activity.id}, silent: true});
    await scoped.update({position: '1025'}, {where: {id: anchor.activity.id}, silent: true});
    await scoped.update({position: '1536'}, {where: {id: moved.activity.id}, silent: true});
    const result = success(await harness.api(actor, 'POST', `/activities/${moved.activity.id}/move`, {
        operationId: randomUUID(), expectedVersion: moved.activity.version, expectedOrderRevision: targetBoard.orderRevision,
        targetStatus: 'IN_PROGRESS', placement: {kind: 'before', activityId: anchor.activity.id}
    }));
    assert.equal(result.activity.position, '1536');
    assert.equal(result.activity.version, moved.activity.version);
    assert.equal(result.orderRevision, targetBoard.orderRevision + 1);
    const rows = await scoped.findAll({where: {boardId: targetBoard.id, status: 'IN_PROGRESS', archivedAt: null},
        order: [['position', 'ASC']]});
    assert.deepEqual(rows.map(row => row.id), [first.activity.id, moved.activity.id, anchor.activity.id]);
    assert.deepEqual(rows.map(row => String(row.position)), ['1024', '1536', '2048']);
    assert.equal(new Set(rows.map(row => String(row.position))).size, 3);
});

function structureRequest(id: string, availabilityId: string) {
    const association = Object.values(harness.auth.Structure.associations)
        .find(item => item.target === harness.auth.StructureAvailability);
    assert.ok(association, 'Use the real availability association expected by the controller');
    return {id, name: 'Activities structure test ' + id, [association.as]: [{
        id: availabilityId, day: 1, enabled: true, open: '09:00:00', close: '17:00:00'
    }]};
}

test('the real structure creation controller commits availability, owner membership and exactly one activity board', async () => {
    const structureId = randomUUID();
    const availabilityId = randomUUID();
    harness.trackStructure(structureId);
    const created = success(await harness.api(harness.actors.ownerA, 'POST', '/structure', structureRequest(structureId, availabilityId)), 201);
    assert.equal(created.id, structureId);
    assert.equal(created.tenantId, harness.ids.tenantA);
    assert.equal(await harness.auth.StructureAvailability.count({where: {id: availabilityId, structureId}}), 1);
    assert.equal(await harness.auth.StructureUser.count({where: {structureId, userId: harness.ids.ownerA}}), 1);
    assert.equal(await harness.auth.StructureUser.count({where: {structureId}}), 1);
    assert.equal(await harness.activities.ActivityBoard.schema(harness.schemas.a).count({where: {structureId}}), 1);
    const newBoard = await board({...harness.actors.ownerA, structureId});
    assert.equal(newBoard.structureId, structureId);
    assert.equal(newBoard.orderRevision, 0);
    assert.equal(newBoard.snapshotRevision, 0);
});

test('a PostgreSQL board insert failure rolls back the newly created structure, availability and owner membership', async () => {
    const structureId = randomUUID();
    const availabilityId = randomUUID();
    const {sequelize, schemas, auth, activities} = harness;
    harness.trackStructure(structureId);
    const structureCount = await auth.Structure.count({where: {tenantId: harness.ids.tenantA}});
    await sequelize.query(`CREATE FUNCTION "${schemas.a}"."test_fail_new_structure_board"() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'activities integration forced board failure'; END; $$`);
    await sequelize.query(`CREATE TRIGGER "test_fail_new_structure_board" BEFORE INSERT ON "${schemas.a}"."activity_boards"
        FOR EACH ROW WHEN (NEW."structureId" = '${structureId}'::uuid)
        EXECUTE FUNCTION "${schemas.a}"."test_fail_new_structure_board"()`);
    try {
        const result = await harness.api(harness.actors.ownerA, 'POST', '/structure', structureRequest(structureId, availabilityId));
        failure(result, 503);
        assert.match(result.body.message, /La sede non è stata salvata/);
        assert.ok(!result.body.message.includes('forced board failure'));
    } finally {
        await sequelize.query(`DROP TRIGGER "test_fail_new_structure_board" ON "${schemas.a}"."activity_boards"`);
        await sequelize.query(`DROP FUNCTION "${schemas.a}"."test_fail_new_structure_board"()`);
    }
    assert.equal(await auth.Structure.findByPk(structureId), null);
    assert.equal(await auth.Structure.count({where: {tenantId: harness.ids.tenantA}}), structureCount);
    assert.equal(await auth.StructureAvailability.findByPk(availabilityId), null);
    assert.equal(await auth.StructureUser.count({where: {structureId}}), 0);
    assert.equal(await activities.ActivityBoard.schema(schemas.a).count({where: {structureId}}), 0);
});

test('activity detail has explicit empty links when no resource is linked', async () => {
    const created = await create('No linked resource');
    const loaded = success(await harness.api(harness.actors.ownerA, 'GET', `/activities/${created.activity.id}`));
    assert.deepEqual(loaded.links, {patient: null, agendaEvent: null});
});

test('detail link metadata is minimal, readable in the structure and refreshed from current resources', async () => {
    const {patient, event, start} = await linkedResources();
    await event.update({recurrence: 'RRULE:FREQ=WEEKLY'});
    const created = await create('Linked detail', {patientId: patient.id, agendaEventId: event.id});
    const loaded = success(await harness.api(harness.actors.therapistA, 'GET', `/activities/${created.activity.id}`));
    assert.deepEqual(loaded.links, {
        patient: {id: patient.id, displayName: 'Ada Rossi'},
        agendaEvent: {id: event.id, title: 'Controllo', start, allDay: false, isRecurring: true},
    });
    assert.equal(loaded.activity.patientId, patient.id);
    assert.equal(loaded.activity.agendaEventId, event.id);
    assert.equal(JSON.stringify(loaded.links).includes('Clinical text'), false);
    assert.equal(JSON.stringify(loaded.links).includes('private@example.invalid'), false);

    await patient.update({name: '  Anna ', surname: ' Bianchi  '});
    await event.update({title: 'Controllo aggiornato', start: '2026-12-15', allDay: true,
        recurrence: null, recurringEventId: null});
    const reloaded = success(await harness.api(harness.actors.ownerA, 'GET', `/activities/${created.activity.id}`));
    assert.deepEqual(reloaded.links, {
        patient: {id: patient.id, displayName: 'Anna Bianchi'},
        agendaEvent: {id: event.id, title: 'Controllo aggiornato', start: '2026-12-15', allDay: true, isRecurring: false},
    });
    assert.equal(reloaded.activity.version, created.activity.version, 'Reading current labels does not mutate the activity');
    await event.update({recurringEventId: randomUUID()});
    const instance = success(await harness.api(harness.actors.ownerA, 'GET', `/activities/${created.activity.id}`));
    assert.equal(instance.links.agendaEvent.isRecurring, true, 'A recurrence instance also requires the recurrence warning');
});

test('archived patients and deleted appointments hide metadata and IDs while the activity remains readable', async () => {
    const {patient, event} = await linkedResources();
    const created = await create('Resources removed', {patientId: patient.id, agendaEventId: event.id});
    await patient.update({archivedAt: new Date()});
    await event.destroy();
    const loaded = success(await harness.api(harness.actors.ownerA, 'GET', `/activities/${created.activity.id}`));
    assert.deepEqual(loaded.links, {patient: null, agendaEvent: null});
    assert.equal(loaded.activity.patientId, null);
    assert.equal(loaded.activity.agendaEventId, null);
    const stored = await harness.activities.Activity.schema(harness.schemas.a).findByPk(created.activity.id);
    assert.equal(stored!.get('patientId'), patient.id, 'GET must not remove the historical reference');
    assert.equal(stored!.get('agendaEventId'), event.id);
});

test('tenant-level resource permissions cannot reveal links moved outside the activity structure or tenant', async () => {
    const {patient, event} = await linkedResources();
    const created = await create('Links stay within board', {patientId: patient.id, agendaEventId: event.id});
    await patient.update({structureId: harness.ids.structureA2});
    await event.update({structureId: harness.ids.structureA2});
    const otherStructure = success(await harness.api(harness.actors.ownerA, 'GET', `/activities/${created.activity.id}`));
    assert.deepEqual(otherStructure.links, {patient: null, agendaEvent: null});
    assert.equal(otherStructure.activity.patientId, null);
    assert.equal(otherStructure.activity.agendaEventId, null);

    await patient.update({structureId: harness.ids.structureA, tenantId: harness.ids.tenantB});
    const inconsistentTenant = success(await harness.api(harness.actors.ownerA, 'GET', `/activities/${created.activity.id}`));
    assert.equal(inconsistentTenant.links.patient, null, 'Schema membership does not replace the patient tenant check');
    const foreign = await linkedResources(harness.schemas.b, harness.ids.tenantB, harness.ids.structureB, harness.ids.ownerB);
    await harness.activities.Activity.schema(harness.schemas.a).update({patientId: foreign.patient.id, agendaEventId: foreign.event.id},
        {where: {id: created.activity.id}});
    const otherTenant = success(await harness.api(harness.actors.ownerA, 'GET', `/activities/${created.activity.id}`));
    assert.deepEqual(otherTenant.links, {patient: null, agendaEvent: null});
    failure(await harness.api(harness.actors.ownerB, 'GET', `/activities/${created.activity.id}`), 404);
});

test('current resource ACL is rechecked independently of activity access and stale token claims', async () => {
    const {patient, event} = await linkedResources();
    const created = await create('Own calendar ACL', {patientId: patient.id, agendaEventId: event.id});
    const where = {structureId: harness.ids.structureA, userId: harness.ids.therapistA};
    await harness.auth.StructureUser.update({role: 'EXTERNAL_COLLABORATOR'}, {where});
    try {
        const restricted = success(await harness.api(harness.actors.therapistA, 'GET', `/activities/${created.activity.id}`));
        assert.deepEqual(restricted.links.patient, {id: patient.id, displayName: 'Ada Rossi'},
            'Patient structure access does not depend on its creator');
        assert.equal(restricted.links.agendaEvent, null);
        assert.equal(restricted.activity.agendaEventId, null);
        await event.update({calendarId: harness.ids.therapistA});
        const ownCalendar = success(await harness.api(harness.actors.therapistA, 'GET', `/activities/${created.activity.id}`));
        assert.equal(ownCalendar.links.agendaEvent.id, event.id);
        await event.update({structureId: harness.ids.structureA2});
        const ownOtherStructure = success(await harness.api(harness.actors.therapistA, 'GET', `/activities/${created.activity.id}`));
        assert.equal(ownOtherStructure.links.agendaEvent, null, 'Own scope still respects the board structure');
    } finally {
        await harness.auth.StructureUser.update({role: null}, {where});
    }
});

test('detail reload preserves alert channels through unrelated core edits and explicit reconfiguration', async () => {
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    const dueAt = new Date(Date.now() + 7_200_000).toISOString();
    const created = await create('Alert channels reload', {assigneeIds: [harness.ids.therapistA],
        due: {kind: 'timed', at: dueAt}, alert: {scheduledAt, channels: ['inApp', 'push', 'email']}});
    const loaded = await detail(created.activity.id);
    assert.deepEqual(loaded.alert.channels, ['inApp', 'push', 'email']);
    const edited = success(await harness.api(harness.actors.ownerA, 'PATCH', `/activities/${created.activity.id}`, {
        operationId: randomUUID(), expectedVersion: loaded.version, changes: {title: 'Updated title only'},
    }));
    const afterTitle = await detail(created.activity.id);
    assert.deepEqual(afterTitle.alert.channels, loaded.alert.channels);
    assert.equal(afterTitle.alert.scheduleVersion, loaded.alert.scheduleVersion);
    assert.equal(afterTitle.alert.scheduledAt, scheduledAt);
    success(await harness.api(harness.actors.ownerA, 'PATCH', `/activities/${created.activity.id}`, {
        operationId: randomUUID(), expectedVersion: edited.activity.version,
        changes: {alert: {scheduledAt, channels: ['email']}},
    }));
    const afterReconfiguration = await detail(created.activity.id);
    assert.deepEqual(afterReconfiguration.alert.channels, ['inApp', 'email']);
    assert.equal(afterReconfiguration.alert.scheduleVersion, loaded.alert.scheduleVersion + 1);
    const persistedAlert = await harness.activities.ActivityAlert.schema(harness.schemas.a).findOne({where: {activityId: created.activity.id}});
    assert.ok(persistedAlert);
    assert.equal(await harness.activities.ActivityDelivery.schema(harness.schemas.a).count({where: {alertId: persistedAlert.id}}), 0);
});

test('activity agenda lookup paginates minimal persisted appointments in the selected structure and tenant', async () => {
    const query = `Lookup ${randomUUID()}`;
    const first = await linkedResources();
    const second = await linkedResources();
    const third = await linkedResources();
    await first.event.update({title: query, recurrence: 'FREQ=WEEKLY;COUNT=12', allDay: true});
    await second.event.update({title: query, recurringEventId: first.event.id});
    await third.event.update({title: query});
    const otherStructure = await linkedResources(harness.schemas.a, harness.ids.tenantA, harness.ids.structureA2);
    const otherTenant = await linkedResources(harness.schemas.b, harness.ids.tenantB, harness.ids.structureB, harness.ids.ownerB);
    const noStructure = await linkedResources();
    await otherStructure.event.update({title: query});
    await otherTenant.event.update({title: query});
    await noStructure.event.update({title: query, structureId: null});

    const pages: ActivityAgendaLinkDto[] = [];
    for (let offset = 0; offset < 3; offset++) {
        const page = success(await harness.api(harness.actors.ownerA, 'GET',
            `/activities/agenda-events?query=${encodeURIComponent(query)}&offset=${offset}&limit=1`));
        assert.equal(page.total, 3, 'Virtual recurring occurrences and appointments of another structure cannot increase the count');
        assert.equal(page.items.length, 1);
        assert.equal(page.nextOffset, offset < 2 ? offset + 1 : null);
        pages.push(page.items[0]);
    }
    assert.deepEqual(new Set(pages.map(item => item.id)), new Set([first.event.id, second.event.id, third.event.id]));
    for (const item of pages) {
        assert.deepEqual(Object.keys(item).sort(), ['id', 'title', 'start', 'allDay', 'isRecurring'].sort());
        assert.match(item.id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
    }
    const series = pages.find(item => item.id === first.event.id);
    const instance = pages.find(item => item.id === second.event.id);
    const ordinary = pages.find(item => item.id === third.event.id);
    assert.ok(series && instance && ordinary);
    assert.equal(series.isRecurring, true);
    assert.equal(series.allDay, true);
    assert.equal(instance.isRecurring, true);
    assert.equal(ordinary.isRecurring, false);
    assert.equal(JSON.stringify(pages).includes('Clinical text'), false);
    assert.equal(JSON.stringify(pages).includes('Private event'), false);
    assert.equal(JSON.stringify(pages).includes('private@example.invalid'), false);
    const foreignPage = success(await harness.api(harness.actors.ownerB, 'GET',
        `/activities/agenda-events?query=${encodeURIComponent(query)}`));
    assert.deepEqual(foreignPage.items.map((item: any) => item.id), [otherTenant.event.id]);
});

test('activity agenda lookup rechecks own calendar ACL and suspension instead of trusting stale token permissions', async () => {
    const query = `Own lookup ${randomUUID()}`;
    const own = await linkedResources(harness.schemas.a, harness.ids.tenantA, harness.ids.structureA, harness.ids.therapistA);
    const otherCalendar = await linkedResources();
    const ownOtherStructure = await linkedResources(harness.schemas.a, harness.ids.tenantA,
        harness.ids.structureA2, harness.ids.therapistA);
    await own.event.update({title: query});
    await otherCalendar.event.update({title: query});
    await ownOtherStructure.event.update({title: query});
    const membership = {structureId: harness.ids.structureA, userId: harness.ids.therapistA};
    const tenantMembership = {tenantId: harness.ids.tenantA, userId: harness.ids.therapistA};
    await harness.auth.StructureUser.update({role: 'EXTERNAL_COLLABORATOR'}, {where: membership});
    try {
        const page = success(await harness.api(harness.actors.therapistA, 'GET',
            `/activities/agenda-events?query=${encodeURIComponent(query)}`));
        assert.equal(page.total, 1);
        assert.deepEqual(page.items.map((item: any) => item.id), [own.event.id]);
        await own.event.update({calendarId: harness.ids.ownerA});
        const revoked = success(await harness.api(harness.actors.therapistA, 'GET',
            `/activities/agenda-events?query=${encodeURIComponent(query)}`));
        assert.deepEqual(revoked, {items: [], total: 0, nextOffset: null});
        await harness.auth.TenantUser.update({deactivatedAt: new Date()}, {where: tenantMembership});
        failure(await harness.api(harness.actors.therapistA, 'GET',
            `/activities/agenda-events?query=${encodeURIComponent(query)}`), 401, 'AUTH_SESSION_INVALID');
    } finally {
        await harness.auth.TenantUser.update({deactivatedAt: null}, {where: tenantMembership});
        await harness.auth.StructureUser.update({role: null}, {where: membership});
    }
});

test('activity agenda lookup validates patient scope, literal searches, civil dates and pagination input', async () => {
    const selected = await linkedResources();
    const otherPatient = await linkedResources();
    const query = `Literal ${randomUUID()}`;
    await selected.event.update({title: `${query} 100%_done`, start: '2026-10-10T22:30:00.000Z'});
    await otherPatient.event.update({title: `${query} 100abdone`});
    const filtered = success(await harness.api(harness.actors.ownerA, 'GET',
        `/activities/agenda-events?patientId=${selected.patient.id}&query=${encodeURIComponent(query)}`));
    assert.deepEqual(filtered.items.map((item: any) => item.id), [selected.event.id]);
    const literal = success(await harness.api(harness.actors.ownerA, 'GET',
        `/activities/agenda-events?query=${encodeURIComponent(`${query} %_`)}`));
    assert.deepEqual(literal.items.map((item: any) => item.id), [selected.event.id]);
    const civilDay = success(await harness.api(harness.actors.ownerA, 'GET',
        `/activities/agenda-events?patientId=${selected.patient.id}&query=11%2F10%2F2026`));
    assert.deepEqual(civilDay.items.map((item: any) => item.id), [selected.event.id],
        'Lookup dates follow the Rome civil day rather than the UTC calendar date');
    assert.deepEqual(success(await harness.api(harness.actors.ownerA, 'GET', '/activities/agenda-events?query=x')),
        {items: [], total: 0, nextOffset: null});

    for (const params of ['patientId=invalid', 'query[]=x', 'offset=-1', 'limit=51', 'limit=1.5']) {
        failure(await harness.api(harness.actors.ownerA, 'GET', `/activities/agenda-events?${params}`),
            422, 'ACTIVITY_VALIDATION_FAILED');
    }
    await selected.patient.update({archivedAt: new Date()});
    failure(await harness.api(harness.actors.ownerA, 'GET', `/activities/agenda-events?patientId=${selected.patient.id}`),
        404, 'ACTIVITY_NOT_FOUND');
    const otherStructure = await linkedResources(harness.schemas.a, harness.ids.tenantA, harness.ids.structureA2);
    failure(await harness.api(harness.actors.ownerA, 'GET', `/activities/agenda-events?patientId=${otherStructure.patient.id}`),
        404, 'ACTIVITY_NOT_FOUND');
    const foreign = await linkedResources(harness.schemas.b, harness.ids.tenantB, harness.ids.structureB, harness.ids.ownerB);
    failure(await harness.api(harness.actors.ownerA, 'GET', `/activities/agenda-events?patientId=${foreign.patient.id}`),
        404, 'ACTIVITY_NOT_FOUND');
});

test('activity patient lookup is minimal and paginated within the current tenant and structure', async () => {
    const query = `Patients${randomUUID()}`;
    const first = await linkedResources();
    const second = await linkedResources();
    const archived = await linkedResources();
    const otherStructure = await linkedResources(harness.schemas.a, harness.ids.tenantA, harness.ids.structureA2);
    const foreign = await linkedResources(harness.schemas.b, harness.ids.tenantB, harness.ids.structureB, harness.ids.ownerB);
    const inconsistentTenant = await linkedResources();
    await first.patient.update({name: ' Ada ', surname: `${query} 01`});
    await second.patient.update({name: 'Bea', surname: `${query} 02`});
    await archived.patient.update({surname: query, archivedAt: new Date()});
    await otherStructure.patient.update({surname: query});
    await foreign.patient.update({surname: query});
    await inconsistentTenant.patient.update({surname: query, tenantId: harness.ids.tenantB});

    const page = success(await harness.api(harness.actors.ownerA, 'GET',
        `/activities/patients?query=${encodeURIComponent(query)}&limit=1`));
    assert.deepEqual(page, {items: [{id: first.patient.id, displayName: `Ada ${query} 01`}], total: 2, nextOffset: 1});
    const next = success(await harness.api(harness.actors.ownerA, 'GET',
        `/activities/patients?query=${encodeURIComponent(query)}&offset=${page.nextOffset}&limit=1`));
    assert.deepEqual(next, {items: [{id: second.patient.id, displayName: `Bea ${query} 02`}], total: 2, nextOffset: null});
    assert.deepEqual(Object.keys(page.items[0]).sort(), ['id', 'displayName'].sort());
    assert.equal(JSON.stringify(page).includes('Clinical text'), false);
    const foreignPage = success(await harness.api(harness.actors.ownerB, 'GET',
        `/activities/patients?query=${encodeURIComponent(query)}`));
    assert.deepEqual(foreignPage.items.map((item: any) => item.id), [foreign.patient.id]);
    const blankQuery = success(await harness.api(harness.actors.ownerA, 'GET', '/activities/patients?limit=1'));
    assert.equal(blankQuery.items.length, 1, 'Focusing an empty search can load a scoped first page');
    assert.equal(blankQuery.nextOffset, 1);
});

test('activity patient lookup refreshes archived and moved resources, current access and literal search input', async () => {
    const query = `Patient${randomUUID()}`;
    const selected = await linkedResources();
    const ordinary = await linkedResources();
    await selected.patient.update({name: `${query} 100%_done`});
    await ordinary.patient.update({name: `${query} 100abdone`});
    const url = `/activities/patients?query=${encodeURIComponent(`${query} %_`)}`;
    assert.deepEqual(success(await harness.api(harness.actors.ownerA, 'GET', url)).items.map((item: any) => item.id),
        [selected.patient.id]);
    await selected.patient.update({archivedAt: new Date()});
    assert.deepEqual(success(await harness.api(harness.actors.ownerA, 'GET', url)), {items: [], total: 0, nextOffset: null});
    await selected.patient.update({archivedAt: null, structureId: harness.ids.structureA2});
    assert.deepEqual(success(await harness.api(harness.actors.ownerA, 'GET', url)), {items: [], total: 0, nextOffset: null});
    await selected.patient.update({structureId: harness.ids.structureA});

    const where = {structureId: harness.ids.structureA, userId: harness.ids.therapistA};
    await harness.auth.StructureUser.update({role: 'PATIENT'}, {where});
    try {
        failure(await harness.api(harness.actors.therapistA, 'GET', url), 403);
    } finally {
        await harness.auth.StructureUser.update({role: null}, {where});
    }
    failure(await harness.api(harness.actors.patient, 'GET', url), 403);
    for (const params of ['query[]=Ada', 'offset=-1', 'offset[]=1', 'limit[]=1', 'limit=0', 'limit=51']) {
        failure(await harness.api(harness.actors.ownerA, 'GET', `/activities/patients?${params}`),
            422, 'ACTIVITY_VALIDATION_FAILED');
    }
    const clinicalOnly = success(await harness.api(harness.actors.ownerA, 'GET',
        '/activities/patients?query=Clinical%20text'));
    assert.deepEqual(clinicalOnly.items, [], 'Lookup searches names, never clinical notes or snapshots');
});
