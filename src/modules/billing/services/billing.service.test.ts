import assert from 'node:assert/strict';
import test, { TestContext } from 'node:test';
import type Stripe from 'stripe';
import { sequelize } from '../../../config/database.js';
import { Tenant } from '../../auth/models/tenant.model.js';
import { TenantUser } from '../../auth/models/tenantUser.model.js';
import { Structure } from '../../auth/models/structure.model.js';
import { RoleCode } from '../../auth/rbac/roles.js';
import { BillingAccount, BillingOperation, BillingQuote } from '../models/billing.model.js';
import { billingReturnUrl, stripeBilling } from './billingConfig.service.js';
import { billingJournal } from './billingJournal.service.js';
import { billingSummary, changeBilling, checkoutBilling, handleBillingWebhook, previewBilling, releaseBillingSchedule } from './billing.service.js';

const principal = { tenantId: 'tenant-a', userId: 'owner-a' };
const operationId = '11111111-1111-4111-8111-111111111111';
const periodEnd = Math.floor(Date.now() / 1000) + 86400;
function setup(t: TestContext) {
    Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_billing_unit_test', STRIPE_BILLING_BASE_PRICE_ID: 'price_base',
        STRIPE_BILLING_USER_PRICE_ID: 'price_user', STRIPE_BILLING_STRUCTURE_PRICE_ID: 'price_structure',
        STRIPE_BILLING_WEBHOOK_SECRET: 'whsec_billing_test', FRONTEND_URL: 'https://rehablo.example', REHABLO_BILLING_ENABLED: 'true' });
    const account: any = { tenantId: principal.tenantId, customerId: 'cus_a', subscriptionId: 'sub_a', checkoutSessionId: null, scheduleId: null,
        status: 'active', usersLimit: 1, structuresLimit: 1, paidThrough: new Date(periodEnd * 1000), currentPeriodEnd: new Date(periodEnd * 1000), cancelAtPeriodEnd: false, scheduledChange: null,
        async save() { return this; } };
    const sub: any = { id: 'sub_a', customer: 'cus_a', status: 'active', metadata: { tenantId: principal.tenantId }, current_period_start: periodEnd - 2592000,
        current_period_end: periodEnd, cancel_at_period_end: false, pending_update: null, schedule: null,
        items: { has_more: false, data: [{ id: 'si_base', price: { id: 'price_base' }, quantity: 1 }] },
        latest_invoice: { id: 'in_paid', subscription: 'sub_a', paid: true, status: 'paid', billing_reason: 'subscription_cycle', lines: { data: [{ type: 'subscription', proration: false, period: { end: periodEnd } }] } } };
    const operations = new Map<string, any>();
    const quotes = new Map<string, any>();
    const makeRow = (attributes: any) => ({ ...attributes, createdAt: new Date(), async update(values: any) { Object.assign(this, values); return this; } });
    t.mock.method(sequelize, 'transaction', async (callback: any) => callback({ LOCK: { UPDATE: 'UPDATE' } }));
    t.mock.method(Tenant, 'findByPk', async () => ({ id: principal.tenantId, maxUserQuantity: 9, maxStructureQuantity: 3, businessName: 'Studio' }));
    t.mock.method(Tenant, 'update', async () => [1]);
    t.mock.method(TenantUser, 'findOne', async () => ({ role: RoleCode.OWNER }));
    t.mock.method(TenantUser, 'count', async () => 1);
    t.mock.method(Structure, 'count', async () => 1);
    t.mock.method(BillingAccount, 'findByPk', async () => account);
    t.mock.method(BillingAccount, 'findOne', async () => account);
    t.mock.method(BillingOperation, 'findByPk', async (id: string) => operations.get(id) ?? null);
    t.mock.method(BillingOperation, 'findOne', async () => [...operations.values()].find(op => op.state === 'processing') ?? null);
    t.mock.method(BillingOperation, 'create', async (values: any) => { const row = makeRow(values); operations.set(row.id, row); return row; });
    t.mock.method(BillingOperation, 'update', async (values: any, options: any) => { const row = operations.get(options.where.id); if (row) Object.assign(row, values); return [row ? 1 : 0]; });
    const saveProgress = t.mock.method(billingJournal, 'saveProgress', async (operation: any) => { const row = operations.get(operation.id); if (row) row.progress = structuredClone(operation.progress); });
    t.mock.method(BillingQuote, 'create', async (values: any) => { const row = makeRow(values); quotes.set(row.id, row); return row; });
    t.mock.method(BillingQuote, 'findOne', async (options: any) => quotes.get(options.where.id) ?? null);
    const stripe = stripeBilling();
    t.mock.method(stripe.prices, 'retrieve', async (id: string) => ({ id, active: true, currency: 'eur', unit_amount: id === 'price_structure' ? 5000 : 1000, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, tax_behavior: 'exclusive' }));
    t.mock.method(stripe.subscriptions, 'retrieve', async () => sub);
    t.mock.method(stripe.invoices, 'retrieveUpcoming', async (params: any) => ({ amount_due: 1220, subtotal: 1000, tax: 220, total: 1220,
        lines: { has_more: false, data: [{ proration: true, period: { start: params.subscription_details.proration_date } }] } }));
    return { account, sub, stripe, operations, quotes, saveProgress };
}

test('Stripe returns use fixed hash routes and never accept an arbitrary destination', t => {
    setup(t);
    assert.equal(billingReturnUrl('team'), 'https://rehablo.example/#/pages/settings?panel=team&billingReturn=1');
    assert.equal(billingReturnUrl('https://attacker.example', true), 'https://rehablo.example/#/activate-subscription?billingReturn=1');
});

test('an unpaid pending upgrade cannot grant extra users; stale duplicate webhooks fetch latest state', async t => {
    const { account, sub } = setup(t);
    sub.items.data.push({ id: 'si_users', price: { id: 'price_user' }, quantity: 4 });
    sub.pending_update = { expires_at: periodEnd };
    sub.latest_invoice = { id: 'in_unpaid', subscription: sub.id, paid: false, status: 'open', lines: { data: [] } };
    const event = { type: 'customer.subscription.updated', data: { object: { id: sub.id, customer: sub.customer, status: 'canceled' } } } as unknown as Stripe.Event;
    await handleBillingWebhook(event);
    assert.equal(account.usersLimit, 1);
    assert.equal(account.status, 'active');
    sub.pending_update = null;
    sub.latest_invoice = { id: 'in_paid', subscription: sub.id, paid: true, status: 'paid', billing_reason: 'subscription_update', lines: { data: [] } };
    await handleBillingWebhook(event);
    await handleBillingWebhook(event);
    assert.equal(account.usersLimit, 5);
});

test('an invoice from another subscription never extends access', async t => {
    const { account, sub } = setup(t);
    account.paidThrough = new Date(0);
    sub.latest_invoice.subscription = 'sub_other';
    await handleBillingWebhook({ type: 'invoice.paid', data: { object: { id: 'in_fake', customer: 'cus_a', subscription: 'sub_a' } } } as unknown as Stripe.Event);
    assert.equal(account.paidThrough.getTime(), 0);
});

test('legacy tenants retain existing limits and do not call Stripe', async t => {
    const { stripe } = setup(t);
    t.mock.method(BillingAccount, 'findByPk', async () => null);
    const forbidden = t.mock.method(stripe.subscriptions, 'retrieve', async () => { throw new Error('must not call Stripe'); });
    const summary = await billingSummary(principal);
    assert.equal(summary.mode, 'legacy');
    assert.equal(summary.accessAllowed, true);
    assert.equal(summary.users.limit, 9);
    assert.equal(forbidden.mock.callCount(), 0);
});

test('duplicate checkout requests create only one Stripe session', async t => {
    const { account, stripe } = setup(t);
    account.subscriptionId = null;
    account.status = 'pending';
    t.mock.method(stripe.subscriptions, 'list', async () => ({ data: [] }));
    const create = t.mock.method(stripe.checkout.sessions, 'create', async () => ({ id: 'cs_a', url: 'https://checkout.stripe.com/test' }));
    const first = await checkoutBilling(principal, operationId, 'billing');
    const retry = await checkoutBilling(principal, operationId, 'billing');
    assert.deepEqual(retry, first);
    assert.equal(create.mock.callCount(), 1);
});

test('only the tenant owner can initiate checkout', async t => {
    const { stripe } = setup(t);
    t.mock.method(TenantUser, 'findOne', async () => ({ role: RoleCode.SECRETARY }));
    const create = t.mock.method(stripe.checkout.sessions, 'create', async () => { throw new Error('must not call'); });
    await assert.rejects(checkoutBilling(principal, operationId, 'billing'), /Solo il titolare/);
    assert.equal(create.mock.callCount(), 0);
});

test('quote is checked against current subscription before any charge', async t => {
    const { sub, stripe } = setup(t);
    const quote = await previewBilling(principal, { users: 2, structures: 1 });
    sub.items.data.push({ id: 'si_users', price: { id: 'price_user' }, quantity: 3 });
    const update = t.mock.method(stripe.subscriptions, 'update', async () => { throw new Error('must not charge'); });
    await assert.rejects(changeBilling(principal, quote.id, operationId, 'team'), /L’abbonamento è cambiato/);
    assert.equal(update.mock.callCount(), 0);
});

test('SCA pending change preserves capacity and duplicate confirm never charges twice', async t => {
    const { account, sub, stripe } = setup(t);
    const quote = await previewBilling(principal, { users: 2, structures: 1 });
    const update = t.mock.method(stripe.subscriptions, 'update', async (_id: string, params: any) => {
        assert.equal(params.payment_behavior, 'pending_if_incomplete');
        assert.equal(params.proration_behavior, 'always_invoice');
        sub.pending_update = { expires_at: periodEnd };
        sub.latest_invoice = { id: 'in_sca', subscription: sub.id, paid: false, status: 'open', hosted_invoice_url: 'https://invoice.stripe.com/sca', lines: { data: [] } };
        return sub;
    });
    const result = await changeBilling(principal, quote.id, operationId, 'team');
    assert.equal(result.status, 'pending');
    assert.equal(result.paymentUrl, 'https://invoice.stripe.com/sca');
    assert.equal(account.usersLimit, 1);
    assert.deepEqual(await changeBilling(principal, quote.id, operationId, 'team'), result);
    assert.equal(update.mock.callCount(), 1);
});

test('scheduled reductions must be released explicitly before another purchase', async t => {
    const { sub, stripe, account } = setup(t);
    sub.schedule = 'sched_a';
    account.scheduledChange = { users: 1, structures: 1, effectiveAt: new Date(periodEnd * 1000).toISOString() };
    await assert.rejects(previewBilling(principal, { users: 2, structures: 1 }), /Annulla la riduzione/);
    const release = t.mock.method(stripe.subscriptionSchedules, 'release', async () => { sub.schedule = null; return {}; });
    const summary = await releaseBillingSchedule(principal, operationId);
    assert.equal(summary.scheduledChange, null);
    assert.equal(release.mock.callCount(), 1);
});

test('a lost Stripe response retries the exact persisted request even after the quote expires', async t => {
    const { sub, stripe, quotes, operations } = setup(t);
    const quote = await previewBilling(principal, { users: 2, structures: 1 });
    const requests: unknown[] = [];
    t.mock.method(stripe.subscriptions, 'update', async (_id: string, params: any, options: any) => {
        requests.push({ params, options });
        if (requests.length === 1) throw new Error('connection lost');
        sub.items.data.push({ id: 'si_users', price: { id: 'price_user' }, quantity: 1 });
        sub.metadata.rehabloOperation = operationId;
        sub.latest_invoice.billing_reason = 'subscription_update';
        return sub;
    });
    await assert.rejects(changeBilling(principal, quote.id, operationId, 'team'), /connection lost/);
    assert.equal(operations.get(operationId).state, 'processing');
    quotes.get(quote.id).expiresAt = new Date(0);
    assert.equal((await changeBilling(principal, quote.id, operationId, 'team')).status, 'applied');
    assert.deepEqual(requests[0], requests[1]);
});

test('a cached pending payment becomes applied after SCA succeeds without charging again', async t => {
    const { sub, stripe, account } = setup(t);
    const quote = await previewBilling(principal, { users: 2, structures: 1 });
    const update = t.mock.method(stripe.subscriptions, 'update', async () => {
        sub.pending_update = { expires_at: periodEnd };
        sub.latest_invoice = { id: 'in_sca', subscription: sub.id, paid: false, status: 'open', hosted_invoice_url: 'https://invoice.stripe.com/sca', lines: { data: [] } };
        return sub;
    });
    assert.equal((await changeBilling(principal, quote.id, operationId, 'team')).status, 'pending');
    sub.pending_update = null;
    sub.items.data.push({ id: 'si_users', price: { id: 'price_user' }, quantity: 1 });
    Object.assign(sub.latest_invoice, { paid: true, status: 'paid', billing_reason: 'subscription_update' });
    assert.equal((await changeBilling(principal, quote.id, operationId, 'team')).status, 'applied');
    assert.equal(account.usersLimit, 2);
    assert.equal(update.mock.callCount(), 1);
});

test('expired SCA returns a definitive error, clearing the cached invalid payment link', async t => {
    const { sub, stripe, operations } = setup(t);
    const quote = await previewBilling(principal, { users: 2, structures: 1 });
    const update = t.mock.method(stripe.subscriptions, 'update', async () => {
        sub.pending_update = { expires_at: periodEnd };
        sub.latest_invoice = { id: 'in_sca', subscription: sub.id, paid: false, status: 'open', hosted_invoice_url: 'https://invoice.stripe.com/sca', lines: { data: [] } };
        return sub;
    });
    await changeBilling(principal, quote.id, operationId, 'team');
    sub.pending_update = null;
    sub.latest_invoice.status = 'void';
    await assert.rejects(changeBilling(principal, quote.id, operationId, 'team'), (error: any) => error.code === 'BILLING_PAYMENT_EXPIRED');
    assert.equal(operations.get(operationId).state, 'failed');
    await assert.rejects(changeBilling(principal, quote.id, operationId, 'team'), (error: any) => error.code === 'BILLING_PAYMENT_EXPIRED');
    assert.equal(update.mock.callCount(), 1);
});

test('an invoice preview containing full renewal charges cannot be shown as due today', async t => {
    const { stripe } = setup(t);
    t.mock.method(stripe.invoices, 'retrieveUpcoming', async () => ({ amount_due: 3000, subtotal: 3000, tax: 0, total: 3000,
        lines: { has_more: false, data: [{ proration: false, period: { start: periodEnd } }] } }));
    await assert.rejects(previewBilling(principal, { users: 2, structures: 1 }), (error: any) => error.code === 'BILLING_PREVIEW_MISMATCH');
});

test('failure to durably save payment intent never starts the Stripe mutation', async t => {
    const { stripe, operations, saveProgress } = setup(t);
    const quote = await previewBilling(principal, { users: 2, structures: 1 });
    saveProgress.mock.mockImplementation(async () => { throw new Error('journal unavailable'); });
    const update = t.mock.method(stripe.subscriptions, 'update', async () => { throw new Error('must not charge'); });
    await assert.rejects(changeBilling(principal, quote.id, operationId, 'team'), /journal unavailable/);
    assert.equal(update.mock.callCount(), 0);
    assert.equal(operations.get(operationId).state, 'processing');
});
