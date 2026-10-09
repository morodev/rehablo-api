import {createHash} from 'node:crypto';
import {Request, Response} from 'express';
import {getUserId} from '../../../middleware/rbac.js';
import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendErrorResponse, sendSuccessResponse} from '../../../utils/response.js';
import {isPubliclyShareableUrl} from '../../../utils/publicUrl.js';
import ReminderNotificationPreference from '../models/reminderNotificationPreference.model.js';
import ReminderPushSubscription from '../models/reminderPushSubscription.model.js';
import {getPushPublicKey} from '../services/reminderExternalDelivery.service.js';

function staffUserId(req: Request, res: Response): string | null {
    if (!req.user || req.user.actor === 'patient') {
        sendErrorResponse(res, 403, 'Questa operazione è riservata allo staff');
        return null;
    }
    return getUserId(req);
}

function endpointHash(endpoint: string): string {
    return createHash('sha256').update(endpoint).digest('hex');
}

function validPushEndpoint(endpoint: unknown): endpoint is string {
    if (typeof endpoint !== 'string' || endpoint.length > 4096 || !isPubliclyShareableUrl(endpoint)) return false;
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port;
}

export const getPreferences = asyncHandler(async (req: Request, res: Response) => {
    const userId = staffUserId(req, res);
    if (!userId) return;
    const preference = await ReminderNotificationPreference.findByPk(userId);
    return sendSuccessResponse(res, 200, {
        emailFallbackEnabled: preference?.emailFallbackEnabled ?? true,
        pushPublicKey: getPushPublicKey()
    }, 'Preferenze caricate');
});

export const updatePreferences = asyncHandler(async (req: Request, res: Response) => {
    const userId = staffUserId(req, res);
    if (!userId) return;
    if (typeof req.body?.emailFallbackEnabled !== 'boolean') {
        return sendErrorResponse(res, 400, 'Valore email non valido');
    }
    const [preference] = await ReminderNotificationPreference.findOrCreate({
        where: {userId},
        defaults: {userId, emailFallbackEnabled: req.body.emailFallbackEnabled}
    });
    if (preference.emailFallbackEnabled !== req.body.emailFallbackEnabled) {
        await preference.update({emailFallbackEnabled: req.body.emailFallbackEnabled});
    }
    return sendSuccessResponse(res, 200, {
        emailFallbackEnabled: preference.emailFallbackEnabled,
        pushPublicKey: getPushPublicKey()
    }, 'Preferenze salvate');
});

export const registerPushSubscription = asyncHandler(async (req: Request, res: Response) => {
    const userId = staffUserId(req, res);
    if (!userId) return;
    if (!getPushPublicKey()) return sendErrorResponse(res, 503, 'Notifiche push non configurate');
    const {endpoint, keys} = req.body ?? {};
    if (!validPushEndpoint(endpoint)
        || typeof keys?.p256dh !== 'string' || !keys.p256dh || keys.p256dh.length > 512
        || typeof keys?.auth !== 'string' || !keys.auth || keys.auth.length > 512) {
        return sendErrorResponse(res, 400, 'Sottoscrizione push non valida');
    }
    const hash = endpointHash(endpoint);
    const [subscription] = await ReminderPushSubscription.findOrCreate({
        where: {endpointHash: hash},
        defaults: {userId, endpointHash: hash, endpoint, p256dh: keys.p256dh, auth: keys.auth}
    });
    await subscription.update({userId, endpoint, p256dh: keys.p256dh, auth: keys.auth});
    return sendSuccessResponse(res, 200, {subscribed: true}, 'Notifiche push attivate');
});

export const removePushSubscription = asyncHandler(async (req: Request, res: Response) => {
    const userId = staffUserId(req, res);
    if (!userId) return;
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== 'string' || !endpoint) {
        return sendErrorResponse(res, 400, 'Endpoint non valido');
    }
    await ReminderPushSubscription.destroy({where: {userId, endpointHash: endpointHash(endpoint)}});
    return sendSuccessResponse(res, 200, {subscribed: false}, 'Notifiche push disattivate');
});
