import assert from 'node:assert/strict';
import {it, type TestContext} from 'node:test';
import {Op} from 'sequelize';
import {Tenant} from '../../auth/models/tenant.model.js';
import {TenantUser} from '../../auth/models/tenantUser.model.js';
import {Structure} from '../../auth/models/structure.model.js';
import {RoleCode} from '../../auth/rbac/roles.js';
import {BillingAccount, BillingOperation} from '../models/billing.model.js';
import {assertBillingCapacity, countBillingUsage} from './billingAccess.service.js';

function fixture(t: TestContext, account: any = {
    status: 'active', paidThrough: new Date(Date.now() + 86400000),
    usersLimit: 2, structuresLimit: 2, scheduledChange: null
}) {
    const transaction: any = {LOCK: {UPDATE: 'UPDATE'}};
    const order: string[] = [];
    t.mock.method(Tenant, 'findByPk', (async (tenantId: string, options: any) => {
        assert.equal(tenantId, 'tenant-a'); assert.equal(options.transaction, transaction);
        assert.equal(options.lock, 'UPDATE'); order.push('tenant');
        // Old counters are deliberately wrong: quotas must use real memberships.
        return {maxUserQuantity: 999, userQuantity: 0};
    }) as any);
    t.mock.method(BillingAccount, 'findByPk', (async (_id: string, options: any) => {
        assert.equal(options.transaction, transaction); assert.equal(options.lock, 'UPDATE');
        order.push('billing'); return account;
    }) as any);
    t.mock.method(BillingOperation, 'findOne', (async (options: any) => {
        assert.deepEqual(options.where, {tenantId: 'tenant-a', state: 'processing'});
        assert.equal(options.transaction, transaction); return null;
    }) as any);
    const users = t.mock.method(TenantUser, 'count', (async (options: any) => {
        assert.equal(options.transaction, transaction);
        assert.equal(options.where.tenantId, 'tenant-a');
        assert.equal(options.where.deactivatedAt, null);
        assert.equal(options.where.role[Op.ne], RoleCode.PATIENT);
        assert.equal('isActive' in options.where, false, 'email verification does not release a seat');
        return 1;
    }) as any);
    const structures = t.mock.method(Structure, 'count', (async (options: any) => {
        assert.deepEqual(options.where, {tenantId: 'tenant-a'});
        assert.equal(options.transaction, transaction); return 1;
    }) as any);
    return {transaction, order, users, structures};
}

it('checks actual tenant memberships inside the same transaction after taking parent/account locks', async t => {
    const {transaction, order} = fixture(t);
    await assertBillingCapacity('tenant-a', 'users', transaction);
    assert.deepEqual(order, ['tenant', 'billing']);
    assert.deepEqual(await countBillingUsage('tenant-a', transaction), {users: 1, structures: 1});
});

it('legacy organisations retain their existing creation behavior without evaluating paid capacity', async t => {
    const {transaction, users, structures} = fixture(t, null);
    await assertBillingCapacity('tenant-a', 'users', transaction);
    assert.equal(users.mock.callCount(), 0); assert.equal(structures.mock.callCount(), 0);
});

it('blocks the last reserved place immediately when a reduction is scheduled', async t => {
    const {transaction} = fixture(t, {status: 'active', paidThrough: new Date(Date.now() + 86400000),
        usersLimit: 5, structuresLimit: 3, scheduledChange: {users: 1, structures: 1}});
    for (const resource of ['users', 'structures'] as const) {
        await assert.rejects(assertBillingCapacity('tenant-a', resource, transaction),
            (error: any) => error.statusCode === 409 && error.code === 'BILLING_CAPACITY_EXCEEDED');
    }
});

it('an uncertain billing write blocks capacity consumption until that operation is recovered', async t => {
    const {transaction, users} = fixture(t);
    t.mock.method(BillingOperation, 'findOne', (async () => ({state: 'processing'})) as any);
    await assert.rejects(assertBillingCapacity('tenant-a', 'users', transaction),
        (error: any) => error.code === 'BILLING_CHANGE_PENDING');
    assert.equal(users.mock.callCount(), 0);
});

it('an unpaid account cannot consume capacity even when old counters indicate spare places', async t => {
    const {transaction} = fixture(t, {status: 'pending', paidThrough: null,
        usersLimit: 100, structuresLimit: 100, scheduledChange: null});
    await assert.rejects(assertBillingCapacity('tenant-a', 'users', transaction),
        (error: any) => error.statusCode === 402 && error.code === 'BILLING_ACCESS_REQUIRED');
});
