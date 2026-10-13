import {BillingAccount} from '../../billing/models/billing.model.js';
import {isBillingRecoveryRequest} from '../../../middleware/auth.js';
import assert from 'node:assert/strict';
import { it, TestContext } from 'node:test';
import jwt from 'jsonwebtoken';
import { env } from '../../../config/env.js';
import { requireAuth, requireIdentityAuth, AuthTokenPayload } from '../../../middleware/auth.js';
import User from '../models/user.model.js';
import TenantUser from '../models/tenantUser.model.js';
import StructureUser from '../models/structureUser.model.js';
import Structure from '../models/structure.model.js';
import PatientPortalAccess from '../models/patientPortalAccess.model.js';
import { AuthStateError, getAuthVersion, resolveApplicationPrincipal } from './authState.service.js';
import { getRolePermissions } from '../rbac/roles.js';

const row = (data: any): any => ({ get: (key: any) => typeof key === 'string' ? data[key] : { ...data } });
const claims = (patch: any = {}): AuthTokenPayload => ({ id: 'user', sub: 'user', email: 'user@example.invalid',
    isActive: true, isSuperAdmin: true, tenants: [{ id: 'tenant' }], tid: 'tenant', role: 'OWNER',
    actor: 'staff', perms: ['patient:manage:tenant'], ...patch });
function fixture(t: TestContext) {
    t.mock.method(BillingAccount, 'findByPk', (async () => null) as any);
    const user = { id: 'user', email: 'user@example.invalid', isActive: true, isSuperAdmin: true, authVersion: 0 };
    const membership: any = { userId: 'user', tenantId: 'tenant', role: 'OWNER', deactivatedAt: null };
    const lookups = t.mock.method(User, 'findByPk', (async () => row(user)) as any);
    t.mock.method(TenantUser, 'findOne', (async () => membership.missing ? null : row(membership)) as any);
    t.mock.method(StructureUser, 'findOne', (async () => row({ role: null })) as any);
    t.mock.method(Structure, 'findOne', (async () => row({ id: 'site' })) as any);
    t.mock.method(PatientPortalAccess, 'findOne', (async () => row({ id: 'access', patientId: 'patient', status: 'ACTIVE' })) as any);
    return { user, membership, lookups };
}

it('preserves the registering OWNER privilege only in an active OWNER membership', async t => {
    const { membership } = fixture(t);
    assert.equal((await resolveApplicationPrincipal(claims())).isSuperAdmin, true);
    membership.role = 'THERAPIST';
    const principal = await resolveApplicationPrincipal(claims({ tid: 'other-tenant' }));
    assert.equal(principal.isSuperAdmin, false);
    assert.equal(principal.role, 'THERAPIST');
    assert.deepEqual(principal.perms, getRolePermissions('THERAPIST'));
    assert.deepEqual(principal.tenants, [{ id: 'other-tenant' }]);
});
it('does not promote an invited OWNER whose persisted flag is false', async t => {
    const { user } = fixture(t); user.isSuperAdmin = false;
    assert.equal((await resolveApplicationPrincipal(claims())).isSuperAdmin, false);
});
it('keeps a registering OWNER in control of its tenant even with a lower premise override', async t => {
    fixture(t);
    t.mock.method(StructureUser, 'findOne', (async () => row({ role: 'THERAPIST' })) as any);
    const principal = await resolveApplicationPrincipal(claims({ sid: 'site', selectedPremise: { id: 'site' } }));
    assert.equal(principal.role, 'THERAPIST');
    assert.equal(principal.isSuperAdmin, true);
    assert.equal(principal.tid, 'tenant');
});
it('rejects a removed or suspended membership, while identity-only context selection remains possible', async t => {
    const { membership } = fixture(t);
    for (const patch of [{ missing: true }, { missing: false, deactivatedAt: new Date() }]) {
        Object.assign(membership, patch);
        await assert.rejects(resolveApplicationPrincipal(claims()), AuthStateError);
        const identity = await resolveApplicationPrincipal(claims(), { identityOnly: true });
        assert.equal(identity.isSuperAdmin, false); assert.deepEqual(identity.perms, []); assert.equal(identity.tid, undefined);
    }
});
it('normalizes a patient principal and rejects removed patient access', async t => {
    fixture(t);
    const principal = await resolveApplicationPrincipal(claims({ actor: 'patient', patientAccessId: 'access' }));
    assert.equal(principal.isSuperAdmin, false); assert.equal(principal.role, 'PATIENT'); assert.equal(principal.pid, 'patient');
    t.mock.method(PatientPortalAccess, 'findOne', (async () => null) as any);
    await assert.rejects(resolveApplicationPrincipal(claims({ actor: 'patient', patientAccessId: 'access' })), AuthStateError);
});
it('legacy version zero works before reset, and reset revokes application and legacy claims immediately', async t => {
    const { user } = fixture(t);
    assert.equal((await resolveApplicationPrincipal(claims())).authVersion, 0);
    user.authVersion = 1;
    await assert.rejects(resolveApplicationPrincipal(claims()), AuthStateError);
    await assert.rejects(resolveApplicationPrincipal(claims({ authVersion: 0 })), AuthStateError);
    assert.equal((await resolveApplicationPrincipal(claims({ authVersion: 1 }))).authVersion, 1);
});
it('rejects selection tokens, mixed identities and malformed versions without accepting string coercion', async t => {
    fixture(t);
    for (const patch of [{ tokenUse: 'context_selection' }, { id: 'someone-else' }, { authVersion: '0' }, { authVersion: null }]) {
        await assert.rejects(resolveApplicationPrincipal(claims(patch)), AuthStateError);
    }
    for (const version of [-1, 0.1, Infinity, null, '0']) assert.throws(() => getAuthVersion(version), AuthStateError);
});
it('denies a removed premise assignment even if the JWT still carries its permissions', async t => {
    fixture(t); t.mock.method(StructureUser, 'findOne', (async () => null) as any);
    await assert.rejects(resolveApplicationPrincipal(claims({ sid: 'site' })), AuthStateError);
});
it('memoizes authentication per request and rechecks the next request after a reset', async t => {
    const { user, lookups } = fixture(t);
    const token = jwt.sign(claims(), env.jwtSecret);
    const req: any = { header: () => token };
    const res: any = { status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
    let next = 0;
    await requireAuth(req, res, () => { next++; });
    await requireAuth(req, res, () => { next++; });
    assert.equal(next, 2); assert.equal(lookups.mock.callCount(), 1);
    user.authVersion = 1;
    await requireAuth({ header: () => token } as any, res, () => { next++; });
    assert.equal(next, 2); assert.equal(res.code, 401); assert.equal(lookups.mock.callCount(), 2);
});
it('identity-only authentication never bypasses reset revocation and DB faults reach next(error)', async t => {
    const { user } = fixture(t); user.authVersion = 1;
    const req: any = { header: () => jwt.sign(claims(), env.jwtSecret) };
    const res: any = { status(code: number) { this.code = code; return this; }, json() { return this; } };
    await requireIdentityAuth(req, res, () => assert.fail('revoked identity accepted'));
    assert.equal(res.code, 401);
    const failure = new Error('database unavailable');
    t.mock.method(User, 'findByPk', (async () => { throw failure; }) as any);
    let received: unknown;
    await requireAuth({ ...req } as any, res, error => { received = error; });
    assert.equal(received, failure);
});

it('blocks operational staff access after payment expiry but keeps billing and context recovery reachable', async t => {
    fixture(t);
    t.mock.method(BillingAccount, 'findByPk', (async () => ({status: 'active', paidThrough: new Date(0)})) as any);
    const token = jwt.sign(claims(), env.jwtSecret);
    const res: any = {status() {return this;}, json() {return this;}};
    const check = async (path: string, method = 'GET') => {
        let failure: any; let allowed = false;
        await requireAuth({path, method, header: () => token} as any, res, error => {failure = error; allowed = !error;});
        return {failure, allowed};
    };
    const denied = await check('/patients');
    assert.equal(denied.allowed, false);
    assert.equal(denied.failure.code, 'BILLING_ACCESS_REQUIRED');
    assert.equal(denied.failure.statusCode, 402);
    for (const route of ['/billing', '/billing/portal', '/auth/me', '/structure/accessible']) {
        assert.equal((await check(route)).allowed, true, route);
    }
    assert.equal((await check('/structure', 'POST')).allowed, false);
    assert.equal((await check('/auth/login-premise/site', 'POST')).allowed, true);
});

it('never interprets operational route prefixes as a billing recovery route', () => {
    for (const path of ['/billing-export', '/auth/me/anything', '/structure/other', '/auth/login-premise']) {
        assert.equal(isBillingRecoveryRequest({path, method: 'GET'}), false, path);
    }
});

it('billing database failures fail closed for staff but do not interrupt patient portal access', async t => {
    fixture(t);
    const failure = new Error('billing database unavailable');
    t.mock.method(BillingAccount, 'findByPk', (async () => {throw failure;}) as any);
    const res: any = {status() {return this;}, json() {return this;}};
    let received: any;
    await requireAuth({path: '/patients', method: 'GET', header: () => jwt.sign(claims(), env.jwtSecret)} as any,
        res, error => {received = error;});
    assert.equal(received, failure);
    let patientAllowed = false;
    await requireAuth({path: '/patient-portal/profile', method: 'GET',
        header: () => jwt.sign(claims({actor: 'patient', patientAccessId: 'access'}), env.jwtSecret)} as any,
        res, error => {assert.equal(error, undefined); patientAllowed = true;});
    assert.equal(patientAllowed, true);
});
