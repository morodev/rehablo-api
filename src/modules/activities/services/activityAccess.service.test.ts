import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {Op, type Transaction} from 'sequelize';
import type {ActivityContext} from '../activities.types.js';
import {getRolePermissions, resolveEffectiveRole, RoleCode} from '../../auth/rbac/roles.js';
import Patient from '../../patients/models/patient.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import {activityCapabilities, canCreateActivity, isEligibleActivityRole, requireActivityCapability,
    requireActivityLinks, searchActivityAgendaLinks} from './activityAccess.service.js';
import {ActivityError} from '../utils/activityErrors.js';

const actor = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const context = (role: RoleCode): ActivityContext => ({
    userId: actor, tenantId: '00000000-0000-4000-8000-000000000003', structureId: '00000000-0000-4000-8000-000000000004',
    schema: 'rehablo_00000000000040008000000000000003', timezone: 'Europe/Rome', role, permissions: getRolePermissions(role)
});
const open = {createdByUserId: other, status: 'TODO', archivedAt: null};

test('an operational own scope allows creator OR assignee without granting every readable activity update', () => {
    for (const role of [RoleCode.THERAPIST, RoleCode.PHYSIATRIST, RoleCode.ORTHOPEDIST, RoleCode.EXTERNAL_COLLABORATOR]) {
        assert.equal(activityCapabilities(context(role), open, []).canEdit, false, role);
        assert.equal(activityCapabilities(context(role), {...open, createdByUserId: actor}, []).canEdit, true, role);
        assert.equal(activityCapabilities(context(role), open, [actor]).canEdit, true, role);
        assert.equal(canCreateActivity(context(role)), true, role);
    }
});

test('owner and secretary manage structure activities without a creator or assignee match', () => {
    for (const role of [RoleCode.OWNER, RoleCode.SECRETARY]) {
        const capabilities = activityCapabilities(context(role), open, []);
        assert.equal(capabilities.canEdit, true);
        assert.equal(capabilities.canAssign, true);
        assert.equal(capabilities.canMove, true);
        assert.equal(capabilities.canArchive, true);
    }
});

test('viewer and patient cannot become writers or assignees through creator/assignment IDs', () => {
    for (const role of [RoleCode.VIEWER, RoleCode.PATIENT]) {
        assert.equal(isEligibleActivityRole(role), false);
        assert.equal(canCreateActivity(context(role)), false);
        const capabilities = activityCapabilities(context(role), {...open, createdByUserId: actor}, [actor]);
        assert.ok(Object.values(capabilities).every(value => value === false));
        assert.throws(() => requireActivityCapability(context(role), open, [actor], 'canEdit'),
            error => error instanceof ActivityError && error.statusCode === 403 && error.code === 'ACTIVITY_FORBIDDEN');
    }
});

test('an archived activity permits restore and protects core, order and child writes', () => {
    const capabilities = activityCapabilities(context(RoleCode.OWNER), {...open, archivedAt: '2026-03-28T12:00:00Z'}, []);
    assert.equal(capabilities.canRestore, true);
    assert.equal(capabilities.canEdit, false);
    assert.equal(capabilities.canMove, false);
    assert.equal(capabilities.canManageChecklist, false);
    assert.equal(capabilities.canComment, false);
    assert.equal(capabilities.canArchive, false);
});

test('completion protects checklist writes while allowing core work and reopening', () => {
    const capabilities = activityCapabilities(context(RoleCode.OWNER), {...open, status: 'COMPLETED'}, []);
    assert.equal(capabilities.canEdit, true);
    assert.equal(capabilities.canMove, true);
    assert.equal(capabilities.canManageChecklist, false);
    assert.equal(capabilities.canComment, true);
});

test('structure role override can remove activity write capabilities from a tenant role', () => {
    const effective = resolveEffectiveRole(RoleCode.THERAPIST, RoleCode.VIEWER)!;
    assert.equal(effective, RoleCode.VIEWER);
    assert.equal(canCreateActivity(context(effective)), false);
    assert.equal(activityCapabilities(context(effective), {...open, createdByUserId: actor}, [actor]).canEdit, false);
    const denied = {...context(RoleCode.THERAPIST), permissions: []};
    assert.equal(canCreateActivity(denied), false);
    assert.equal(activityCapabilities(denied, {...open, createdByUserId: actor}, [actor]).canEdit, false);
});

test('an operator can comment on a readable colleague activity without acquiring ownership actions', () => {
    const capabilities = activityCapabilities(context(RoleCode.THERAPIST), open, []);
    assert.equal(capabilities.canComment, true);
    for (const capability of ['canEdit', 'canAssign', 'canMove', 'canManageChecklist', 'canArchive', 'canRestore'] as const) {
        assert.equal(capabilities[capability], false, capability);
    }
});

test('ownership never replaces current update/create permissions when access becomes read-only', () => {
    const readonly = {...context(RoleCode.THERAPIST), permissions: ['activity:read:structure'] as ActivityContext['permissions']};
    const owned = {...open, createdByUserId: actor};
    assert.equal(canCreateActivity(readonly), false);
    assert.ok(Object.values(activityCapabilities(readonly, owned, [actor])).every(value => value === false));
    assert.equal(activityCapabilities(readonly, {...owned, archivedAt: '2026-03-28T12:00:00Z'}, [actor]).canRestore, false);
});

test('archived own activities can be restored by their creator or eligible assignee, but not an unrelated reader', () => {
    const archived = {...open, archivedAt: '2026-03-28T12:00:00Z'};
    assert.equal(activityCapabilities(context(RoleCode.THERAPIST), archived, []).canRestore, false);
    assert.equal(activityCapabilities(context(RoleCode.THERAPIST), {...archived, createdByUserId: actor}, []).canRestore, true);
    assert.equal(activityCapabilities(context(RoleCode.THERAPIST), archived, [actor]).canRestore, true);
    for (const role of [RoleCode.VIEWER, RoleCode.PATIENT]) {
        assert.ok(Object.values(activityCapabilities(context(role), {...archived, createdByUserId: actor}, [actor]))
            .every(value => value === false), role);
    }
});

test('a current operational structure override narrows a tenant owner to creator-or-assignee rights', () => {
    const role = resolveEffectiveRole(RoleCode.OWNER, RoleCode.THERAPIST)!;
    assert.equal(role, RoleCode.THERAPIST);
    assert.equal(activityCapabilities(context(role), open, []).canEdit, false);
    assert.equal(activityCapabilities(context(role), open, [actor]).canEdit, true);
    assert.equal(activityCapabilities(context(role), {...open, createdByUserId: actor}, []).canEdit, true);
});

const linkedId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
type LinkRow = Record<string, any>;

/** Evaluate the actual Sequelize predicate, including nested JSON and typed NULL precedence. */
function linkedRowMatches(row: LinkRow, where: any): boolean {
    return Reflect.ownKeys(where ?? {}).every(key => {
        const condition = where[key];
        if (key === Op.and) return condition.every((part: any) => linkedRowMatches(row, part));
        if (key === Op.or) return condition.some((part: any) => linkedRowMatches(row, part));
        if (typeof key === 'symbol') throw new Error(`Unsupported link predicate ${String(key)}`);
        const value = row?.[key];
        if (condition === null) return value == null;
        if (condition && typeof condition === 'object') return linkedRowMatches(value ?? {}, condition);
        return value === condition;
    });
}

function activityLinksFixture(t: TestContext) {
    const selected = context(RoleCode.OWNER);
    const patientId = linkedId(5), agendaEventId = linkedId(6);
    const patient: LinkRow = {id: patientId, tenantId: selected.tenantId, structureId: selected.structureId,
        userId: actor, archivedAt: null};
    const event: LinkRow = {id: agendaEventId, structureId: selected.structureId, calendarId: actor,
        patientId, patient: null, title: 'Controllo', start: '2026-07-28T07:00:00.000Z',
        allDay: false, recurrence: null, recurringEventId: null};
    const patients = [patient], events = [event];
    const reads: Array<{schema: string; model: string; method: string; options: any}> = [];
    const project = (row: LinkRow, attributes: string[]) => Object.fromEntries(attributes.map(key => [key, row[key]]));
    t.mock.method(Patient, 'schema', ((schema: string) => ({
        findOne: async (options: any) => {
            reads.push({schema, model: 'patient', method: 'findOne', options});
            const row = patients.find(item => linkedRowMatches(item, options.where));
            return row ? project(row, options.attributes) : null;
        }
    })) as any);
    t.mock.method(AgendaEvent, 'schema', ((schema: string) => ({
        findOne: async (options: any) => {
            reads.push({schema, model: 'agenda', method: 'findOne', options});
            const row = events.find(item => linkedRowMatches(item, options.where));
            return row ? project(row, options.attributes) : null;
        },
        findAndCountAll: async (options: any) => {
            reads.push({schema, model: 'agenda', method: 'findAndCountAll', options});
            const rows = events.filter(item => linkedRowMatches(item, options.where));
            return {count: rows.length,
                rows: rows.slice(options.offset, options.offset + options.limit).map(row => project(row, options.attributes))};
        }
    })) as any);
    return {context: selected, patientId, agendaEventId, patient, event, patients, events, reads};
}

const associationFailure = (error: unknown) => error instanceof ActivityError
    && error.statusCode === 422 && error.code === 'ACTIVITY_VALIDATION_FAILED';
const unavailableLink = (error: unknown) => error instanceof ActivityError
    && error.statusCode === 404 && error.code === 'ACTIVITY_NOT_FOUND';

test('activity links resolve typed and legacy patient references with the existing scoped transaction', async t => {
    const f = activityLinksFixture(t);
    const transaction = {id: 'link-read'} as unknown as Transaction;
    for (const patientId of [f.patientId, null, undefined]) {
        f.event.patientId = patientId;
        f.event.patient = {id: f.patientId, name: 'Storico', notes: 'Private snapshot'};
        await requireActivityLinks(f.context, {patientId: f.patientId, agendaEventId: f.agendaEventId}, transaction);
    }
    assert.equal(f.reads.length, 6);
    assert.ok(f.reads.every(read => read.schema === f.context.schema && read.options.transaction === transaction));
    for (const read of f.reads.filter(read => read.model === 'agenda')) {
        assert.deepEqual(read.options.attributes, ['id', 'patientId', 'patient']);
        assert.deepEqual(read.options.where, {id: f.agendaEventId, structureId: f.context.structureId});
    }
});

test('activity links retain typed precedence and reject mismatched or missing patient associations', async t => {
    const f = activityLinksFixture(t);
    f.event.patient = {id: linkedId(7)};
    await requireActivityLinks(f.context, {patientId: f.patientId, agendaEventId: f.agendaEventId});
    for (const association of [
        {patientId: linkedId(7), patient: {id: f.patientId}},
        {patientId: null, patient: {id: linkedId(7)}},
        {patientId: null, patient: null},
        {patientId: undefined, patient: undefined},
        {patientId: null, patient: {name: 'No identifier'}},
        {patientId: null, patient: {id: 'invalid-placeholder'}}
    ]) {
        Object.assign(f.event, association);
        await assert.rejects(() => requireActivityLinks(f.context,
            {patientId: f.patientId, agendaEventId: f.agendaEventId}), associationFailure);
    }
});

test('legacy activity links preserve own calendar, patient, tenant, structure and archive checks', async t => {
    const f = activityLinksFixture(t);
    f.context.permissions = ['patient:read:own', 'agenda:read:own'];
    f.event.patientId = null;
    f.event.patient = {id: f.patientId};
    const transaction = {id: 'own-link-read'} as unknown as Transaction;
    const links = {patientId: f.patientId, agendaEventId: f.agendaEventId};
    await requireActivityLinks(f.context, links, transaction);
    assert.deepEqual(f.reads[0].options.where, {id: f.patientId, tenantId: f.context.tenantId,
        structureId: f.context.structureId, archivedAt: null, userId: actor});
    assert.deepEqual(f.reads[1].options.where, {id: f.agendaEventId, structureId: f.context.structureId, calendarId: actor});
    assert.ok(f.reads.every(read => read.options.transaction === transaction));
    for (const field of ['calendarId', 'structureId']) {
        const original = f.event[field];
        f.event[field] = linkedId(9);
        await assert.rejects(() => requireActivityLinks(f.context, links), unavailableLink);
        f.event[field] = original;
    }
    for (const field of ['userId', 'tenantId', 'structureId', 'archivedAt']) {
        const original = f.patient[field];
        f.patient[field] = field === 'archivedAt' ? new Date() : linkedId(9);
        await assert.rejects(() => requireActivityLinks(f.context, links), unavailableLink);
        f.patient[field] = original;
    }
    f.context.permissions = [];
    const readsBefore = f.reads.length;
    await assert.rejects(() => requireActivityLinks(f.context, links), unavailableLink);
    assert.equal(f.reads.length, readsBefore);
});

test('activity patient agenda lookup evaluates canonical fallback while retaining scope and minimal metadata', async t => {
    const f = activityLinksFixture(t);
    f.context.permissions = ['patient:read:own', 'agenda:read:own'];
    const variant = (index: number, changes: LinkRow) => ({...f.event, id: linkedId(index), ...changes});
    f.events.push(
        variant(8, {patientId: null, patient: {id: f.patientId, notes: 'Private snapshot'}}),
        variant(9, {patientId: undefined, patient: {id: f.patientId}}),
        variant(10, {patientId: linkedId(7), patient: {id: f.patientId}}),
        variant(11, {patientId: null, patient: {id: linkedId(7)}}),
        variant(12, {patientId: null, patient: null}),
        variant(13, {structureId: linkedId(14)}),
        variant(15, {calendarId: other})
    );
    const snapshot = JSON.stringify(f.events);
    const transaction = {id: 'lookup-read'} as unknown as Transaction;
    const result = await searchActivityAgendaLinks(f.context,
        {patientId: f.patientId, query: '', offset: 0, limit: 50}, transaction);
    assert.deepEqual(result.items.map(item => item.id), [f.agendaEventId, linkedId(8), linkedId(9)]);
    assert.equal(result.total, 3);
    assert.equal(result.nextOffset, null);
    assert.ok(f.reads.every(read => read.schema === f.context.schema && read.options.transaction === transaction));
    const lookup = f.reads.find(read => read.method === 'findAndCountAll')!;
    assert.deepEqual(lookup.options.attributes, ['id', 'title', 'start', 'allDay', 'recurrence', 'recurringEventId']);
    assert.equal(JSON.stringify(result).includes('patient'), false);
    assert.equal(JSON.stringify(result).includes('Private snapshot'), false);
    assert.equal(JSON.stringify(f.events), snapshot);
});
