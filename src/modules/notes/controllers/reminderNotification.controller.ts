import {Request, Response} from 'express';
import {getUserId} from '../../../middleware/rbac.js';
import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendErrorResponse, sendSuccessResponse} from '../../../utils/response.js';
import ReminderNotificationPreference from '../models/reminderNotificationPreference.model.js';
import {getPushPublicKey} from '../services/reminderExternalDelivery.service.js';
import {registerSharedPushSubscription, removeSharedPushSubscription} from '../../activities/services/activityNotificationPreferences.service.js';
import {ActivityError, sendActivityError} from '../../activities/utils/activityErrors.js';

function staffUserId(req: Request, res: Response): string | null {
    if (!req.user || req.user.actor === 'patient') {
        sendErrorResponse(res, 403, 'Questa operazione è riservata allo staff');
        return null;
    }
    return getUserId(req);
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
    try {return sendSuccessResponse(res, 200, await registerSharedPushSubscription(req, 'reminders'), 'Notifiche push attivate');}
    catch (error) {if (error instanceof ActivityError) return sendActivityError(res, error); throw error;}
});

export const removePushSubscription = asyncHandler(async (req: Request, res: Response) => {
    try {
        const result = await removeSharedPushSubscription(req, 'reminders');
        return sendSuccessResponse(res, 200, {...result, subscribed: false}, 'Notifiche push disattivate');
    } catch (error) {if (error instanceof ActivityError) return sendActivityError(res, error); throw error;}
});
