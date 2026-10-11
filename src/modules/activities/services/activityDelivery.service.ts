import {randomUUID} from 'node:crypto';
import {Op, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {env} from '../../../config/env.js';
import {acquireTenantActivityGate} from '../../../utils/tenantActivityGate.js';
import {getTenantSchemaName} from '../../../utils/tenantSchema.js';
import Tenant from '../../auth/models/tenant.model.js';
import User from '../../auth/models/user.model.js';
import TenantUser from '../../auth/models/tenantUser.model.js';
import StructureUser from '../../auth/models/structureUser.model.js';
import {resolveEffectiveRole} from '../../auth/rbac/roles.js';
import ReminderPushSubscription from '../../notes/models/reminderPushSubscription.model.js';
import {getPushPublicKey} from '../../notes/services/reminderExternalDelivery.service.js';
import {Activity, ActivityAlert, ActivityAssignment, ActivityBoard, ActivityDelivery, ActivityPushTarget, ActivityNotificationActivation} from '../models/index.js';
import ActivityNotificationPreference from '../models/activityNotificationPreference.model.js';
import {isEligibleActivityRole} from './activityAccess.service.js';
import {activitiesDeliveryEnabled, ensureActivityDeliveryActivation} from './activityDeliveryActivation.service.js';
import {materializeActivityDeliveries} from './activityDeliveryPersistence.service.js';
import {activityRetryAt, aggregateActivityPushTargets, classifyActivityDeliveryFailure, consentCoversSchedule} from './activityDelivery.policy.js';
import {ActivityDeliveryAddress, ActivityDeliveryTransport, defaultActivityDeliveryTransport, withActivityProviderTimeout} from './activityDeliveryTransport.service.js';

const BATCH_SIZE = 50, CONCURRENCY = 5, LEASE_MS = 120_000;
const quoteSchema = (schema: string) => {
    if (!/^rehablo_[a-f0-9]{32}$/i.test(schema)) throw new Error('Invalid tenant schema');
    return '"' + schema + '"';
};

/** Discover only missing recipient/channel receipts, so an old alert cannot starve newer ones. */
export async function discoverActivityDeliveries(schema: string, tenantId: string, activatedAt: Date, now: Date) {
    const prefix = quoteSchema(schema) + '.';
    const [rows] = await sequelize.query(`SELECT al."id" FROM ${prefix}"activity_alerts" al
        JOIN ${prefix}"activities" a ON a."id" = al."activityId"
        WHERE al."enabled" = true AND al."scheduledAt" > :activatedAt AND al."scheduledAt" <= :now
        AND a."archivedAt" IS NULL AND a."status" <> 'COMPLETED'
        AND EXISTS (SELECT 1 FROM ${prefix}"activity_assignments" assigned
            CROSS JOIN unnest(ARRAY['inApp']::varchar[] || al."channels") channel
            WHERE assigned."activityId" = a."id" AND assigned."createdAt" <= al."scheduledAt" AND NOT EXISTS (
                SELECT 1 FROM ${prefix}"activity_deliveries" d WHERE d."alertId" = al."id"
                AND d."scheduleVersion" = al."scheduleVersion" AND d."recipientUserId" = assigned."userId" AND d."channel" = channel))
        ORDER BY al."scheduledAt", al."id" LIMIT 50`, {replacements: {activatedAt, now}});
    for (const {id} of rows as Array<{id: string}>) await sequelize.transaction(async transaction => {
        await acquireTenantActivityGate(tenantId, transaction, 'shared');
        const alert = await ActivityAlert.schema(schema).findByPk(id, {transaction});
        const activity = alert && await Activity.schema(schema).findByPk(alert.activityId, {transaction});
        if (!activity || !alert) return;
        await ActivityBoard.schema(schema).findByPk(activity.boardId, {transaction, lock: transaction.LOCK.UPDATE});
        await alert.reload({transaction, lock: transaction.LOCK.UPDATE});
        await activity.reload({transaction});
        if (activity.archivedAt || activity.status === 'COMPLETED') return;
        await materializeActivityDeliveries(schema, alert, transaction);
    });
}

/** Expired provider fences become uncertain. An unstarted lease is safe to claim again. */
export async function claimActivityDeliveryBatch(schema: string, now: Date, limit = BATCH_SIZE) {
    return sequelize.transaction(async transaction => {
        const rows = await ActivityDelivery.schema(schema).findAll({where: {
            scheduledAt: {[Op.lte]: now}, [Op.or]: [
                {status: 'PENDING', nextAttemptAt: {[Op.lte]: now}},
                {status: 'PROCESSING', leaseUntil: {[Op.lte]: now}}
            ]}, order: [['scheduledAt', 'ASC'], ['id', 'ASC']], limit,
            transaction, lock: transaction.LOCK.UPDATE, skipLocked: true});
        const claimed: ActivityDelivery[] = [];
        for (const row of rows) {
            if (row.status === 'PROCESSING' && row.channel === 'email' && row.dispatchStartedAt) {
                await row.update({status: 'UNCERTAIN', leaseToken: null, leaseUntil: null, lastError: 'PROVIDER_RESULT_UNKNOWN'}, {transaction});
                continue;
            }
            if (row.status === 'PROCESSING' && row.channel === 'push') {
                await ActivityPushTarget.schema(schema).update({status: 'UNCERTAIN', lastError: 'PROVIDER_RESULT_UNKNOWN'}, {
                    where: {deliveryId: row.id, status: 'PROCESSING', dispatchStartedAt: {[Op.ne]: null}}, transaction});
                await ActivityPushTarget.schema(schema).update({status: 'PENDING'}, {
                    where: {deliveryId: row.id, status: 'PROCESSING', dispatchStartedAt: null}, transaction});
                const targets = await ActivityPushTarget.schema(schema).findAll({where: {deliveryId: row.id}, transaction});
                const status = targets.length ? aggregateActivityPushTargets(targets.map(target => target.status)) : 'PENDING';
                if (status !== 'PENDING') {
                    await row.update({status, leaseToken: null, leaseUntil: null,
                        lastError: status === 'UNCERTAIN' ? 'PROVIDER_RESULT_UNKNOWN' : row.lastError}, {transaction});
                    continue;
                }
            }
            await row.update({status: 'PROCESSING', leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() + LEASE_MS), dispatchStartedAt: null}, {transaction});
            claimed.push(row);
        }
        return claimed;
    });
}

async function cancelClaimed(schema: string, delivery: ActivityDelivery, transaction: Transaction, code: string) {
    await delivery.update({status: 'CANCELLED', lastError: code, leaseToken: null, leaseUntil: null}, {transaction});
    await ActivityPushTarget.schema(schema).update({status: 'CANCELLED', lastError: code}, {
        where: {deliveryId: delivery.id, status: {[Op.in]: ['PENDING', 'PROCESSING', 'FAILED', 'UNCERTAIN']}}, transaction});
}

/** Gate and board precede delivery/target locks, matching core mutations and team offboarding. */
async function currentRecipient(schema: string, tenantId: string, claim: ActivityDelivery, transaction: Transaction, clock: () => Date) {
    await acquireTenantActivityGate(tenantId, transaction, 'shared');
    const initial = await ActivityAlert.schema(schema).findByPk(claim.alertId, {transaction});
    const activity = initial && await Activity.schema(schema).findByPk(initial.activityId, {transaction});
    const board = activity && await ActivityBoard.schema(schema).findByPk(activity.boardId, {transaction, lock: transaction.LOCK.UPDATE});
    const alert = initial && await ActivityAlert.schema(schema).findByPk(initial.id, {transaction, lock: transaction.LOCK.UPDATE});
    const delivery = await ActivityDelivery.schema(schema).findByPk(claim.id, {transaction, lock: transaction.LOCK.UPDATE});
    const now = clock();
    if (!delivery || delivery.status !== 'PROCESSING' || delivery.leaseToken !== claim.leaseToken
        || !delivery.leaseUntil || delivery.leaseUntil <= now) return null;
    if (activity) await activity.reload({transaction});
    const [assignment, member, structureMember, user, activation] = await Promise.all([
        activity ? ActivityAssignment.schema(schema).findOne({where: {activityId: activity.id, userId: delivery.recipientUserId}, transaction}) : null,
        TenantUser.findOne({where: {tenantId, userId: delivery.recipientUserId, deactivatedAt: null}, transaction}),
        board ? StructureUser.findOne({where: {structureId: board.structureId, userId: delivery.recipientUserId}, transaction}) : null,
        User.findOne({where: {id: delivery.recipientUserId, deactivatedAt: null}, transaction}),
        ActivityNotificationActivation.schema(schema).findByPk('activities', {transaction})
    ]);
    const role = member && structureMember ? resolveEffectiveRole(member.role, structureMember.role) : null;
    if (!board || !activity || !alert || !user || !assignment || !isEligibleActivityRole(role)
        || !activation || delivery.scheduledAt <= activation.activatedAt
        || new Date(assignment.get('createdAt') as Date) > delivery.scheduledAt
        || activity.archivedAt || activity.status === 'COMPLETED' || !alert.enabled
        || alert.scheduleVersion !== delivery.scheduleVersion || alert.scheduledAt?.getTime() !== delivery.scheduledAt.getTime()
        || !alert.channels.includes(delivery.channel)) {
        await cancelClaimed(schema, delivery, transaction, 'RECIPIENT_OR_SCHEDULE_NO_LONGER_CURRENT');
        return null;
    }
    const address: ActivityDeliveryAddress = {tenantId, structureId: board.structureId, activityId: activity.id, deliveryId: delivery.id};
    return {delivery, user, address, now};
}

async function finishEmail(schema: string, claim: ActivityDelivery, now: Date, result: {reference?: string | null; error?: unknown}) {
    const failure = result.error === undefined ? null : classifyActivityDeliveryFailure(result.error);
    const retryAt = failure?.kind === 'retry' ? activityRetryAt(claim.attempts, now) : null;
    await ActivityDelivery.schema(schema).update({
        status: !failure ? 'SENT' : failure.kind === 'uncertain' ? 'UNCERTAIN' : retryAt ? 'PENDING' : 'FAILED',
        nextAttemptAt: retryAt ?? now, lastError: failure?.code ?? null, providerReference: result.reference ?? null,
        sentAt: !failure ? now : null, leaseToken: null, leaseUntil: null,
        ...(!failure || failure.kind !== 'uncertain' ? {dispatchStartedAt: null} : {})
    }, {where: {id: claim.id, status: 'PROCESSING', leaseToken: claim.leaseToken}});
    if (failure) console.warn('[activities-delivery]', {deliveryId: claim.id, channel: 'email', code: failure.code});
}

async function processEmail(schema: string, tenantId: string, claim: ActivityDelivery, clock: () => Date,
    transport: ActivityDeliveryTransport, injected: boolean, providerTimeoutMs: number) {
    const prepared = await sequelize.transaction(async transaction => {
        const current = await currentRecipient(schema, tenantId, claim, transaction, clock);
        if (!current) return null;
        const now = current.now;
        const preference = await ActivityNotificationPreference.findByPk(current.user.id, {transaction, lock: transaction.LOCK.UPDATE});
        if (!consentCoversSchedule(preference?.emailEnabled ?? false, preference?.emailEnabledAt ?? null, claim.scheduledAt)) {
            await cancelClaimed(schema, current.delivery, transaction, 'EMAIL_CONSENT_NOT_AVAILABLE_AT_SCHEDULE');
            return null;
        }
        if (!injected && !env.emailHost) {
            await current.delivery.update({status: 'FAILED', lastError: 'EMAIL_CHANNEL_UNAVAILABLE', leaseToken: null, leaseUntil: null}, {transaction});
            return null;
        }
        const dispatchAt = clock();
        if (!current.delivery.leaseUntil || current.delivery.leaseUntil <= dispatchAt) return null;
        await current.delivery.update({attempts: current.delivery.attempts + 1, dispatchStartedAt: dispatchAt,
            leaseUntil: new Date(dispatchAt.getTime() + LEASE_MS)}, {transaction});
        claim.attempts = current.delivery.attempts;
        return current;
    });
    if (!prepared) return;
    try {
        const reference = await withActivityProviderTimeout(transport.email(prepared.user.email, prepared.address), providerTimeoutMs);
        await finishEmail(schema, claim, clock(), {reference});
    }
    catch (error) {await finishEmail(schema, claim, clock(), {error});}
}

async function preparePushTargets(schema: string, tenantId: string, claim: ActivityDelivery, clock: () => Date, injected: boolean) {
    return sequelize.transaction(async transaction => {
        const current = await currentRecipient(schema, tenantId, claim, transaction, clock);
        if (!current) return [];
        const now = current.now;
        if (!injected && !getPushPublicKey()) {
            await current.delivery.update({status: 'FAILED', lastError: 'PUSH_CHANNEL_UNAVAILABLE', leaseToken: null, leaseUntil: null}, {transaction});
            return [];
        }
        const subscriptions = await ReminderPushSubscription.findAll({where: {
            userId: current.user.id, activitiesEnabled: true, activitiesEnabledAt: {[Op.lte]: claim.scheduledAt}}, transaction});
        for (const subscription of subscriptions) await ActivityPushTarget.schema(schema).findOrCreate({
            where: {deliveryId: claim.id, subscriptionId: subscription.id}, defaults: {
                deliveryId: claim.id, subscriptionId: subscription.id, endpointHash: subscription.endpointHash,
                status: 'PENDING', attempts: 0, nextAttemptAt: claim.scheduledAt}, transaction});
        return ActivityPushTarget.schema(schema).findAll({where: {
            deliveryId: claim.id, status: 'PENDING', nextAttemptAt: {[Op.lte]: now}},
            order: [['id', 'ASC']], limit: BATCH_SIZE, transaction});
    });
}

async function processPushTarget(schema: string, tenantId: string, claim: ActivityDelivery, targetId: string, clock: () => Date,
    transport: ActivityDeliveryTransport, providerTimeoutMs: number) {
    const prepared = await sequelize.transaction(async transaction => {
        const current = await currentRecipient(schema, tenantId, claim, transaction, clock);
        if (!current) return null;
        const now = current.now;
        const target = await ActivityPushTarget.schema(schema).findByPk(targetId, {transaction, lock: transaction.LOCK.UPDATE});
        if (!target || target.status !== 'PENDING' || target.nextAttemptAt > now) return null;
        const subscription = await ReminderPushSubscription.findByPk(target.subscriptionId, {transaction, lock: transaction.LOCK.UPDATE});
        if (!subscription || subscription.userId !== current.user.id || subscription.endpointHash !== target.endpointHash
            || !consentCoversSchedule(subscription.activitiesEnabled, subscription.activitiesEnabledAt, claim.scheduledAt)) {
            await target.update({status: 'CANCELLED', lastError: 'DEVICE_CONSENT_NO_LONGER_CURRENT'}, {transaction});
            return null;
        }
        const dispatchAt = clock();
        if (!current.delivery.leaseUntil || current.delivery.leaseUntil <= dispatchAt) return null;
        await target.update({status: 'PROCESSING', attempts: target.attempts + 1, dispatchStartedAt: dispatchAt}, {transaction});
        await current.delivery.update({dispatchStartedAt: dispatchAt, leaseUntil: new Date(dispatchAt.getTime() + LEASE_MS)}, {transaction});
        return {...current, target, subscription};
    });
    if (!prepared) return;
    let reference: string | null = null, failure: ReturnType<typeof classifyActivityDeliveryFailure> | null = null;
    try {reference = await withActivityProviderTimeout(transport.push(prepared.subscription, prepared.address), providerTimeoutMs);}
    catch (error) {failure = classifyActivityDeliveryFailure(error);}
    const finishedAt = clock();
    await sequelize.transaction(async transaction => {
        const now = finishedAt;
        const parent = await ActivityDelivery.schema(schema).findOne({where: {id: claim.id, status: 'PROCESSING', leaseToken: claim.leaseToken},
            transaction, lock: transaction.LOCK.UPDATE});
        if (!parent) return; // Cancellation, a newer lease or offboarding wins over a late provider answer.
        const retryAt = failure?.kind === 'retry' ? activityRetryAt(prepared.target.attempts, now) : null;
        await ActivityPushTarget.schema(schema).update({
            status: !failure ? 'SENT' : failure.kind === 'uncertain' ? 'UNCERTAIN' : failure.kind === 'gone' ? 'CANCELLED' : retryAt ? 'PENDING' : 'FAILED',
            nextAttemptAt: retryAt ?? now, lastError: failure?.code ?? null, providerReference: reference, sentAt: !failure ? now : null,
            ...(!failure || failure.kind !== 'uncertain' ? {dispatchStartedAt: null} : {})
        }, {where: {id: prepared.target.id, status: 'PROCESSING'}, transaction});
        await parent.update({dispatchStartedAt: null}, {transaction});
        if (failure?.kind === 'gone') await ReminderPushSubscription.destroy({where: {
            id: prepared.subscription.id, userId: prepared.user.id, endpointHash: prepared.target.endpointHash}, transaction});
    });
    if (failure) console.warn('[activities-delivery]', {deliveryId: claim.id, targetId, channel: 'push', code: failure.code});
}

async function finishPush(schema: string, claim: ActivityDelivery, now: Date) {
    await sequelize.transaction(async transaction => {
        const parent = await ActivityDelivery.schema(schema).findOne({where: {id: claim.id, status: 'PROCESSING', leaseToken: claim.leaseToken},
            transaction, lock: transaction.LOCK.UPDATE});
        if (!parent) return;
        const targets = await ActivityPushTarget.schema(schema).findAll({where: {deliveryId: claim.id}, transaction});
        const status = aggregateActivityPushTargets(targets.map(target => target.status));
        const nextAttemptAt = targets.filter(target => target.status === 'PENDING').map(target => target.nextAttemptAt)
            .sort((left, right) => left.getTime() - right.getTime())[0] ?? now;
        await parent.update({status, nextAttemptAt, attempts: Math.max(0, ...targets.map(target => target.attempts)),
            sentAt: status === 'SENT' ? now : null, leaseToken: null, leaseUntil: null, dispatchStartedAt: null,
            lastError: status === 'UNCERTAIN' ? 'PROVIDER_RESULT_UNKNOWN' : status === 'FAILED' ? 'DEVICE_DELIVERY_FAILED' : null}, {transaction});
    });
}

async function processDelivery(schema: string, tenantId: string, claim: ActivityDelivery, clock: () => Date,
    transport: ActivityDeliveryTransport, injected: boolean, providerTimeoutMs: number) {
    if (claim.channel === 'inApp') {
        await sequelize.transaction(async transaction => {
            const current = await currentRecipient(schema, tenantId, claim, transaction, clock);
            const now = current?.now ?? clock();
            if (current) await current.delivery.update({status: 'SENT', sentAt: now, attempts: current.delivery.attempts + 1,
                leaseUntil: null, leaseToken: null, lastError: null}, {transaction});
        });
    } else if (claim.channel === 'email') await processEmail(schema, tenantId, claim, clock, transport, injected, providerTimeoutMs);
    else {
        const targets = await preparePushTargets(schema, tenantId, claim, clock, injected);
        for (const target of targets) await processPushTarget(schema, tenantId, claim, target.id, clock, transport, providerTimeoutMs);
        await finishPush(schema, claim, clock());
    }
}

export interface ActivityDeliverySweepOptions {
    now?: Date; clock?: () => Date; tenantIds?: string[]; transport?: ActivityDeliveryTransport; force?: boolean; providerTimeoutMs?: number;
}
export async function sweepActivityDeliveries(options: ActivityDeliverySweepOptions = {}) {
    if (!options.force && !activitiesDeliveryEnabled()) return;
    const clock = options.clock ?? (options.now ? () => options.now! : () => new Date());
    const transport = options.transport ?? defaultActivityDeliveryTransport();
    const tenants = await Tenant.findAll({where: options.tenantIds ? {id: options.tenantIds} : {}, attributes: ['id']});
    for (const tenant of tenants) {
        const schema = getTenantSchemaName(tenant.id);
        try {
            const now = clock();
            const activatedAt = await ensureActivityDeliveryActivation(schema, undefined, {force: options.force, now});
            if (!activatedAt) continue;
            await discoverActivityDeliveries(schema, tenant.id, activatedAt, now);
            // Claim five immediately before work, avoiding 50 leases ageing while queued behind a provider.
            for (let handled = 0; handled < BATCH_SIZE; handled += CONCURRENCY) {
                const claimed = await claimActivityDeliveryBatch(schema, clock(), Math.min(CONCURRENCY, BATCH_SIZE - handled));
                if (!claimed.length) break;
                const results = await Promise.allSettled(claimed.map(row => processDelivery(schema, tenant.id, row, clock,
                    transport, !!options.transport, options.providerTimeoutMs ?? 20_000)));
                for (let index = 0; index < results.length; index++) if (results[index].status === 'rejected') {
                    const error = (results[index] as PromiseRejectedResult).reason;
                    console.warn('[activities-delivery]', {tenantId: tenant.id, deliveryId: claimed[index].id,
                        code: error?.original?.code ?? error?.code ?? 'PROCESSING_INTERRUPTED'});
                }
            }
        } catch (error) {
            console.warn('[activities-delivery]', {tenantId: tenant.id, code: (error as any)?.original?.code ?? 'SWEEP_FAILED'});
        }
    }
}

let sweepRunning = false;
export async function startActivityDeliverySweep(): Promise<void> {
    if (!activitiesDeliveryEnabled()) return;
    const tenants = await Tenant.findAll({attributes: ['id']});
    // Activation must exist before HTTP accepts an alert, including TENANT_SCHEMA_SYNC=off deployments.
    for (const tenant of tenants) await ensureActivityDeliveryActivation(getTenantSchemaName(tenant.id));
    const run = async () => {
        if (sweepRunning) return;
        sweepRunning = true;
        try {await sweepActivityDeliveries();} finally {sweepRunning = false;}
    };
    void run();
    setInterval(() => void run(), 60_000).unref();
}
