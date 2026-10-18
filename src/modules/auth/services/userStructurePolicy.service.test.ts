import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RoleCode} from '../rbac/roles.js';
import {canChangeAssignedStructures, validateUserStructureSelection} from './userStructurePolicy.service.js';

test('both secretary roles may be assigned multiple tenant sites', () => {
    for (const role of [RoleCode.SECRETARY, RoleCode.ADMIN_SECRETARY]) {
        assert.equal(validateUserStructureSelection(role, ['a', 'b'], ['a', 'b', 'c']), null);
        assert.ok(validateUserStructureSelection(role, ['foreign'], ['a', 'b']));
        assert.ok(validateUserStructureSelection(role, [], ['a', 'b']));
    }
});

test('team managers cannot enlarge their own assignments but can manage other members', () => {
    assert.equal(canChangeAssignedStructures('admin', 'admin', ['a'], ['a', 'b']), false);
    assert.equal(canChangeAssignedStructures('admin', 'admin', ['a'], ['b']), false);
    assert.equal(canChangeAssignedStructures('admin', 'admin', ['a', 'b'], ['a']), true);
    assert.equal(canChangeAssignedStructures('admin', 'colleague', ['a'], ['a', 'b']), true);
});
