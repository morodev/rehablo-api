import {randomUUID} from 'node:crypto';
import {Request, Response, Router} from 'express';
import {requireAuth} from '../../../middleware/auth.js';
import {sendErrorResponse, sendSuccessResponse} from '../../../utils/response.js';
import {ActivityError, sendActivityError} from '../utils/activityErrors.js';
import {getActivityNotificationPreferences, updateActivityNotificationPreferences, getSharedPushSubscriptionStatus,
    registerSharedPushSubscription, removeSharedPushSubscription} from '../services/activityNotificationPreferences.service.js';

const router = Router();
function handle(callback: (req: Request) => Promise<unknown>) {
    return (req: Request, res: Response) => {
        const requestId = randomUUID();
        Promise.resolve(callback(req)).then(data => sendSuccessResponse(res, 200, data)).catch(error => {
            if (error instanceof ActivityError) return sendActivityError(res, error, requestId);
            console.error('[activity-notifications]', {requestId, name: error?.name, code: error?.original?.code ?? error?.code});
            return sendErrorResponse(res, 500, 'Non siamo riusciti ad aggiornare le notifiche. Riprova tra poco.', {requestId});
        });
    };
}
router.get('/activities/notification-preferences', requireAuth, handle(getActivityNotificationPreferences));
router.patch('/activities/notification-preferences', requireAuth, handle(updateActivityNotificationPreferences));
router.post('/notifications/push-subscriptions/status', requireAuth, handle(getSharedPushSubscriptionStatus));
router.post('/notifications/push-subscriptions', requireAuth, handle(req => registerSharedPushSubscription(req)));
router.delete('/notifications/push-subscriptions', requireAuth, handle(req => removeSharedPushSubscription(req)));
export default router;
