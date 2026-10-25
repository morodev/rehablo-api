import type {Request} from 'express';
import {Op, Transaction, type WhereOptions} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import type {
    ActivityChildPageQuery, ActivityChecklistCreateInput, ActivityChecklistDeleteInput, ActivityChecklistMoveInput,
    ActivityChecklistPatchInput, ActivityChecklistPlacement, ActivityCommentCreateInput,
    ActivityCommentDeleteInput, ActivityCommentPatchInput, ActivityContext
} from '../activities.types.js';
import type {Activity, ActivityBoard, ActivityChecklistItem, ActivityComment} from '../models/index.js';
import {syncChecklistWorkflow, setActivityWorkflow, invalidateActivityReview} from './activityWorkflow.service.js';
import {assertVersion, mutationResponse} from './activityPersistence.service.js';
import {ActivityError} from '../utils/activityErrors.js';
import {parseActivityId, parseActivityChildPageQuery} from '../utils/activityValidation.js';
import {childQueryKey, decodeChildCursor, encodeChildCursor, type ActivityChildKind} from '../utils/activityChildCursor.js';
import {commentCapabilities, serializeChecklist, serializeComments, serializeHistory} from '../utils/activityChildSerialization.js';
import {resolveActivityContext} from './activityAccess.service.js';
import {activityInBoard, assertCapability, currentBoard, models, recordHistory, requireAccess, reviseBoard, writeOperation} from './activityPersistence.service.js';

export async function getActivityChildPage(req: Request, activityId: string, kind: ActivityChildKind) {
    parseActivityId(activityId, 'activityId');
    const query = parseActivityChildPageQuery(req.query);
    return sequelize.transaction({isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ, readOnly: true}, async transaction => {
        const context = await resolveActivityContext(req, transaction); requireAccess(context, 'read');
        const board = await currentBoard(context, transaction);
        const activity = await activityInBoard(context, board.id, activityId, transaction);
        return readActivityChildPage(context, board, activity, kind, query, transaction);
    });
}

export async function readActivityChildPage(context: ActivityContext, board: ActivityBoard, activity: Activity,
    kind: ActivityChildKind, query: ActivityChildPageQuery, transaction: Transaction) {
    const boardRecord = board.get({plain: true});
    const cursor = query.cursor ? decodeChildCursor(query.cursor, context, boardRecord, activity.id, kind) : null;
    const evaluationAt = cursor?.evaluationAt ?? new Date().toISOString();
    const where: WhereOptions = {activityId: activity.id};
    const after: WhereOptions = cursor ? {[Op.or]: [{createdAt: {[Op.lt]: cursor.createdAt}},
        {createdAt: cursor.createdAt, id: {[Op.lt]: cursor.id}}]} : {};
    const scoped = models(context);
    const options = {where: {[Op.and]: [where, after]}, order: [['createdAt', 'DESC'], ['id', 'DESC']] as any,
        limit: query.limit + 1, offset: cursor ? 0 : query.offset, transaction};
    const rows = kind === 'comments' ? await scoped.comment.findAll(options) : await scoped.history.findAll(options);
    const page = rows.slice(0, query.limit);
    const items = kind === 'comments'
        ? await serializeComments(context, activity, page as ActivityComment[], transaction)
        : await serializeHistory(context, page as any, transaction);
    const total = kind === 'comments' ? await scoped.comment.count({where, transaction}) : await scoped.history.count({where, transaction});
    return {items, total, nextCursor: rows.length > query.limit
        ? encodeChildCursor(context, boardRecord, activity.id, kind, evaluationAt, page[page.length - 1]) : null,
        evaluationAt, queryKey: childQueryKey(context, board.id, activity.id, kind), snapshotRevision: board.snapshotRevision};
}

export async function getActivityChecklist(req: Request, activityId: string) {
    parseActivityId(activityId, 'activityId');
    return sequelize.transaction({isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ, readOnly: true}, async transaction => {
        const context = await resolveActivityContext(req, transaction); requireAccess(context, 'read');
        const board = await currentBoard(context, transaction);
        const activity = await activityInBoard(context, board.id, activityId, transaction);
        const data = await checklistResponse(context, board, activity, null, transaction);
        return {items: data.checklist, checklistRevision: data.checklistRevision, snapshotRevision: data.snapshotRevision};
    });
}

function assertChecklistRevision(activity: Activity, expected: number) {
    if (activity.checklistRevision !== expected) throw new ActivityError('CHECKLIST_VERSION_CONFLICT', 409,
        'La checklist è stata modificata da un collega. Ricaricala prima di riprovare.');
}
function assertItemVersion(item: ActivityChecklistItem, expected: number) {
    if (item.version !== expected) throw new ActivityError('CHECKLIST_ITEM_VERSION_CONFLICT', 409,
        'Questo elemento è stato modificato da un collega. Controllalo prima di salvare.');
}
async function itemInActivity(context: ActivityContext, activityId: string, itemId: string, transaction: Transaction) {
    const item = await models(context).checklist.findOne({where: {id: itemId, activityId}, transaction});
    if (!item) throw new ActivityError('ACTIVITY_NOT_FOUND', 404, 'Questo elemento non è più disponibile nella checklist.');
    return item;
}
async function reviseChecklist(activity: Activity, board: ActivityBoard, transaction: Transaction, orderChanged = false) {
    await activity.update({checklistRevision: activity.checklistRevision + 1}, {transaction, silent: true});
    await reviseBoard(board, transaction, orderChanged);
}
async function checklistResponse(context: ActivityContext, board: ActivityBoard, activity: Activity, itemId: string | null, transaction: Transaction) {
    const rows = await models(context).checklist.findAll({where: {activityId: activity.id}, order: [['position', 'ASC'], ['id', 'ASC']], transaction});
    const checklist = await serializeChecklist(context, rows, transaction);
    return {...await mutationResponse(context, board, activity, transaction), activityId: activity.id, item: checklist.find(item => item.id === itemId) ?? null, checklist,
        checklistRevision: activity.checklistRevision, snapshotRevision: board.snapshotRevision};
}
const checklistReceipt = {receipt: (data: Record<string, any>) => ({activityId: data.activityId, itemId: data.item?.id ?? null}),
    replay: async (context: ActivityContext, board: ActivityBoard, receipt: Record<string, any>, transaction: Transaction) => {
        const activity = await activityInBoard(context, board.id, receipt.activityId, transaction);
        return checklistResponse(context, board, activity, receipt.itemId, transaction);
    }};

export async function addChecklistItem(req: Request, activityId: string, input: ActivityChecklistCreateInput) {
    parseActivityId(activityId, 'activityId');
    return writeOperation(req, {...input, activityId}, 'checklist.create', async (context, board, transaction) => {
        const activity = await activityInBoard(context, board.id, activityId, transaction);
        await assertCapability(context, activity, 'canManageChecklist', transaction); assertChecklistRevision(activity, input.expectedChecklistRevision);
        const position = await checklistPosition(context, activityId, input.placement, null, transaction);
        const item = await models(context).checklist.create({activityId, text: input.text, position,
            checked: false, version: 1, createdByUserId: context.userId}, {transaction});
        const orderChanged = await syncChecklistWorkflow(context, board, activity, transaction);
        await reviseChecklist(activity, board, transaction, orderChanged);
        await recordHistory(context, activityId, 'CHECKLIST_ITEM_ADDED', {itemId: item.id}, transaction);
        return checklistResponse(context, board, activity, item.id, transaction);
    }, {...checklistReceipt, status: 201});
}
export async function patchChecklistItem(req: Request, activityId: string, itemId: string, input: ActivityChecklistPatchInput) {
    parseActivityId(activityId, 'activityId'); parseActivityId(itemId, 'itemId');
    return writeOperation(req, {...input, activityId, itemId}, 'checklist.patch', async (context, board, transaction) => {
        const activity = await activityInBoard(context, board.id, activityId, transaction);
        const reopening = activity.status === 'COMPLETED' && input.changes.checked === false && input.allowReopen === true
            && input.changes.text === undefined;
        await assertCapability(context, activity, reopening ? 'canReopenChecklist' : 'canManageChecklist', transaction);
        if (reopening) assertVersion(activity, input.expectedActivityVersion ?? -1);
        const item = await itemInActivity(context, activityId, itemId, transaction); assertItemVersion(item, input.expectedVersion);
        if (reopening && !item.checked) throw new ActivityError('INVALID_TRANSITION', 409, 'Questo passaggio è già aperto. Aggiorna la checklist.');
        const progressChanged = input.changes.checked !== undefined && input.changes.checked !== item.checked;
        let orderChanged = reopening ? await setActivityWorkflow(context, board, activity, 'IN_PROGRESS', 'not_requested', transaction, 'REOPENED') : false;
        if (input.changes.text !== undefined && input.changes.text !== item.text) orderChanged = await invalidateActivityReview(context, board, activity, transaction) || orderChanged;
        const values: Record<string, unknown> = {...input.changes, version: item.version + 1};
        if (input.changes.checked !== undefined && input.changes.checked !== item.checked) {
            values.checkedByUserId = input.changes.checked ? context.userId : null;
            values.checkedAt = input.changes.checked ? new Date() : null;
        }
        await item.update(values, {transaction});
        if (progressChanged) orderChanged = await syncChecklistWorkflow(context, board, activity, transaction, input.changes.checked === false) || orderChanged;
        await reviseChecklist(activity, board, transaction, orderChanged);
        await recordHistory(context, activityId, 'CHECKLIST_ITEM_UPDATED', {itemId, fields: Object.keys(input.changes)}, transaction);
        return checklistResponse(context, board, activity, itemId, transaction);
    }, checklistReceipt);
}
export async function deleteChecklistItem(req: Request, activityId: string, itemId: string, input: ActivityChecklistDeleteInput) {
    parseActivityId(activityId, 'activityId'); parseActivityId(itemId, 'itemId');
    return writeOperation(req, {...input, activityId, itemId}, 'checklist.delete', async (context, board, transaction) => {
        const activity = await activityInBoard(context, board.id, activityId, transaction);
        await assertCapability(context, activity, 'canManageChecklist', transaction); assertChecklistRevision(activity, input.expectedChecklistRevision);
        const item = await itemInActivity(context, activityId, itemId, transaction); assertItemVersion(item, input.expectedVersion);
        await item.destroy({transaction});
        const orderChanged = await syncChecklistWorkflow(context, board, activity, transaction);
        await reviseChecklist(activity, board, transaction, orderChanged);
        await recordHistory(context, activityId, 'CHECKLIST_ITEM_DELETED', {itemId}, transaction);
        return checklistResponse(context, board, activity, null, transaction);
    }, checklistReceipt);
}
export async function moveChecklistItem(req: Request, activityId: string, itemId: string, input: ActivityChecklistMoveInput) {
    parseActivityId(activityId, 'activityId'); parseActivityId(itemId, 'itemId');
    return writeOperation(req, {...input, activityId, itemId}, 'checklist.move', async (context, board, transaction) => {
        const activity = await activityInBoard(context, board.id, activityId, transaction);
        await assertCapability(context, activity, 'canManageChecklist', transaction); assertChecklistRevision(activity, input.expectedChecklistRevision);
        const item = await itemInActivity(context, activityId, itemId, transaction);
        const position = await checklistPosition(context, activityId, input.placement, itemId, transaction);
        // Compaction may have moved this row to a temporary rank while this instance still
        // holds the original value. Force the final UPDATE even when those values coincide.
        await models(context).checklist.update({position}, {where: {id: item.id, activityId}, transaction, silent: true});
        const orderChanged = await invalidateActivityReview(context, board, activity, transaction);
        await reviseChecklist(activity, board, transaction, orderChanged);
        await recordHistory(context, activityId, 'CHECKLIST_ITEM_MOVED', {itemId, placement: input.placement}, transaction);
        return checklistResponse(context, board, activity, itemId, transaction);
    }, checklistReceipt);
}

async function commentInActivity(context: ActivityContext, activityId: string, commentId: string, transaction: Transaction) {
    const comment = await models(context).comment.findOne({where: {id: commentId, activityId}, transaction});
    if (!comment) throw new ActivityError('ACTIVITY_NOT_FOUND', 404, 'Questo commento non è più disponibile.');
    return comment;
}
async function commentResponse(context: ActivityContext, board: ActivityBoard, activity: Activity, commentId: string, transaction: Transaction) {
    const comment = await commentInActivity(context, activity.id, commentId, transaction);
    return {activityId: activity.id, comment: (await serializeComments(context, activity, [comment], transaction))[0], snapshotRevision: board.snapshotRevision};
}
const commentReceipt = {receipt: (data: Record<string, any>) => ({activityId: data.activityId, commentId: data.comment.id}),
    replay: async (context: ActivityContext, board: ActivityBoard, receipt: Record<string, any>, transaction: Transaction) => {
        const activity = await activityInBoard(context, board.id, receipt.activityId, transaction);
        return commentResponse(context, board, activity, receipt.commentId, transaction);
    }};
export async function createActivityComment(req: Request, activityId: string, input: ActivityCommentCreateInput) {
    parseActivityId(activityId, 'activityId');
    return writeOperation(req, {...input, activityId}, 'comment.create', async (context, board, transaction) => {
        const activity = await activityInBoard(context, board.id, activityId, transaction);
        await assertCapability(context, activity, 'canComment', transaction);
        const comment = await models(context).comment.create({activityId, text: input.text, authorUserId: context.userId, version: 1}, {transaction});
        await reviseBoard(board, transaction, false);
        await recordHistory(context, activityId, 'COMMENT_ADDED', {commentId: comment.id}, transaction);
        return commentResponse(context, board, activity, comment.id, transaction);
    }, {...commentReceipt, status: 201});
}
export async function updateActivityComment(req: Request, activityId: string, commentId: string,
    input: ActivityCommentPatchInput | ActivityCommentDeleteInput, remove = false) {
    parseActivityId(activityId, 'activityId'); parseActivityId(commentId, 'commentId');
    return writeOperation(req, {...input, activityId, commentId}, remove ? 'comment.delete' : 'comment.patch', async (context, board, transaction) => {
        const activity = await activityInBoard(context, board.id, activityId, transaction);
        const comment = await commentInActivity(context, activityId, commentId, transaction);
        const capabilities = commentCapabilities(context, activity, comment.authorUserId, comment.deletedAt);
        if (!(remove ? capabilities.canDelete : capabilities.canEdit)) throw new ActivityError('ACTIVITY_FORBIDDEN', 403,
            'Non hai il permesso di modificare questo commento.');
        if (comment.version !== input.expectedVersion) throw new ActivityError('COMMENT_VERSION_CONFLICT', 409,
            'Questo commento è stato modificato da un collega. Controllalo prima di salvare.');
        await comment.update(remove ? {text: null, deletedAt: new Date(), version: comment.version + 1}
            : {text: (input as ActivityCommentPatchInput).text, editedAt: new Date(), version: comment.version + 1}, {transaction});
        await reviseBoard(board, transaction, false);
        await recordHistory(context, activityId, remove ? 'COMMENT_DELETED' : 'COMMENT_EDITED', {commentId}, transaction);
        return commentResponse(context, board, activity, commentId, transaction);
    }, commentReceipt);
}

const gap = 1024n, minimum = -(2n ** 63n), maximum = 2n ** 63n - 1n;
async function checklistPosition(context: ActivityContext, activityId: string, placement: ActivityChecklistPlacement,
    movingId: string | null, transaction: Transaction): Promise<string> {
    const scoped = models(context);
    const rows = await scoped.checklist.findAll({where: {activityId}, order: [['position', 'ASC'], ['id', 'ASC']], transaction});
    const remaining = rows.filter(row => row.id !== movingId);
    const anchorId = placement.kind === 'before' ? placement.itemId : null;
    if (placement.kind === 'before' && !remaining.some(row => row.id === placement.itemId)) {
        throw new ActivityError('CHECKLIST_VERSION_CONFLICT', 409, 'L’elemento di riferimento è cambiato. Ricarica la checklist.');
    }
    const pick = (): bigint | null => {
        if (!remaining.length) return gap;
        if (placement.kind === 'end') {const rank = BigInt(remaining[remaining.length - 1].position) + gap; return rank <= maximum ? rank : null;}
        const index = placement.kind === 'start' ? 0 : remaining.findIndex(row => row.id === anchorId);
        const next = BigInt(remaining[index].position);
        if (!index) return next - gap >= minimum ? next - gap : null;
        const previous = BigInt(remaining[index - 1].position);
        return next - previous > 1n ? previous + (next - previous) / 2n : null;
    };
    let rank = pick(); if (rank !== null) return rank.toString();
    const occupied = new Set(rows.map(row => String(row.position))); let temporary = minimum;
    for (const row of rows) {
        while (occupied.has(temporary.toString())) temporary++;
        const position = temporary.toString(); occupied.add(position);
        await scoped.checklist.update({position}, {where: {id: row.id, activityId}, transaction, silent: true}); temporary++;
    }
    for (let index = 0; index < remaining.length; index++) {
        const position = (BigInt(index + 1) * gap).toString();
        await scoped.checklist.update({position}, {where: {id: remaining[index].id, activityId}, transaction, silent: true});
        remaining[index].set('position', position);
    }
    rank = pick();
    if (rank === null) throw new ActivityError('CHECKLIST_VERSION_CONFLICT', 409, 'Non siamo riusciti a riordinare la checklist. Ricaricala e riprova.');
    return rank.toString();
}
