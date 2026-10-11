import {Op, Transaction} from 'sequelize';
import {ActivityAlert, ActivityAssignment, ActivityDelivery, ActivityNotificationActivation, ActivityPushTarget} from '../models/index.js';

const OPEN_STATES = ['PENDING', 'PROCESSING', 'FAILED', 'UNCERTAIN'];
/** The caller holds the board lock. In-flight answers will no longer match this lease. */
export async function cancelActivityDeliveries(schema: string, alertId: string, transaction: Transaction,
    recipients?: {keep?: readonly string[]; remove?: readonly string[]}) {
    const where = {alertId, status: {[Op.in]: OPEN_STATES},
        ...(recipients?.keep ? {recipientUserId: {[Op.notIn]: [...recipients.keep]}} : {}),
        ...(recipients?.remove ? {recipientUserId: {[Op.in]: [...recipients.remove]}} : {})};
    const rows = await ActivityDelivery.schema(schema).findAll({where, attributes: ['id'], transaction});
    if (!rows.length) return;
    await ActivityDelivery.schema(schema).update({status: 'CANCELLED', leaseUntil: null, leaseToken: null, lastError: 'SCHEDULE_NO_LONGER_CURRENT'}, {where, transaction});
    await ActivityPushTarget.schema(schema).update({status: 'CANCELLED', lastError: 'SCHEDULE_NO_LONGER_CURRENT'}, {
        where: {deliveryId: {[Op.in]: rows.map(row => row.id)}, status: {[Op.in]: OPEN_STATES}}, transaction});
}

/** Materialized atomically with alert/assignment changes; no provider calls occur here. */
export async function materializeActivityDeliveries(schema: string, alert: ActivityAlert, transaction: Transaction,
    options: {reactivateRecipients?: boolean; now?: Date} = {}): Promise<void> {
    if (!alert.enabled || !alert.scheduledAt) return;
    const activation = await ActivityNotificationActivation.schema(schema).findByPk('activities', {transaction});
    if (!activation || alert.scheduledAt.getTime() <= activation.activatedAt.getTime()) return;
    const assignments = await ActivityAssignment.schema(schema).findAll({where: {
        activityId: alert.activityId, createdAt: {[Op.lte]: alert.scheduledAt}}, transaction});
    const channels = [...new Set(['inApp', ...alert.channels])];
    for (const assigned of assignments) for (const channel of channels) {
        const [delivery] = await ActivityDelivery.schema(schema).findOrCreate({
            where: {alertId: alert.id, recipientUserId: assigned.userId, scheduleVersion: alert.scheduleVersion, channel},
            defaults: {alertId: alert.id, recipientUserId: assigned.userId, scheduleVersion: alert.scheduleVersion,
                channel, scheduledAt: alert.scheduledAt, nextAttemptAt: alert.scheduledAt, status: 'PENDING', attempts: 0}, transaction});
        // An explicitly restored recipient can receive a future alert; delivered receipts remain immutable.
        if (options.reactivateRecipients && delivery.status === 'CANCELLED' && alert.scheduledAt > (options.now ?? new Date()))
            await delivery.update({status: 'PENDING', attempts: 0, dispatchStartedAt: null, lastError: null,
                leaseToken: null, leaseUntil: null, nextAttemptAt: alert.scheduledAt}, {transaction});
    }
}

export function activityAlertDeliveryState(alert: {enabled: boolean; scheduledAt: Date | string | null; scheduleVersion: number},
    deliveries: readonly {scheduleVersion: number; status: string}[], activatedAt: Date | null, now = new Date()) {
    const rows = deliveries.filter(row => row.scheduleVersion === alert.scheduleVersion);
    if (rows.some(row => row.status === 'UNCERTAIN')) return 'uncertain' as const;
    if (rows.some(row => row.status === 'FAILED')) return 'failed' as const;
    if (rows.some(row => row.status === 'PENDING' || row.status === 'PROCESSING'))
        return alert.scheduledAt && new Date(alert.scheduledAt) > now ? 'scheduled' as const : 'pending' as const;
    if (rows.some(row => row.status === 'SENT')) return 'sent' as const;
    if (alert.enabled && alert.scheduledAt && activatedAt && new Date(alert.scheduledAt) <= activatedAt)
        return 'reprogramRequired' as const;
    return 'scheduled' as const;
}
