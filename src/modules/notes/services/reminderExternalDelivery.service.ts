import {Op, Transaction} from 'sequelize';
import webpush from 'web-push';
import {sequelize} from '../../../config/database.js';
import {env} from '../../../config/env.js';
import {frontendEmailLink, transporter} from '../../../services/email.service.js';
import {getTenantSchemaName} from '../../../utils/tenantSchema.js';
import Tenant from '../../auth/models/tenant.model.js';
import TenantUser from '../../auth/models/tenantUser.model.js';
import StructureUser from '../../auth/models/structureUser.model.js';
import User from '../../auth/models/user.model.js';
import {resolveEffectiveRole, RoleCode} from '../../auth/rbac/roles.js';
import Reminder from '../models/reminder.model.js';
import ReminderAlertState from '../models/reminderAlertState.model.js';
import ReminderAssignment from '../models/reminderAssignment.model.js';
import ReminderExternalDelivery from '../models/reminderExternalDelivery.model.js';
import ReminderNotificationActivation from '../models/reminderNotificationActivation.model.js';
import ReminderNotificationPreference from '../models/reminderNotificationPreference.model.js';
import ReminderPushSubscription from '../models/reminderPushSubscription.model.js';
import {baseReminderAlert, deliveryStillCurrent, dueExternalAlert} from './reminderExternalDelivery.policy.js';

const SWEEP_INTERVAL_MS = 60_000;
const BATCH_SIZE = 20;
const PUSH_PUBLIC_KEY = process.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim() ?? '';
const PUSH_PRIVATE_KEY = process.env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim() ?? '';
const PUSH_READY = !!PUSH_PUBLIC_KEY && !!PUSH_PRIVATE_KEY;
let vapidConfigured = false;

export function getPushPublicKey(): string | null {
    return PUSH_READY ? PUSH_PUBLIC_KEY : null;
}

async function ensureActivation(): Promise<Date> {
    const [activation] = await ReminderNotificationActivation.findOrCreate({
        where: {key: 'reminders'},
        defaults: {key: 'reminders', activatedAt: new Date()}
    });
    return activation.activatedAt;
}

export async function enqueueSnoozedExternalAlert(
    schema: string, reminder: Reminder, userId: string, snoozedUntil: Date, transaction?: Transaction
): Promise<void> {
    const baseScheduledFor = baseReminderAlert(reminder);
    if (!baseScheduledFor) return;
    await ReminderExternalDelivery.schema(schema).findOrCreate({
        where: {reminderId: reminder.id, userId, scheduledFor: snoozedUntil},
        defaults: {reminderId: reminder.id, userId, scheduledFor: snoozedUntil, baseScheduledFor,
            status: 'PENDING', attempts: 0, nextAttemptAt: snoozedUntil},
        transaction
    });
}

async function discoverDueDeliveries(schema: string, activatedAt: Date, now: Date): Promise<void> {
    const reminders = await Reminder.schema(schema).findAll({
        where: {
            status: {[Op.in]: ['OPEN', 'SNOOZED']},
            [Op.or]: [
                {remindAt: {[Op.between]: [activatedAt, now]}},
                {remindAt: null, dueAt: {[Op.between]: [activatedAt, now]}}
            ]
        },
        attributes: ['id', 'dueAt', 'remindAt', 'status']
    });
    for (const reminder of reminders) {
        const baseScheduledFor = baseReminderAlert(reminder);
        if (!baseScheduledFor) continue;
        const assignments = await ReminderAssignment.schema(schema).findAll({
            where: {reminderId: reminder.id}, attributes: ['userId']
        });
        for (const assignment of assignments) {
            const state = await ReminderAlertState.schema(schema).findOne({
                where: {reminderId: reminder.id, userId: assignment.userId}
            });
            const scheduledFor = dueExternalAlert(reminder, state?.snoozedUntil ?? null, activatedAt, now);
            if (!scheduledFor) continue;
            await ReminderExternalDelivery.schema(schema).findOrCreate({
                where: {reminderId: reminder.id, userId: assignment.userId, scheduledFor},
                defaults: {reminderId: reminder.id, userId: assignment.userId, scheduledFor, baseScheduledFor,
                    status: 'PENDING', attempts: 0, nextAttemptAt: scheduledFor}
            });
        }
    }
}

async function claimDueBatch(schema: string, now: Date): Promise<ReminderExternalDelivery[]> {
    return sequelize.transaction(async transaction => {
        const rows = await ReminderExternalDelivery.schema(schema).findAll({
            where: {
                [Op.or]: [
                    {status: 'PENDING', nextAttemptAt: {[Op.lte]: now}},
                    {status: 'PROCESSING', leaseUntil: {[Op.lte]: now}}
                ]
            },
            order: [['scheduledFor', 'ASC']],
            limit: BATCH_SIZE,
            lock: transaction.LOCK.UPDATE,
            skipLocked: true,
            transaction
        });
        const leaseUntil = new Date(now.getTime() + 2 * 60_000);
        for (const row of rows) {
            await row.update({status: 'PROCESSING', leaseUntil}, {transaction});
        }
        return rows;
    });
}

async function sendPush(userId: string, payload: string): Promise<boolean> {
    if (!PUSH_READY) return false;
    const subscriptions = await ReminderPushSubscription.findAll({where: {userId}});
    if (!subscriptions.length) return false;
    if (!vapidConfigured) {
        try {
            webpush.setVapidDetails(`mailto:${env.emailFrom}`, PUSH_PUBLIC_KEY, PUSH_PRIVATE_KEY);
            vapidConfigured = true;
        } catch (error) {
            console.error('[reminders] configurazione push non valida', error);
            return false;
        }
    }
    let accepted = false;
    for (const subscription of subscriptions) {
        try {
            await webpush.sendNotification({
                endpoint: subscription.endpoint,
                keys: {p256dh: subscription.p256dh, auth: subscription.auth}
            }, payload, {TTL: 3600, urgency: 'normal'});
            accepted = true;
        } catch (error) {
            const status = (error as {statusCode?: number})?.statusCode;
            if (status === 404 || status === 410) {
                await subscription.destroy();
            } else {
                console.error('[reminders] invio push fallito', error);
            }
        }
    }
    return accepted;
}

async function sendFallbackEmail(user: User): Promise<void> {
    const link = frontendEmailLink('apps/notes-reminders?view=reminder');
    await transporter.sendMail({
        from: {name: 'Promemoria Rehablo', address: env.emailFrom},
        to: user.email,
        subject: 'Hai un promemoria su Rehablo',
        text: `Hai un promemoria da controllare su Rehablo. Apri ${link}`,
        html: `<p>Hai un promemoria da controllare su Rehablo.</p><p><a href="${link}">Apri i promemoria</a></p>`
    });
}

async function processDelivery(schema: string, tenantId: string, delivery: ReminderExternalDelivery): Promise<void> {
    try {
        const reminder = await Reminder.schema(schema).findByPk(delivery.reminderId);
        const assigned = await ReminderAssignment.schema(schema).findOne({
            where: {reminderId: delivery.reminderId, userId: delivery.userId}
        });
        const state = await ReminderAlertState.schema(schema).findOne({
            where: {reminderId: delivery.reminderId, userId: delivery.userId}
        });
        const member = await TenantUser.findOne({where: {tenantId, userId: delivery.userId, deactivatedAt: null}});
        const structureMember = reminder?.structureId && await StructureUser.findOne({
            where: {structureId: reminder.structureId, userId: delivery.userId}
        });
        const user = await User.findOne({where: {id: delivery.userId, isActive: true, deactivatedAt: null}});
        const role = member && structureMember ? resolveEffectiveRole(member.role, structureMember.role) : null;
        if (!reminder || !assigned || !member || !structureMember || !user
            || !role || role === RoleCode.PATIENT
            || !deliveryStillCurrent(reminder, delivery.baseScheduledFor, state?.snoozedUntil ?? null, new Date())) {
            await delivery.update({status: 'SKIPPED', leaseUntil: null});
            return;
        }

        const payload = JSON.stringify({title: 'Promemoria Rehablo', body: 'Hai un promemoria da controllare.',
            url: '/#/apps/notes-reminders?view=reminder', tag: `rehablo-reminder-${reminder.id}`});
        if (await sendPush(delivery.userId, payload)) {
            await delivery.update({status: 'SENT', deliveredVia: 'PUSH', leaseUntil: null, lastError: null});
            return;
        }
        const preference = await ReminderNotificationPreference.findByPk(delivery.userId);
        if (preference?.emailFallbackEnabled === false) {
            await delivery.update({status: 'SKIPPED', leaseUntil: null});
            return;
        }
        await sendFallbackEmail(user);
        await delivery.update({status: 'SENT', deliveredVia: 'EMAIL', leaseUntil: null, lastError: null});
    } catch (error) {
        const attempts = delivery.attempts + 1;
        const lastError = `${error instanceof Error ? error.message : error}`.slice(0, 255);
        console.error('[reminders] invio esterno fallito', {tenantId, reminderId: delivery.reminderId, attempts, error});
        await delivery.update({
            status: attempts >= 5 ? 'SKIPPED' : 'PENDING', attempts, lastError, leaseUntil: null,
            nextAttemptAt: new Date(Date.now() + Math.min(2 ** (attempts - 1), 16) * 60_000)
        });
    }
}

export async function sweepReminderExternalDeliveries(activatedAt: Date, now = new Date()): Promise<void> {
    const tenants = await Tenant.findAll({attributes: ['id']});
    for (const tenant of tenants) {
        const schema = getTenantSchemaName(tenant.id);
        try {
            await discoverDueDeliveries(schema, activatedAt, now);
            const claimed = await claimDueBatch(schema, now);
            for (let index = 0; index < claimed.length; index += 5) {
                await Promise.all(claimed.slice(index, index + 5)
                    .map(delivery => processDelivery(schema, tenant.id, delivery)));
            }
        } catch (error) {
            console.error(`[reminders] scansione avvisi fallita per ${schema}`, error);
        }
    }
}

export async function startReminderExternalDeliverySweep(): Promise<NodeJS.Timeout> {
    const activatedAt = await ensureActivation();
    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try {
            await sweepReminderExternalDeliveries(activatedAt);
        } catch (error) {
            console.error('[reminders] scansione avvisi fallita', error);
        } finally {
            running = false;
        }
    };
    void run();
    const timer = setInterval(() => void run(), SWEEP_INTERVAL_MS);
    timer.unref();
    return timer;
}
