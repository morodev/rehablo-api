import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {RoleCode} from '../../auth/rbac/roles.js';
import {isClinicalNoteRole, normalizeAssignedUserIds} from './workItemAccess.service.js';

describe('work item assignments', () => {
    it('normalizes, trims and deduplicates the selected operators', () => {
        assert.deepEqual(
            normalizeAssignedUserIds([' user-a ', 'user-b', 'user-a', '', null], undefined, 'creator'),
            ['user-a', 'user-b']
        );
    });

    it('keeps legacy assignments and falls back to the creator for old clients', () => {
        assert.deepEqual(normalizeAssignedUserIds(undefined, 'legacy-user', 'creator'), ['legacy-user']);
        assert.deepEqual(normalizeAssignedUserIds(undefined, undefined, 'creator'), ['creator']);
    });

    it('does not silently replace an explicitly empty selection', () => {
        assert.deepEqual(normalizeAssignedUserIds([], undefined, 'creator'), []);
    });

    it('limits clinical notes to clinical roles and the owner', () => {
        assert.equal(isClinicalNoteRole(RoleCode.OWNER), true);
        assert.equal(isClinicalNoteRole(RoleCode.THERAPIST), true);
        assert.equal(isClinicalNoteRole(RoleCode.PHYSIATRIST), true);
        assert.equal(isClinicalNoteRole(RoleCode.ORTHOPEDIST), true);
        assert.equal(isClinicalNoteRole(RoleCode.EXTERNAL_COLLABORATOR), true);
        assert.equal(isClinicalNoteRole(RoleCode.SECRETARY), false);
        assert.equal(isClinicalNoteRole(RoleCode.VIEWER), false);
        assert.equal(isClinicalNoteRole(RoleCode.PATIENT), false);
    });
});
