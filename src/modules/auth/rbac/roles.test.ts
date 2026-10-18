import assert from 'node:assert/strict';
import {it} from 'node:test';
import {getRolePermissions, RoleCode} from './roles.js';
import {hasPermission, resolveGrantedScope} from './permissions.js';
import {canAccessAppointmentFinance} from '../../agenda/services/appointmentFinancialAccess.service.js';
import {defaultCalendarEnabled} from '../services/structureCalendar.service.js';
import {validateUserStructureSelection} from '../services/userStructurePolicy.service.js';

it('separates ordinary reception collection from administration, analytics, prices and reversals', () => {
    const permissions = getRolePermissions(RoleCode.SECRETARY);
    for (const resource of ['patient_balance', 'payment'] as const) assert.ok(hasPermission(permissions, resource, 'read', 'structure'));
    assert.ok(hasPermission(permissions, 'payment', 'create', 'structure'));
    for (const resource of ['analytics', 'invoice', 'quote', 'treasury', 'accountant_export'] as const) assert.equal(hasPermission(permissions, resource, 'read'), false);
    assert.equal(hasPermission(permissions, 'appointment_pricing', 'update'), false);
    assert.equal(hasPermission(permissions, 'payment_reversal', 'create'), false);
    assert.equal(hasPermission(permissions, 'user', 'update'), false);
});
it('administrative secretary keeps tenant configuration but reports remain assigned-site permissions', () => {
    const permissions = getRolePermissions(RoleCode.ADMIN_SECRETARY);
    assert.ok(hasPermission(permissions, 'user', 'manage', 'tenant'));
    assert.equal(resolveGrantedScope(permissions, 'analytics', 'read'), 'structure');
    assert.equal(resolveGrantedScope(permissions, 'accountant_export', 'export'), 'structure');
    assert.equal(defaultCalendarEnabled(RoleCode.ADMIN_SECRETARY), false);
    assert.equal(validateUserStructureSelection(RoleCode.ADMIN_SECRETARY, ['a','b'], ['a','b']), null);
});
it('clinical monetary rights stay confined to their own appointments independently of structure agenda read', () => {
    for (const role of [RoleCode.THERAPIST, RoleCode.PHYSIATRIST, RoleCode.ORTHOPEDIST, RoleCode.EXTERNAL_COLLABORATOR]) {
        const perms = getRolePermissions(role), req: any = {user: {sub: 'u', sid: 's', perms}};
        assert.equal(hasPermission(perms, 'analytics', 'read'), false);
        for (const [resource, action] of [['payment','create'], ['appointment_pricing','update'], ['payment_reversal','create']] as const) {
            assert.equal(canAccessAppointmentFinance(req, {calendarId: 'u', structureId: 's'}, resource, action), true);
            assert.equal(canAccessAppointmentFinance(req, {calendarId: 'other', structureId: 's'}, resource, action), false);
            assert.equal(canAccessAppointmentFinance(req, {calendarId: 'u', structureId: 'other'}, resource, action), false);
        }
    }
});
it('viewer keeps analytical exports without any monetary write', () => {
    const perms = getRolePermissions(RoleCode.VIEWER);
    assert.ok(hasPermission(perms, 'analytics', 'export', 'tenant'));
    assert.ok(hasPermission(perms, 'accountant_export', 'export', 'tenant'));
    assert.equal(hasPermission(perms, 'payment', 'create'), false);
    assert.equal(hasPermission(perms, 'appointment_pricing', 'update'), false);
    assert.equal(hasPermission(perms, 'payment_reversal', 'create'), false);
});
