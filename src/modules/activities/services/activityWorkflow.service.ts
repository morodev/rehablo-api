import type {Request} from 'express';
import type {Transaction} from 'sequelize';
import type {ActivityContext, ActivityReviewInput, ActivityReviewStatus, ActivityStatus} from '../activities.types.js';
import type {Activity, ActivityBoard} from '../models/index.js';
import {ActivityError} from '../utils/activityErrors.js';
import {parseActivityId} from '../utils/activityValidation.js';
import {assignableActivityUsers} from './activityAccess.service.js';
import {cancelActivityDeliveries} from './activityDeliveryPersistence.service.js';
import {activityInBoard, assertCapability, assertOrder, assertVersion, assignmentIds, models, mutationResponse,
    placementPosition, recordHistory, reviseBoard, writeOperation} from './activityPersistence.service.js';

export async function validateActivityReviewer(context: ActivityContext, reviewerId: string | null,
    assignees: readonly string[], transaction: Transaction, allowInactive = false): Promise<void> {
    if (!reviewerId) return;
    if (assignees.includes(reviewerId)) throw new ActivityError('INVALID_REVIEWER', 422,
        'Il revisore deve essere diverso dagli assegnatari.', {reviewerUserId: 'Scegli un operatore che non svolge questa attività.'});
    if (!allowInactive && !(await assignableActivityUsers(context, transaction)).some(user => user.id === reviewerId)) {
        throw new ActivityError('INVALID_REVIEWER', 422, 'Il revisore non è più disponibile in questa sede. Sostituiscilo prima di continuare.',
            {reviewerUserId: 'Seleziona un revisore attivo della sede.'});
    }
}

/** The caller holds the board lock and increments board revisions once for the whole command. */
export async function setActivityWorkflow(context: ActivityContext, board: ActivityBoard, activity: Activity,
    status: ActivityStatus, reviewStatus: ActivityReviewStatus, transaction: Transaction,
    eventType = 'STATUS_CHANGED'): Promise<boolean> {
    const from = activity.status;
    if (from === status && activity.reviewStatus === reviewStatus) return false;
    const statusChanged = from !== status;
    const newlyApproved = reviewStatus === 'approved' && activity.reviewStatus !== 'approved';
    const position = statusChanged ? await placementPosition(context, board.id, status, {kind: 'end'}, activity.id, transaction) : activity.position;
    activity.set('position', position); activity.changed('position', true);
    await activity.update({status, position, reviewStatus, version: activity.version + 1, updatedByUserId: context.userId,
        reviewApprovedByUserId: reviewStatus === 'approved' ? newlyApproved ? context.userId : activity.reviewApprovedByUserId : null,
        reviewApprovedAt: reviewStatus === 'approved' ? newlyApproved ? new Date() : activity.reviewApprovedAt : null,
        ...(status === 'COMPLETED' && from !== 'COMPLETED' ? {completedAt: new Date(), completedByUserId: context.userId} : {}),
        ...(from === 'COMPLETED' && status !== 'COMPLETED' ? {completedAt: null, completedByUserId: null} : {})}, {transaction});
    if (status === 'COMPLETED' && from !== 'COMPLETED') {
        const alert = await models(context).alert.findOne({where: {activityId: activity.id}, transaction});
        if (alert?.enabled) {
            await alert.update({enabled: false, scheduleVersion: alert.scheduleVersion + 1}, {transaction});
            await cancelActivityDeliveries(context.schema, alert.id, transaction);
            await recordHistory(context, activity.id, 'ALERT_CANCELLED', {}, transaction);
        }
    }
    await recordHistory(context, activity.id, status === 'COMPLETED' ? 'COMPLETED' : eventType,
        {from, to: status, reviewStatus}, transaction);
    return statusChanged;
}

export async function invalidateActivityReview(context: ActivityContext, board: ActivityBoard, activity: Activity,
    transaction: Transaction): Promise<boolean> {
    if (activity.reviewStatus !== 'approved' && activity.reviewStatus !== 'pending') return false;
    return setActivityWorkflow(context, board, activity, 'IN_PROGRESS',
        'not_requested', transaction, 'REVIEW_INVALIDATED');
}

/** Called only after changes to progress or checklist composition, never from reads or text edits. */
export async function syncChecklistWorkflow(context: ActivityContext, board: ActivityBoard, activity: Activity,
    transaction: Transaction, forceInProgress = false): Promise<boolean> {
    const items = await models(context).checklist.findAll({where: {activityId: activity.id}, attributes: ['checked'], transaction});
    const checked = items.filter(item => item.checked).length;
    if (items.length && checked === items.length) {
        return setActivityWorkflow(context, board, activity, activity.reviewerUserId ? 'WAITING' : 'COMPLETED',
            activity.reviewerUserId ? 'pending' : 'not_requested', transaction,
            activity.reviewerUserId ? 'REVIEW_REQUESTED' : 'COMPLETED');
    }
    if (forceInProgress || checked > 0 || activity.reviewStatus !== 'not_requested' || activity.status === 'COMPLETED') {
        return setActivityWorkflow(context, board, activity, 'IN_PROGRESS', 'not_requested', transaction);
    }
    return false;
}

export async function requireCompletionPermission(context: ActivityContext, activity: Activity, transaction: Transaction) {
    await assertCapability(context, activity, 'canComplete', transaction);
    if (activity.reviewerUserId) await validateActivityReviewer(context, activity.reviewerUserId,
        await assignmentIds(context, activity.id, transaction), transaction);
}

export async function reviewActivity(req: Request, activityId: string, input: ActivityReviewInput) {
    parseActivityId(activityId, 'activityId');
    return writeOperation(req, {...input, activityId}, 'review.' + input.action, async (context, board, transaction) => {
        const activity = await activityInBoard(context, board.id, activityId, transaction);
        await assertCapability(context, activity, input.action === 'request' ? 'canRequestReview' : 'canReview', transaction);
        assertVersion(activity, input.expectedVersion); assertOrder(board, input.expectedOrderRevision);
        if (activity.checklistRevision !== input.expectedChecklistRevision) throw new ActivityError('CHECKLIST_VERSION_CONFLICT', 409,
            'La checklist è cambiata. Controllala prima di continuare.');
        if (!activity.reviewerUserId) throw new ActivityError('REVIEW_REQUIRED', 409, 'Seleziona un revisore prima di inviare l’attività.');
        await validateActivityReviewer(context, activity.reviewerUserId, await assignmentIds(context, activity.id, transaction), transaction);
        if (input.action !== 'returnToProgress' && await models(context).checklist.count({where: {activityId, checked: false}, transaction})) {
            throw new ActivityError('CHECKLIST_INCOMPLETE', 409, 'Completa tutti i passaggi prima di inviare o approvare la revisione.');
        }
        let status: ActivityStatus = 'WAITING', reviewStatus: ActivityReviewStatus = 'pending';
        let event = 'REVIEW_REQUESTED';
        if (input.action === 'approveAndComplete' || input.action === 'authorizeCompletion') {
            reviewStatus = 'approved'; event = 'REVIEW_APPROVED';
            if (input.action === 'approveAndComplete') status = 'COMPLETED';
        } else if (input.action === 'returnToProgress') {
            status = 'IN_PROGRESS'; reviewStatus = 'not_requested'; event = 'REVIEW_RETURNED';
            await models(context).comment.create({activityId, authorUserId: context.userId, text: input.comment!, version: 1}, {transaction});
            await recordHistory(context, activityId, 'COMMENT_ADDED', {reason: 'REVIEW_RETURNED'}, transaction);
        }
        const orderChanged = await setActivityWorkflow(context, board, activity, status, reviewStatus, transaction, event);
        await reviseBoard(board, transaction, orderChanged);
        return mutationResponse(context, board, activity, transaction);
    });
}
