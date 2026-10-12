import assert from 'node:assert/strict';
import { it, TestContext } from 'node:test';
import jwt from 'jsonwebtoken';
import { env } from '../../../config/env.js';
import { Tenant, TenantUser, User } from '../models/index.js';
import RefreshToken from '../models/refreshToken.model.js';
import AccountActionToken from '../models/accountActionToken.model.js';
import { findTenantById, updateTenant, licenseSecret } from './tenant.controller.js';
import { updateUserCalendarColor, verificationAccount, resetPassword } from './user.controller.js';
import { loginWithToken } from './auth.controller.js';
import { selectSessionContext } from './session.controller.js';

const row = (data: any): any => ({ get: (key: any) => typeof key === 'string' ? data[key] : { ...data } });
function run(handler: any, req: any): Promise<any> {
    return new Promise(resolve => {
        const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; },
            json(body: any) { resolve({ status: this.statusCode, body }); return this; } };
        handler(req, res, (error: any) => resolve({ status: error.statusCode ?? 500, error }));
    });
}
function fixture(t: TestContext) {
    const principal = { id: 'user', sub: 'user', tid: 'tenant-a', email: 'user@example.invalid', isSuperAdmin: true,
        actor: 'staff', tenants: [{ id: 'tenant-a' }, { id: 'tenant-b' }], authVersion: 0 };
    const membership = t.mock.method(TenantUser, 'findOne', (async (options: any) =>
        options.where.tenantId === 'tenant-a' && options.where.userId === 'user' ? row({ role: 'OWNER', deactivatedAt: null }) : null) as any);
    const tenantRead = t.mock.method(Tenant, 'findByPk', (async () => row({ id: 'tenant-a' })) as any);
    const tenantWrite = t.mock.method(Tenant, 'update', (async () => [1, []]) as any);
    const userWrite = t.mock.method(User, 'update', (async () => [1]) as any);
    t.mock.method(User, 'findByPk', (async () => row({ id: 'user', email: principal.email, isActive: true,
        isSuperAdmin: true, authVersion: 0, calendarColor: 'blue' })) as any);
    return { req: { user: principal, params: {} as any, body: {} as any } as any, tenantRead, tenantWrite, userWrite, membership };
}

it('tenant GET and PUT reject another tenant even when its id appears in the old JWT list', async t => {
    const { req, tenantRead, tenantWrite, membership } = fixture(t); req.params.tenantId = 'tenant-b';
    assert.equal((await run(findTenantById, req)).status, 403);
    assert.equal((await run(updateTenant, req)).status, 403);
    assert.equal(tenantRead.mock.callCount(), 0); assert.equal(tenantWrite.mock.callCount(), 0); assert.equal(membership.mock.callCount(), 0);
});
it('tenant GET requires a current active membership and still serves the selected owner tenant', async t => {
    const { req, membership } = fixture(t); req.params.tenantId = 'tenant-a';
    assert.equal((await run(findTenantById, req)).status, 200);
    assert.equal((membership.mock.calls[0].arguments[0] as any).where.deactivatedAt, null);
    t.mock.method(TenantUser, 'findOne', (async () => null) as any);
    assert.equal((await run(findTenantById, req)).status, 403);
});
it('tenant updates preserve editable company data while rejecting identity/subscription assignment', async t => {
    const { req, tenantWrite } = fixture(t); req.params.tenantId = 'tenant-a';
    req.body = { businessName: 'New company name', id: 'tenant-b', license: 'fake-license', isPremium: true, maxUserQuantity: 999 };
    assert.equal((await run(updateTenant, req)).status, 200);
    assert.deepEqual(tenantWrite.mock.calls[0].arguments[0], { businessName: 'New company name' });
    assert.deepEqual((tenantWrite.mock.calls[0].arguments[1] as any).where, { id: 'tenant-a' });
});
it('calendar color cannot modify a user outside the current tenant, even for its owner', async t => {
    const { req, userWrite } = fixture(t); req.params.userId = 'foreign-user'; req.body.calendarColor = 'blue';
    assert.equal((await run(updateUserCalendarColor, req)).status, 403);
    assert.equal(userWrite.mock.callCount(), 0);
});
it('calendar color self-service remains available to an ordinary current staff member', async t => {
    const { req, userWrite } = fixture(t); req.user.isSuperAdmin = false; req.params.userId = 'user'; req.body.calendarColor = 'blue';
    assert.equal((await run(updateUserCalendarColor, req)).status, 200);
    assert.deepEqual(userWrite.mock.calls[0].arguments[0], { calendarColor: 'blue' });
    req.user.actor = 'patient';
    assert.equal((await run(updateUserCalendarColor, req)).status, 403);
});
it('login-token cannot upgrade a pre-reset or selection JWT into a current application session', async t => {
    const { req } = fixture(t);
    t.mock.method(User, 'findByPk', (async () => row({ id: 'user', isActive: true, authVersion: 1 })) as any);
    for (const patch of [{ tokenUse: 'application' }, { tokenUse: 'context_selection', authVersion: 1 }]) {
        req.body = { accessToken: jwt.sign({ ...req.user, ...patch }, env.jwtSecret) };
        assert.equal((await run(loginWithToken, req)).status, 401);
    }
});
it('context selection refuses an older identity version before creating any refresh token', async t => {
    const { req } = fixture(t);
    t.mock.method(User, 'findByPk', (async () => row({ id: 'user', isActive: true, authVersion: 1 })) as any);
    const issued = t.mock.method(RefreshToken, 'create', (async () => assert.fail('must not issue')) as any);
    req.body = { selectionToken: jwt.sign({ sub: 'user', tokenUse: 'context_selection' }, env.jwtSecret), contextId: 'staff:tenant-a' };
    assert.equal((await run(selectSessionContext, req)).status, 401); assert.equal(issued.mock.callCount(), 0);
});
it('old email JWTs return the new actionable 400 error and no license secret is rotated', async t => {
    const { req } = fixture(t);
    assert.equal(licenseSecret, env.jwtSecret + '::license');
    const lookup = t.mock.method(AccountActionToken, 'findOne', (async () => assert.fail('legacy JWT must not query')) as any);
    const token = jwt.sign({ email: req.user.email }, licenseSecret, { expiresIn: '12h' });
    req.params = { verificationToken: token, resetPasswordToken: token }; req.body.password = 'new-password';
    for (const handler of [verificationAccount, resetPassword]) {
        const result = await run(handler, req);
        assert.equal(result.status, 400); assert.equal(result.body.error.code, 'ACCOUNT_ACTION_TOKEN_INVALID');
    }
    assert.equal(lookup.mock.callCount(), 0);
});
