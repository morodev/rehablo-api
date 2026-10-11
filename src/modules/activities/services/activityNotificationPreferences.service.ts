import {createHash} from 'node:crypto';
import type {Request} from 'express';
import {Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {env} from '../../../config/env.js';
import {getUserId} from '../../../middleware/rbac.js';
import {isPubliclyShareableUrl} from '../../../utils/publicUrl.js';
import User from '../../auth/models/user.model.js';
import TenantUser from '../../auth/models/tenantUser.model.js';
import ReminderPushSubscription from '../../notes/models/reminderPushSubscription.model.js';
import {getPushPublicKey} from '../../notes/services/reminderExternalDelivery.service.js';
import ActivityNotificationPreference from '../models/activityNotificationPreference.model.js';
import {ActivityError} from '../utils/activityErrors.js';

export type NotificationDomain = 'reminders' | 'activities';
const hash = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex');

async function staffUserId(req: Request, transaction?: Transaction): Promise<string> {
    if (!req.user || req.user.actor === 'patient') throw new ActivityError('ACTIVITY_FORBIDDEN', 403, 'Questa operazione è riservata al team.');
    const userId = getUserId(req);
    const user = await User.findOne({where: {id: userId, deactivatedAt: null}, attributes: ['id'], transaction});
    const memberships = await TenantUser.findAll({where: {userId, deactivatedAt: null}, attributes: ['role'], transaction});
    if (!user || !memberships.some(row => row.role !== 'PATIENT'))
        throw new ActivityError('ACTIVITY_FORBIDDEN', 403, 'Il tuo accesso al team non è più disponibile. Accedi nuovamente.');
    return userId;
}

async function logoutUserId(req: Request, transaction: Transaction): Promise<string> {
    if (!req.user) throw new ActivityError('ACTIVITY_CONTEXT_REQUIRED', 401, 'Accedi prima di gestire il dispositivo.');
    const userId = getUserId(req);
    if (!await User.findByPk(userId, {attributes: ['id'], transaction}))
        throw new ActivityError('ACTIVITY_CONTEXT_REQUIRED', 401, 'Accedi nuovamente prima di gestire il dispositivo.');
    return userId;
}

function validEndpoint(endpoint: unknown): endpoint is string {
    if (typeof endpoint !== 'string' || endpoint.length > 4096 || !isPubliclyShareableUrl(endpoint)) return false;
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port;
}
function domain(value: unknown): NotificationDomain {
    if (value !== 'reminders' && value !== 'activities')
        throw new ActivityError('ACTIVITY_VALIDATION_FAILED', 422, 'Scegli quali notifiche vuoi gestire: promemoria o attività.');
    return value;
}
function prefs(row: ActivityNotificationPreference | null) {
    return {emailEnabled: row?.emailEnabled ?? false, emailEnabledAt: row?.emailEnabledAt?.toISOString() ?? null,
        pushAvailable: !!getPushPublicKey(), emailAvailable: !!env.emailHost, pushPublicKey: getPushPublicKey()};
}
export async function getActivityNotificationPreferences(req: Request) {
    const userId = await staffUserId(req);
    return prefs(await ActivityNotificationPreference.findByPk(userId));
}
export async function updateActivityNotificationPreferences(req: Request) {
    if (!req.body || typeof req.body.emailEnabled !== 'boolean' || Object.keys(req.body).some(key => key !== 'emailEnabled'))
        throw new ActivityError('ACTIVITY_VALIDATION_FAILED', 422, 'Indica se vuoi ricevere gli avvisi delle attività via email.');
    return sequelize.transaction(async transaction => {
        const userId = await staffUserId(req, transaction);
        // Serializes creation as well as updates; absent preference rows cannot be row-locked.
        await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:userId), hashtext(:operation))', {
            transaction, replacements: {userId, operation: 'activity-email-preference'}});
        const [row] = await ActivityNotificationPreference.findOrCreate({where: {userId}, defaults: {userId, emailEnabled: false}, transaction});
        if (row.emailEnabled !== req.body.emailEnabled) await row.update({emailEnabled: req.body.emailEnabled,
            emailEnabledAt: req.body.emailEnabled ? new Date() : null}, {transaction});
        return prefs(row);
    });
}
function subscriptionStatus(row: ReminderPushSubscription | null) {
    return {subscribed: !!row, remindersEnabled: row?.remindersEnabled ?? false,
        activitiesEnabled: row?.activitiesEnabled ?? false, pushPublicKey: getPushPublicKey()};
}
export async function getSharedPushSubscriptionStatus(req: Request) {
    const userId = await staffUserId(req);
    if (!validEndpoint(req.body?.endpoint)) throw new ActivityError('ACTIVITY_VALIDATION_FAILED', 422, 'Il dispositivo non ha una sottoscrizione push valida.');
    return subscriptionStatus(await ReminderPushSubscription.findOne({where: {userId, endpointHash: hash(req.body.endpoint)}}));
}
export async function registerSharedPushSubscription(req: Request, legacyDomain?: NotificationDomain) {
    if (!getPushPublicKey()) throw new ActivityError('ACTIVITY_CHANNEL_UNAVAILABLE', 503, 'Le notifiche push non sono ancora configurate. Puoi usare gli avvisi in app.');
    const selected = domain(legacyDomain ?? req.body?.domain);
    // Shared UI wraps the browser payload; the reminder alias keeps its historical flat body.
    const {endpoint, keys} = req.body?.subscription ?? req.body ?? {};
    if (!validEndpoint(endpoint) || typeof keys?.p256dh !== 'string' || !keys.p256dh || keys.p256dh.length > 512
        || typeof keys?.auth !== 'string' || !keys.auth || keys.auth.length > 512)
        throw new ActivityError('ACTIVITY_VALIDATION_FAILED', 422, 'Il dispositivo non ha una sottoscrizione push valida. Riattiva le notifiche dal browser.');
    return sequelize.transaction(async transaction => {
        const userId = await staffUserId(req, transaction), endpointHash = hash(endpoint);
        await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:endpointHash), hashtext(:operation))', {
            transaction, replacements: {endpointHash, operation: 'shared-push-subscription'}});
        const [row] = await ReminderPushSubscription.findOrCreate({where: {endpointHash}, defaults: {
            userId, endpointHash, endpoint, p256dh: keys.p256dh, auth: keys.auth,
            remindersEnabled: false, activitiesEnabled: false, activitiesEnabledAt: null}, transaction});
        const transferred = row.userId !== userId;
        const remindersEnabled = transferred ? false : row.remindersEnabled;
        const activitiesEnabled = transferred ? false : row.activitiesEnabled;
        const enabledAt = transferred ? null : row.activitiesEnabledAt;
        await row.update({userId, endpoint, p256dh: keys.p256dh, auth: keys.auth,
            remindersEnabled: selected === 'reminders' ? true : remindersEnabled,
            activitiesEnabled: selected === 'activities' ? true : activitiesEnabled,
            activitiesEnabledAt: selected === 'activities' && !activitiesEnabled ? new Date() : enabledAt}, {transaction});
        return subscriptionStatus(row);
    });
}
export async function removeSharedPushSubscription(req: Request, legacyDomain?: NotificationDomain) {
    const selected = legacyDomain ?? (req.body?.domain === undefined ? null : domain(req.body.domain));
    const endpoint = req.body?.endpoint;
    if (!validEndpoint(endpoint)) throw new ActivityError('ACTIVITY_VALIDATION_FAILED', 422, 'Il dispositivo non ha una sottoscrizione push valida.');
    return sequelize.transaction(async transaction => {
        // Logout removes the identity's own endpoint even after changing to a patient profile.
        const userId = selected ? await staffUserId(req, transaction) : await logoutUserId(req, transaction);
        const endpointHash = hash(endpoint);
        await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:endpointHash), hashtext(:operation))', {
            transaction, replacements: {endpointHash, operation: 'shared-push-subscription'}});
        const row = await ReminderPushSubscription.findOne({where: {userId, endpointHash}, transaction, lock: transaction.LOCK.UPDATE});
        if (!row) return {retained: false, remindersEnabled: false, activitiesEnabled: false};
        if (!selected) {await row.destroy({transaction}); return {retained: false, remindersEnabled: false, activitiesEnabled: false};}
        await row.update(selected === 'reminders' ? {remindersEnabled: false} : {activitiesEnabled: false, activitiesEnabledAt: null}, {transaction});
        const result = {retained: row.remindersEnabled || row.activitiesEnabled,
            remindersEnabled: row.remindersEnabled, activitiesEnabled: row.activitiesEnabled};
        if (!result.retained) await row.destroy({transaction});
        return result;
    });
}
