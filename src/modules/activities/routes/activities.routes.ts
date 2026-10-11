import {randomUUID} from 'node:crypto';
import {Request, Response, Router} from 'express';
import {requireAuth} from '../../../middleware/auth.js';
import {sendErrorResponse, sendSuccessResponse} from '../../../utils/response.js';
import {ActivityError, sendActivityError} from '../utils/activityErrors.js';
import {
    parseActivityQuery, parseArchiveActivityInput, parseCreateActivityInput,
    parseMoveActivityInput, parsePatchActivityInput, parseRestoreActivityInput,
    parseChecklistCreateInput, parseChecklistPatchInput, parseChecklistDeleteInput, parseChecklistMoveInput,
    parseCommentCreateInput, parseCommentPatchInput, parseCommentDeleteInput, parseActivitySummaryQuery, parseActivityLinksQuery
} from '../utils/activityValidation.js';
import {
    archiveActivity, createActivity, getActivity, getActivityAgendaEvents, getActivityAssignees, getActivityBoard,
    getActivityHistory, getActivityPatients, moveActivity, patchActivity
} from '../services/activities.service.js';
import {queryActivities} from '../services/activityQuery.service.js';
import {queryActivitySummary, queryActivityLinks} from '../services/activityIntegration.service.js';
import {getActivityAlerts, readActivityAlert} from '../services/activityAlerts.service.js';
import {
    addChecklistItem, patchChecklistItem, deleteChecklistItem, moveChecklistItem,
    createActivityComment, updateActivityComment, getActivityChildPage, getActivityChecklist
} from '../services/activityCollaboration.service.js';

const router = Router();
// Current memberships and permissions are checked again inside every service transaction.
// Tenant schemas are prepared by startup/registration, never by feature request handlers.
router.use('/activities', requireAuth);

type Handler = (req: Request, res: Response) => Promise<unknown>;
function handle(handler: Handler) {
    return (req: Request, res: Response) => {
        const requestId = randomUUID();
        res.setHeader('X-Request-Id', requestId);
        Promise.resolve(handler(req, res)).catch(error => {
            if (error instanceof ActivityError) return sendActivityError(res, error, requestId);
            console.error('[activities]', {requestId, name: error?.name, code: error?.original?.code ?? error?.code});
            return sendErrorResponse(res, 500, 'Non siamo riusciti a completare l’operazione. Riprova; le modifiche sono ancora qui.',
                {code: 'ACTIVITY_INTERNAL_ERROR', requestId});
        });
    };
}

router.get('/activities/summary', handle(async (req, res) => sendSuccessResponse(res, 200, await queryActivitySummary(req, parseActivitySummaryQuery(req.query)))));
router.get('/activities/links', handle(async (req, res) => sendSuccessResponse(res, 200, await queryActivityLinks(req, parseActivityLinksQuery(req.query)))));
router.get('/activities/alerts', handle(async (req, res) => sendSuccessResponse(res, 200, await getActivityAlerts(req))));
router.post('/activities/alerts/:deliveryId/read', handle(async (req, res) => {
    const result = await readActivityAlert(req, req.params.deliveryId);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return sendSuccessResponse(res, result.status, result.data, 'Avviso segnato come letto.');
}));
router.get('/activities/board', handle(async (req, res) => sendSuccessResponse(res, 200, await getActivityBoard(req))));
router.get('/activities/assignees', handle(async (req, res) => sendSuccessResponse(res, 200, await getActivityAssignees(req))));
router.get('/activities/agenda-events', handle(async (req, res) => sendSuccessResponse(res, 200, await getActivityAgendaEvents(req))));
router.get('/activities/patients', handle(async (req, res) => sendSuccessResponse(res, 200, await getActivityPatients(req))));
router.get('/activities', handle(async (req, res) => sendSuccessResponse(res, 200, await queryActivities(req, parseActivityQuery(req.query)))));
router.post('/activities', handle(async (req, res) => {
    const input = parseCreateActivityInput(req.body, {defaultAssigneeIds: [req.user!.sub ?? req.user!.id]});
    const result = await createActivity(req, input);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return sendSuccessResponse(res, result.status, result.data, 'Attività creata.');
}));

router.get('/activities/:activityId/history', handle(async (req, res) =>
    sendSuccessResponse(res, 200, await getActivityHistory(req, req.params.activityId))));
router.get('/activities/:activityId/comments', handle(async (req, res) =>
    sendSuccessResponse(res, 200, await getActivityChildPage(req, req.params.activityId, 'comments'))));
router.get('/activities/:activityId/checklist', handle(async (req, res) =>
    sendSuccessResponse(res, 200, await getActivityChecklist(req, req.params.activityId))));
router.post('/activities/:activityId/checklist', handle(async (req, res) =>
    sendChildMutation(res, await addChecklistItem(req, req.params.activityId, parseChecklistCreateInput(req.body)))));
router.patch('/activities/:activityId/checklist/:itemId', handle(async (req, res) =>
    sendChildMutation(res, await patchChecklistItem(req, req.params.activityId, req.params.itemId, parseChecklistPatchInput(req.body)))));
router.delete('/activities/:activityId/checklist/:itemId', handle(async (req, res) =>
    sendChildMutation(res, await deleteChecklistItem(req, req.params.activityId, req.params.itemId, parseChecklistDeleteInput(req.body)))));
router.post('/activities/:activityId/checklist/:itemId/move', handle(async (req, res) =>
    sendChildMutation(res, await moveChecklistItem(req, req.params.activityId, req.params.itemId, parseChecklistMoveInput(req.body)))));
router.post('/activities/:activityId/comments', handle(async (req, res) =>
    sendChildMutation(res, await createActivityComment(req, req.params.activityId, parseCommentCreateInput(req.body)))));
router.patch('/activities/:activityId/comments/:commentId', handle(async (req, res) =>
    sendChildMutation(res, await updateActivityComment(req, req.params.activityId, req.params.commentId, parseCommentPatchInput(req.body)))));
router.delete('/activities/:activityId/comments/:commentId', handle(async (req, res) =>
    sendChildMutation(res, await updateActivityComment(req, req.params.activityId, req.params.commentId, parseCommentDeleteInput(req.body), true))));
router.post('/activities/:activityId/move', handle(async (req, res) => {
    const result = await moveActivity(req, req.params.activityId, parseMoveActivityInput(req.body));
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return sendSuccessResponse(res, result.status, result.data, 'Attività aggiornata.');
}));
router.post('/activities/:activityId/archive', handle(async (req, res) => {
    const result = await archiveActivity(req, req.params.activityId, parseArchiveActivityInput(req.body));
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return sendSuccessResponse(res, result.status, result.data, 'Attività archiviata.');
}));
router.post('/activities/:activityId/restore', handle(async (req, res) => {
    const result = await archiveActivity(req, req.params.activityId, parseRestoreActivityInput(req.body), true);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return sendSuccessResponse(res, result.status, result.data, 'Attività ripristinata.');
}));

router.put('/activities/:activityId/alert', handle(async (req, res) => {
    alertBody(req.body, true);
    const input = parsePatchActivityInput({operationId: req.body.operationId, expectedVersion: req.body.expectedVersion,
        changes: {alert: req.body.alert}});
    const result = await patchActivity(req, req.params.activityId, input, 'alert.configure');
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return sendSuccessResponse(res, result.status, result.data, 'Avviso programmato.');
}));
router.delete('/activities/:activityId/alert', handle(async (req, res) => {
    alertBody(req.body, false);
    const input = parsePatchActivityInput({operationId: req.body.operationId, expectedVersion: req.body.expectedVersion, changes: {alert: null}});
    const result = await patchActivity(req, req.params.activityId, input, 'alert.disable');
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return sendSuccessResponse(res, result.status, result.data, 'Avviso disattivato.');
}));

router.get('/activities/:activityId', handle(async (req, res) => sendSuccessResponse(res, 200, await getActivity(req, req.params.activityId))));
router.patch('/activities/:activityId', handle(async (req, res) => {
    const result = await patchActivity(req, req.params.activityId, parsePatchActivityInput(req.body));
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return sendSuccessResponse(res, result.status, result.data, 'Modifiche salvate.');
}));

function sendChildMutation(res: Response, result: {status: number; replayed: boolean; data: Record<string, unknown>}) {
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return sendSuccessResponse(res, result.status, result.data, 'Modifiche salvate.');
}

function alertBody(value: unknown, enabled: boolean): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ActivityError('INVALID_ALERT', 422, 'Controlla i dati dell’avviso.');
    const permitted = enabled ? ['operationId', 'expectedVersion', 'alert'] : ['operationId', 'expectedVersion'];
    if (Object.keys(value).some(key => !permitted.includes(key)) || (enabled && !(value as Record<string, unknown>).alert)) {
        throw new ActivityError('INVALID_ALERT', 422, 'Controlla i dati dell’avviso.', {alert: 'Indica la data e l’ora dell’avviso.'});
    }
}

export default router;
