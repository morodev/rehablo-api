import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { Op, Transaction } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { Tenant } from '../../auth/models/tenant.model.js';
import { TenantUser } from '../../auth/models/tenantUser.model.js';
import { RoleCode } from '../../auth/rbac/roles.js';
import { BillingAccount, BillingOperation, BillingQuote } from '../models/billing.model.js';
import { countBillingUsage } from './billingAccess.service.js';
import { billingConfigured, billingEnabled, billingPriceIds, billingReturnUrl, stripeBilling, validateBillingPrices } from './billingConfig.service.js';
import { BILLING_PRICES, BillingError, assertUsageFits, billingAccessAllowed, changeKind, monthlyAmount, validateQuantities } from './billing.policy.js';
import { billingJournal } from './billingJournal.service.js';

type Principal = { tenantId: string; userId: string };
type Quantities = { users: number; structures: number };
type Mutation = 'checkout' | 'change' | 'cancel' | 'releaseSchedule';
const toId = (value: string | { id: string } | null | undefined): string | null => typeof value === 'string' ? value : value?.id ?? null;
const date = (value: number): Date => new Date(value * 1000);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function billingCatalog() { return { enabled: billingEnabled(), configured: billingConfigured(), currency: 'eur', prices: BILLING_PRICES }; }

async function owner(principal: Principal, transaction?: Transaction): Promise<void> {
    const membership = await TenantUser.findOne({ where: { tenantId: principal.tenantId, userId: principal.userId, deactivatedAt: null }, transaction });
    if (membership?.role !== RoleCode.OWNER) throw new BillingError(403, 'Solo il titolare può gestire l’abbonamento.', 'BILLING_OWNER_REQUIRED');
}
async function lockAccount(tenantId: string, transaction: Transaction): Promise<BillingAccount> {
    await Tenant.findByPk(tenantId, { transaction, lock: transaction.LOCK.UPDATE });
    const account = await BillingAccount.findByPk(tenantId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!account) throw new BillingError(409, 'Il tuo contratto attuale resta invariato. Contatta l’assistenza per il passaggio al nuovo abbonamento.', 'BILLING_LEGACY');
    return account;
}
function subscriptionQuantities(sub: Stripe.Subscription): Quantities {
    const ids = billingPriceIds();
    const base = sub.items.data.filter(item => item.price.id === ids.base);
    if (sub.items.has_more || base.length !== 1 || base[0].quantity !== 1 || sub.items.data.some(item => !Object.values(ids).includes(item.price.id)) ||
        new Set(sub.items.data.map(item => item.price.id)).size !== sub.items.data.length) throw new BillingError(409, 'La composizione dell’abbonamento richiede una verifica dell’assistenza.', 'BILLING_SUBSCRIPTION_MISMATCH');
    const quantities = { users: 1 + (sub.items.data.find(item => item.price.id === ids.user)?.quantity ?? 0), structures: 1 + (sub.items.data.find(item => item.price.id === ids.structure)?.quantity ?? 0) };
    validateQuantities(quantities.users, quantities.structures);
    return quantities;
}
function subscriptionItems(sub: Stripe.Subscription, target: Quantities): Stripe.SubscriptionUpdateParams.Item[] {
    const ids = billingPriceIds();
    return ([['base', 1], ['user', target.users - 1], ['structure', target.structures - 1]] as const).flatMap<Stripe.SubscriptionUpdateParams.Item>(([kind, quantity]) => {
        const existing = sub.items.data.find(item => item.price.id === ids[kind]);
        if (quantity === 0) return existing ? [{ id: existing.id, deleted: true }] : [];
        return [{ ...(existing ? { id: existing.id } : {}), price: ids[kind], quantity }];
    });
}
function phaseItems(target: Quantities) {
    const ids = billingPriceIds();
    return [{ price: ids.base, quantity: 1 }, ...(target.users > 1 ? [{ price: ids.user, quantity: target.users - 1 }] : []), ...(target.structures > 1 ? [{ price: ids.structure, quantity: target.structures - 1 }] : [])];
}
function fingerprint(sub: Stripe.Subscription): string {
    return JSON.stringify({ id: sub.id, status: sub.status, start: sub.current_period_start, end: sub.current_period_end, cancel: sub.cancel_at_period_end,
        pending: sub.pending_update, items: sub.items.data.map(item => [item.id, item.price.id, item.quantity]).sort() });
}
async function fetchSubscription(account: BillingAccount): Promise<Stripe.Subscription | null> {
    if (!account.subscriptionId) return null;
    const sub = await stripeBilling().subscriptions.retrieve(account.subscriptionId, { expand: ['latest_invoice'] });
    if (toId(sub.customer) !== account.customerId || sub.metadata.tenantId !== account.tenantId) throw new BillingError(409, 'Abbonamento non associato a questa organizzazione.', 'BILLING_SUBSCRIPTION_MISMATCH');
    return sub;
}

/** Fresh Stripe state, read under the tenant lock, makes duplicates/out-of-order webhooks harmless. */
async function reconcile(account: BillingAccount, sub: Stripe.Subscription, transaction: Transaction): Promise<void> {
    const quantities = subscriptionQuantities(sub);
    account.status = sub.status;
    account.currentPeriodEnd = date(sub.current_period_end);
    account.cancelAtPeriodEnd = sub.cancel_at_period_end;
    const invoice = typeof sub.latest_invoice === 'string' ? await stripeBilling().invoices.retrieve(sub.latest_invoice) : sub.latest_invoice;
    const coversPeriod = invoice?.lines.data.some(line => line.type === 'subscription' && !line.proration && line.period.end === sub.current_period_end);
    const paidChange = invoice?.billing_reason === 'subscription_update' && account.paidThrough && account.paidThrough.getTime() >= sub.current_period_end * 1000;
    if (invoice?.paid && invoice.status === 'paid' && toId(invoice.subscription) === sub.id && (coversPeriod || paidChange) && !sub.pending_update && sub.status === 'active') {
        account.usersLimit = quantities.users;
        account.structuresLimit = quantities.structures;
        account.paidThrough = date(sub.current_period_end);
    }
    account.scheduleId = toId(sub.schedule);
    if (account.scheduleId) {
        const schedule = await stripeBilling().subscriptionSchedules.retrieve(account.scheduleId);
        const future = schedule.phases.find(phase => phase.start_date >= sub.current_period_end);
        if (future && schedule.status === 'active') {
            const ids = billingPriceIds();
            account.scheduledChange = { users: 1 + (future.items.find(item => toId(item.price) === ids.user)?.quantity ?? 0), structures: 1 + (future.items.find(item => toId(item.price) === ids.structure)?.quantity ?? 0), effectiveAt: date(future.start_date).toISOString() };
        } else account.scheduledChange = null;
    } else account.scheduledChange = null;
    await account.save({ transaction });
    // Keep existing authentication/session payloads and legacy counters compatible.
    await Tenant.update({ maxUserQuantity: account.usersLimit, maxStructureQuantity: account.structuresLimit }, { where: { id: account.tenantId }, transaction });
}

export async function billingSummary(principal: Principal, refresh = true) {
    if (refresh && billingConfigured()) {
        const exists = await BillingAccount.findByPk(principal.tenantId);
        if (exists?.subscriptionId || exists?.checkoutSessionId) await sequelize.transaction(async transaction => {
            const account = await lockAccount(principal.tenantId, transaction);
            if (account.checkoutSessionId && !account.subscriptionId) {
                const checkout = await stripeBilling().checkout.sessions.retrieve(account.checkoutSessionId);
                if (checkout.status === 'complete' && toId(checkout.subscription)) account.subscriptionId = toId(checkout.subscription);
            }
            const sub = await fetchSubscription(account);
            if (sub) await reconcile(account, sub, transaction);
        });
    }
    const [account, tenant, usage, membership] = await Promise.all([
        BillingAccount.findByPk(principal.tenantId), Tenant.findByPk(principal.tenantId), countBillingUsage(principal.tenantId),
        TenantUser.findOne({ where: { tenantId: principal.tenantId, userId: principal.userId, deactivatedAt: null } })
    ]);
    if (!tenant || !membership || membership.role === RoleCode.PATIENT) throw new BillingError(403, 'Organizzazione non accessibile.');
    return { mode: account ? 'subscription' : 'legacy', status: account?.status ?? 'legacy', accessAllowed: billingAccessAllowed(account),
        canManage: membership.role === RoleCode.OWNER, configured: billingConfigured(), currency: 'eur', prices: BILLING_PRICES,
        users: { used: usage.users, limit: account?.usersLimit ?? tenant.maxUserQuantity }, structures: { used: usage.structures, limit: account?.structuresLimit ?? tenant.maxStructureQuantity },
        monthlyAmount: account ? monthlyAmount(account.usersLimit, account.structuresLimit) : 0, currentPeriodEnd: account?.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: account?.cancelAtPeriodEnd ?? false, scheduledChange: account?.scheduledChange ?? null };
}

function assertMutable(sub: Stripe.Subscription): void {
    if (sub.status !== 'active') throw new BillingError(409, 'Regolarizza il pagamento prima di modificare l’abbonamento.', 'BILLING_PAYMENT_REQUIRED');
    if (sub.pending_update) throw new BillingError(409, 'Completa il pagamento della modifica precedente prima di continuare.', 'BILLING_CHANGE_PENDING');
    if (sub.cancel_at_period_end) throw new BillingError(409, 'Annulla prima la disdetta per modificare i posti.');
}
async function invoicePreview(sub: Stripe.Subscription, target: Quantities, prorationDate: number) {
    const invoice = await stripeBilling().invoices.retrieveUpcoming({ subscription: sub.id, customer: toId(sub.customer)!, preview_mode: 'next',
        subscription_details: { items: subscriptionItems(sub, target), proration_behavior: 'always_invoice', proration_date: prorationDate } });
    // `always_invoice` previews the immediate update invoice. Do not accidentally quote
    // an entire renewal (or unrelated pending invoice items) as the amount due today.
    // Keep Stripe's invoice totals, including tax, discounts and customer balance.
    if (invoice.lines.has_more || invoice.lines.data.some(line => !line.proration || line.period.start !== prorationDate)) {
        throw new BillingError(409, 'Stripe ha restituito voci diverse dall’acquisto richiesto. Contatta l’assistenza per verificare il preventivo.', 'BILLING_PREVIEW_MISMATCH');
    }
    return invoice;
}

async function resolvePendingChange(account: BillingAccount, operation: BillingOperation, transaction: Transaction) {
    const expired = () => new BillingError(409, 'Il pagamento della modifica è scaduto o è stato annullato. Richiedi un nuovo preventivo.', 'BILLING_PAYMENT_EXPIRED');
    const quote = await BillingQuote.findOne({ where: { id: operation.request.quoteId, tenantId: account.tenantId }, transaction });
    const sub = await fetchSubscription(account);
    if (!quote || !sub || (operation.progress?.subscriptionId && operation.progress.subscriptionId !== sub.id)) throw expired();
    await reconcile(account, sub, transaction);
    const originalInvoiceId = operation.progress?.invoiceId as string | undefined;
    const latestInvoice = typeof sub.latest_invoice === 'string' ? await stripeBilling().invoices.retrieve(sub.latest_invoice) : sub.latest_invoice;
    const invoice = originalInvoiceId && originalInvoiceId !== latestInvoice?.id ? await stripeBilling().invoices.retrieve(originalInvoiceId) : latestInvoice;
    const current = subscriptionQuantities(sub);
    const targetConfirmed = current.users === quote.payload.users && current.structures === quote.payload.structures &&
        account.usersLimit === quote.payload.users && account.structuresLimit === quote.payload.structures;
    if (invoice?.paid && invoice.status === 'paid' && toId(invoice.subscription) === sub.id &&
        (originalInvoiceId === invoice.id || (targetConfirmed && !sub.pending_update))) return { status: 'applied' };
    const pending = sub.pending_update;
    const pendingItems = pending?.subscription_items;
    const matchesTarget = !!pendingItems && [
        [billingPriceIds().base, 1], [billingPriceIds().user, quote.payload.users - 1], [billingPriceIds().structure, quote.payload.structures - 1]
    ].every(([price, quantity]) => (pendingItems.find(item => toId(item.price) === price)?.quantity ?? 0) === quantity);
    if (pending && pending.expires_at * 1000 > Date.now() && invoice?.status === 'open' && !invoice.paid &&
        toId(invoice.subscription) === sub.id && invoice.id === latestInvoice?.id && (originalInvoiceId === invoice.id || matchesTarget)) {
        return { status: 'pending', ...(invoice.hosted_invoice_url ? { paymentUrl: invoice.hosted_invoice_url } : {}) };
    }
    throw expired();
}

export async function previewBilling(principal: Principal, target: Quantities) {
    validateQuantities(target.users, target.structures);
    await owner(principal);
    await validateBillingPrices();
    return sequelize.transaction(async transaction => {
        const account = await lockAccount(principal.tenantId, transaction);
        await owner(principal, transaction);
        const sub = await fetchSubscription(account);
        if (!sub) throw new BillingError(409, 'Attiva prima l’abbonamento.');
        assertMutable(sub);
        if (sub.schedule) throw new BillingError(409, 'Annulla la riduzione programmata prima di modificare i posti.', 'BILLING_SCHEDULE_PENDING');
        const kind = changeKind(subscriptionQuantities(sub), target);
        assertUsageFits(await countBillingUsage(principal.tenantId, transaction), target);
        const prorationDate = Math.floor(Date.now() / 1000);
        const preview = kind === 'increase' ? await invoicePreview(sub, target, prorationDate) : null;
        const id = randomUUID();
        const expiresAt = new Date(Math.min(Date.now() + 600000, sub.current_period_end * 1000));
        const payload = { id, kind, ...target, amountDue: preview?.amount_due ?? 0, subtotal: preview?.subtotal ?? 0,
            tax: preview?.tax ?? 0, total: preview?.total ?? 0, monthlyAmount: monthlyAmount(target.users, target.structures),
            effectiveAt: kind === 'increase' ? date(prorationDate).toISOString() : date(sub.current_period_end).toISOString(), expiresAt: expiresAt.toISOString(), currency: 'eur' };
        await BillingQuote.create({ id, tenantId: principal.tenantId, userId: principal.userId, subscriptionFingerprint: fingerprint(sub), prorationDate, expiresAt, payload }, { transaction });
        return payload;
    });
}

/** Durable ledger + tenant row lock + Stripe idempotency keys cover duplicate clicks and lost HTTP responses. */
async function mutation(principal: Principal, id: unknown, kind: Mutation, request: Record<string, any>, execute: (account: BillingAccount, op: BillingOperation, transaction: Transaction) => Promise<Record<string, any>>) {
    if (typeof id !== 'string' || !uuid.test(id)) throw new BillingError(422, 'Identificativo operazione non valido.');
    await owner(principal);
    stripeBilling();
    await sequelize.transaction(async transaction => {
        await lockAccount(principal.tenantId, transaction);
        await owner(principal, transaction);
        const existing = await BillingOperation.findByPk(id, { transaction });
        if (existing) {
            if (existing.tenantId !== principal.tenantId || existing.kind !== kind || JSON.stringify(Object.entries(existing.request).sort()) !== JSON.stringify(Object.entries(request).sort())) throw new BillingError(409, 'Identificativo già utilizzato per una richiesta diversa.');
            return;
        }
        const pending = await BillingOperation.findOne({ where: { tenantId: principal.tenantId, state: 'processing' }, transaction });
        if (pending) throw new BillingError(409, 'Una modifica è ancora in elaborazione. Riprendi l’operazione precedente.', 'BILLING_CHANGE_PENDING');
        await BillingOperation.create({ id, tenantId: principal.tenantId, kind, request, state: 'processing' }, { transaction });
    });
    try {
        return await sequelize.transaction(async transaction => {
            const account = await lockAccount(principal.tenantId, transaction);
            await owner(principal, transaction);
            // Tenant row serializes mutations. Leave the journal row unlocked so progress can
            // be committed independently before remote I/O, surviving an outer rollback.
            const operation = (await BillingOperation.findByPk(id, { transaction }))!;
            if (operation.state === 'complete') {
                if (operation.kind === 'change' && operation.result?.status === 'pending') {
                    const result = await resolvePendingChange(account, operation, transaction);
                    await operation.update({ result }, { transaction });
                    return result;
                }
                return operation.result!;
            }
            if (operation.state === 'failed') throw new BillingError(operation.result?.statusCode ?? 409, operation.result?.message ?? 'Operazione non riuscita. Richiedi un nuovo preventivo.', operation.result?.code ?? 'BILLING_ERROR');
            const result = await execute(account, operation, transaction);
            await operation.update({ state: 'complete', result }, { transaction });
            return result;
        });
    } catch (error) {
        // Network/5xx errors remain retryable; never start another potentially chargeable action.
        if (error instanceof BillingError || (error instanceof Stripe.errors.StripeError && error.statusCode && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 409 && error.statusCode !== 429)) {
            await BillingOperation.update({ state: 'failed', result: { statusCode: error instanceof BillingError ? error.statusCode : 409, code: error instanceof BillingError ? error.code : 'BILLING_ERROR', message: error instanceof BillingError ? error.message : 'Stripe non ha potuto completare l’operazione. Controlla il metodo di pagamento.' } },
                { where: { id, tenantId: principal.tenantId, state: error instanceof BillingError && error.code === 'BILLING_PAYMENT_EXPIRED' ? { [Op.in]: ['processing', 'complete'] } : 'processing' } });
        }
        throw error;
    }
}

export async function checkoutBilling(principal: Principal, operationId: unknown, returnTo: unknown) {
    await validateBillingPrices();
    return mutation(principal, operationId, 'checkout', { returnTo: normalizeReturn(returnTo) }, async (account, operation, transaction) => {
        const stripe = stripeBilling();
        if (!operation.progress) {
            operation.progress = { startedAt: Date.now(), users: account.usersLimit, structures: account.structuresLimit };
            await billingJournal.saveProgress(operation);
        }
        if (operation.progress.customerId) account.customerId = operation.progress.customerId;
        if (!account.customerId) {
            if (Date.now() - operation.progress.startedAt > 23 * 60 * 60 * 1000) throw new Error('La verifica dell’attivazione richiede assistenza: operazione in attesa di riconciliazione.');
            const tenant = (await Tenant.findByPk(principal.tenantId, { transaction }))!;
            const customer = await stripe.customers.create({ name: tenant.businessName || undefined, email: tenant.email || undefined, metadata: { tenantId: principal.tenantId } }, { idempotencyKey: `rehablo-customer-${principal.tenantId}` });
            account.customerId = customer.id;
            operation.progress = { ...operation.progress, customerId: customer.id };
            await billingJournal.saveProgress(operation);
        }
        // Recover any completed checkout even if the browser never returned or the webhook was delayed.
        const subscriptions = await stripe.subscriptions.list({ customer: account.customerId, status: 'all', limit: 100 });
        const live = subscriptions.data.find(sub => !['canceled', 'incomplete_expired'].includes(sub.status));
        if (live) {
            if (live.metadata.tenantId !== principal.tenantId) throw new BillingError(409, 'È già presente un abbonamento: contatta l’assistenza prima di continuare.');
            account.subscriptionId = live.id;
            await reconcile(account, await stripe.subscriptions.retrieve(live.id, { expand: ['latest_invoice'] }), transaction);
            const invoice = typeof live.latest_invoice === 'string' ? await stripe.invoices.retrieve(live.latest_invoice) : live.latest_invoice;
            return { url: invoice?.hosted_invoice_url && !invoice.paid ? invoice.hosted_invoice_url : billingReturnUrl(returnTo, true) };
        }
        if (account.checkoutSessionId) {
            const current = await stripe.checkout.sessions.retrieve(account.checkoutSessionId);
            if (current.status === 'open' && current.url) return { url: current.url };
        }
        if (Date.now() - operation.progress.startedAt > 23 * 60 * 60 * 1000) throw new Error('La verifica dell’attivazione richiede assistenza: operazione in attesa di riconciliazione.');
        // Operation is persisted before this call, so recovery uses the identical request and key.
        const session = await stripe.checkout.sessions.create({ mode: 'subscription', customer: account.customerId, client_reference_id: principal.tenantId,
            line_items: phaseItems({ users: operation.progress.users, structures: operation.progress.structures }), payment_method_types: ['card'],
            automatic_tax: { enabled: true }, billing_address_collection: 'required', tax_id_collection: { enabled: true }, customer_update: { address: 'auto', name: 'auto' },
            subscription_data: { metadata: { tenantId: principal.tenantId, rehabloBilling: 'v1' } }, metadata: { tenantId: principal.tenantId, rehabloOperation: operation.id },
            success_url: billingReturnUrl(returnTo, true), cancel_url: billingReturnUrl(returnTo, true, true) }, { idempotencyKey: `rehablo-checkout-${operation.id}` });
        account.checkoutSessionId = session.id;
        account.subscriptionId = null;
        account.status = 'pending';
        await account.save({ transaction });
        if (!session.url) throw new BillingError(502, 'Stripe non ha restituito il collegamento di pagamento.');
        return { url: session.url };
    });
}

function normalizeReturn(value: unknown): 'billing' | 'team' | 'premises' { return value === 'team' || value === 'premises' ? value : 'billing'; }

export async function changeBilling(principal: Principal, quoteId: unknown, operationId: unknown, returnTo: unknown) {
    if (typeof quoteId !== 'string' || !uuid.test(quoteId)) throw new BillingError(422, 'Preventivo non valido.');
    return mutation(principal, operationId, 'change', { quoteId, returnTo: normalizeReturn(returnTo) }, async (account, operation, transaction) => {
        const quote = await BillingQuote.findOne({ where: { id: quoteId, tenantId: principal.tenantId, userId: principal.userId }, transaction });
        if (!quote) throw new BillingError(404, 'Preventivo non trovato.');
        const stripe = stripeBilling();
        let sub = await fetchSubscription(account);
        if (!sub) throw new BillingError(409, 'Attiva prima l’abbonamento.');
        const target = { users: quote.payload.users as number, structures: quote.payload.structures as number };
        const key = `rehablo-change-${operation.id}`;
        // Recover a successfully applied operation after an interrupted database commit.
        if (sub.metadata.rehabloOperation === operation.id) {
            return resolvePendingChange(account, operation, transaction);
        }
        if (sub.schedule) {
            const schedule = await stripe.subscriptionSchedules.retrieve(toId(sub.schedule)!);
            if (schedule.metadata?.rehabloOperation === operation.id) {
                await reconcile(account, sub, transaction);
                return { status: 'scheduled' };
            }
        }
        if (!operation.progress) {
            if (quote.expiresAt.getTime() <= Date.now()) throw new BillingError(409, 'Il preventivo è scaduto. Richiedine uno aggiornato.', 'BILLING_QUOTE_EXPIRED');
            if (fingerprint(sub) !== quote.subscriptionFingerprint) throw new BillingError(409, 'L’abbonamento è cambiato. Richiedi un nuovo preventivo.', 'BILLING_QUOTE_STALE');
            assertMutable(sub);
            if (sub.schedule) throw new BillingError(409, 'Annulla la riduzione programmata prima di modificare i posti.', 'BILLING_SCHEDULE_PENDING');
            assertUsageFits(await countBillingUsage(principal.tenantId, transaction), target);
            if (quote.payload.kind === 'increase') {
                const preview = await invoicePreview(sub, target, quote.prorationDate);
                if (preview.amount_due !== quote.payload.amountDue || preview.total !== quote.payload.total || (preview.tax ?? 0) !== quote.payload.tax) throw new BillingError(409, 'L’importo è cambiato. Controlla un nuovo preventivo prima di confermare.', 'BILLING_QUOTE_STALE');
            }
            operation.progress = { startedAt: Date.now(), subscriptionId: sub.id, items: subscriptionItems(sub, target), current: subscriptionQuantities(sub), periodStart: sub.current_period_start, periodEnd: sub.current_period_end };
            await billingJournal.saveProgress(operation);
        }
        if (Date.now() - operation.progress.startedAt > 23 * 60 * 60 * 1000) {
            // Stripe only guarantees retention of idempotency keys for 24 hours. Keep this
            // operation pending instead of risking a second payment after that window.
            throw new Error('La verifica del pagamento richiede assistenza: operazione in attesa di riconciliazione.');
        }
        if (quote.payload.kind === 'decrease') {
            const schedule = sub.schedule ? await stripe.subscriptionSchedules.retrieve(toId(sub.schedule)!) : await stripe.subscriptionSchedules.create({ from_subscription: sub.id }, { idempotencyKey: `${key}-schedule` });
            await stripe.subscriptionSchedules.update(schedule.id, { end_behavior: 'release', proration_behavior: 'none', metadata: { tenantId: principal.tenantId, rehabloOperation: operation.id },
                phases: [
                    { start_date: operation.progress.periodStart, end_date: operation.progress.periodEnd, items: phaseItems(operation.progress.current), proration_behavior: 'none', automatic_tax: { enabled: true } },
                    { start_date: operation.progress.periodEnd, iterations: 1, items: phaseItems(target), proration_behavior: 'none', automatic_tax: { enabled: true } }
                ] }, { idempotencyKey: `${key}-schedule-update` });
            sub = (await fetchSubscription(account))!;
            await reconcile(account, sub, transaction);
            return { status: 'scheduled' };
        }
        sub = await stripe.subscriptions.update(operation.progress.subscriptionId, { items: operation.progress.items, payment_behavior: 'pending_if_incomplete', proration_behavior: 'always_invoice', proration_date: quote.prorationDate,
            metadata: { rehabloOperation: operation.id }, expand: ['latest_invoice'] }, { idempotencyKey: key });
        await reconcile(account, sub, transaction);
        const invoice = typeof sub.latest_invoice === 'string' ? await stripe.invoices.retrieve(sub.latest_invoice) : sub.latest_invoice;
        if (invoice?.id) {
            operation.progress = { ...operation.progress, invoiceId: invoice.id };
            await billingJournal.saveProgress(operation);
        }
        return { status: !sub.pending_update && invoice?.paid ? 'applied' : 'pending', ...(invoice?.hosted_invoice_url && !invoice.paid ? { paymentUrl: invoice.hosted_invoice_url } : {}) };
    });
}

export async function portalBilling(principal: Principal) {
    await owner(principal);
    const account = await BillingAccount.findByPk(principal.tenantId);
    if (!account?.customerId) throw new BillingError(409, 'Attiva prima l’abbonamento.');
    // This explicit configuration keeps multi-product quantities/cancellation under Rehablo's quota checks.
    const configuration = await stripeBilling().billingPortal.configurations.create({ business_profile: { headline: 'Rehablo: pagamenti e fatture' },
        features: { customer_update: { enabled: true, allowed_updates: ['address', 'email', 'name', 'tax_id'] }, invoice_history: { enabled: true },
            payment_method_update: { enabled: true }, subscription_cancel: { enabled: false }, subscription_update: { enabled: false, default_allowed_updates: [], products: [] } } }, { idempotencyKey: 'rehablo-billing-portal-v1' });
    const session = await stripeBilling().billingPortal.sessions.create({ customer: account.customerId, configuration: configuration.id, return_url: billingReturnUrl('billing') });
    return { url: session.url };
}

export async function cancelBilling(principal: Principal, cancelAtPeriodEnd: unknown, operationId?: unknown) {
    if (typeof cancelAtPeriodEnd !== 'boolean') throw new BillingError(422, 'Indica se annullare l’abbonamento a fine periodo.');
    await mutation(principal, operationId ?? randomUUID(), 'cancel', { cancelAtPeriodEnd }, async (account, operation, transaction) => {
        const sub = await fetchSubscription(account);
        if (!sub || !['active', 'past_due'].includes(sub.status)) throw new BillingError(409, 'Nessun abbonamento attivo da modificare.');
        if (sub.pending_update) throw new BillingError(409, 'Completa prima la modifica in attesa di pagamento.');
        if (sub.schedule) await stripeBilling().subscriptionSchedules.release(toId(sub.schedule)!, { preserve_cancel_date: true }, { idempotencyKey: `rehablo-cancel-${operation.id}-release` });
        const changed = await stripeBilling().subscriptions.update(sub.id, { cancel_at_period_end: cancelAtPeriodEnd, expand: ['latest_invoice'] }, { idempotencyKey: `rehablo-cancel-${operation.id}` });
        await reconcile(account, changed, transaction);
        return { status: 'applied' };
    });
    return billingSummary(principal, false);
}

export async function releaseBillingSchedule(principal: Principal, operationId?: unknown) {
    await mutation(principal, operationId ?? randomUUID(), 'releaseSchedule', {}, async (account, operation, transaction) => {
        const sub = await fetchSubscription(account);
        if (!sub) throw new BillingError(409, 'Nessun abbonamento attivo.');
        if (sub.schedule) await stripeBilling().subscriptionSchedules.release(toId(sub.schedule)!, { preserve_cancel_date: true }, { idempotencyKey: `rehablo-release-${operation.id}` });
        await reconcile(account, (await fetchSubscription(account))!, transaction);
        return { status: 'applied' };
    });
    return billingSummary(principal, false);
}

export async function handleBillingWebhook(event: Stripe.Event): Promise<void> {
    const supported = event.type.startsWith('customer.subscription.') || event.type.startsWith('invoice.') || event.type.startsWith('checkout.session.') || event.type.startsWith('subscription_schedule.');
    if (!supported) return;
    const object = event.data.object as unknown as { customer?: string; subscription?: string; id: string; metadata?: Record<string, string> };
    const customerId = toId(object.customer);
    if (!customerId) return;
    const existing = await BillingAccount.findOne({ where: { customerId } });
    if (!existing) return; // Legacy customers are intentionally never migrated by webhook.
    await sequelize.transaction(async transaction => {
        const account = await lockAccount(existing.tenantId, transaction);
        const subscriptionId = event.type.startsWith('customer.subscription.') ? object.id : toId(object.subscription);
        if (!account.subscriptionId && subscriptionId) {
            // A delayed event from a cancelled subscription must not hijack reactivation.
            if (account.checkoutSessionId) {
                const checkout = await stripeBilling().checkout.sessions.retrieve(account.checkoutSessionId);
                if (toId(checkout.subscription) !== subscriptionId) return;
            }
            const candidate = await stripeBilling().subscriptions.retrieve(subscriptionId);
            if (candidate.metadata.tenantId !== account.tenantId || toId(candidate.customer) !== account.customerId) return;
            account.subscriptionId = subscriptionId;
        }
        if (!account.subscriptionId) return;
        const sub = await fetchSubscription(account);
        if (sub) await reconcile(account, sub, transaction);
    });
}
