import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ActivityContext} from '../activities.types.js';
import {getRolePermissions, resolveEffectiveRole, RoleCode} from '../../auth/rbac/roles.js';
import {activityCapabilities, canCreateActivity, isEligibleActivityRole, requireActivityCapability} from './activityAccess.service.js';
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
