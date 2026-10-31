import {createHash} from 'node:crypto';
import {Request} from 'express';
import {Op, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {getCurrentTenantId} from '../../../middleware/auth.js';
import {acquireTenantActivityGate} from '../../../utils/tenantActivityGate.js';
import {resolveGrantedScope} from '../../auth/rbac/permissions.js';
import User from '../../auth/models/user.model.js';
import {
    Activity, ActivityAlert, ActivityAssignment, ActivityBoard, ActivityChecklistItem,
    ActivityComment, ActivityHistory, ActivityOperation, ActivityDelivery, ActivityNotificationActivation, ActivityExecution
} from '../models/index.js';
import {ActivityContext, ActivityRecord, ActivityStatus, ActivityUserSummary} from '../activities.types.js';
import {ActivityError} from '../utils/activityErrors.js';
import {serializeActivity, serializeBoard} from '../utils/activitySerialization.js';
import {prepareExecutionContext, executionActivity, targetsPastExecution} from './activityExecutionTarget.service.js';
import {captureCurrentExecution, projectExecution} from './activityRecurrence.service.js';
import {activityAlertDeliveryState} from './activityDeliveryPersistence.service.js';
import {activityCapabilities, assignableActivityUsers, resolveActivityContext, visibleActivityLinksForRecords} from './activityAccess.service.js';

export function models(context: ActivityContext) {
    const schema = context.schema;
    return {
        board: ActivityBoard.schema(schema), activity: Activity.schema(schema),
        assignment: ActivityAssignment.schema(schema), checklist: ActivityChecklistItem.schema(schema),
        comment: ActivityComment.schema(schema), history: ActivityHistory.schema(schema),
        execution: ActivityExecution.schema(schema), alert: ActivityAlert.schema(schema), operation: ActivityOperation.schema(schema)
    };
}

export function requireAccess(context: ActivityContext, action: 'read' | 'create' | 'update') {
    if (resolveGrantedScope(context.permissions, 'activity', action) === null) {
        throw new ActivityError('ACTIVITY_FORBIDDEN', 403, 'Non hai il permesso per eseguire questa operazione.');
    }
}

export async function currentBoard(context: ActivityContext, transaction: Transaction, lock = false) {
    let board: ActivityBoard | null;
    try {
        board = await models(context).board.findOne({
            where: {structureId: context.structureId}, transaction,
            ...(lock ? {lock: transaction.LOCK.UPDATE} : {})
        });
    } catch (error) {
        const code = (error as {original?: {code?: string}})?.original?.code;
        if (code === '42P01' || code === '42703') {
            throw new ActivityError('ACTIVITY_BOARD_UNAVAILABLE', 503,
                'Le attività richiedono un aggiornamento dello studio. Contatta l’amministratore per renderle disponibili.');
        }
        throw error;
    }
    if (!board) throw new ActivityError('ACTIVITY_BOARD_UNAVAILABLE', 503,
        'La bacheca di questa sede non è ancora disponibile. Riprova tra poco.');
    if (board.get('timezone') !== context.timezone) throw new ActivityError('ACTIVITY_BOARD_UNAVAILABLE', 503,
        'La programmazione della bacheca richiede un aggiornamento.');
    return board;
}

export async function activityInBoard(context: ActivityContext, boardId: string, activityId: string, transaction: Transaction) {
    if (context.parentActivity?.id === activityId) return context.historicalExecution ? executionActivity(context) : context.parentActivity;
    const activity = await models(context).activity.findOne({where: {id: activityId, boardId}, transaction});
    if (activity?.recurrence) {
        context.parentActivity = activity; context.executionId = activity.currentExecutionId;
        if (activity.currentExecutionId) context.execution = await models(context).execution.findByPk(activity.currentExecutionId, {transaction}) ?? undefined;
    }
    if (!activity) throw new ActivityError('ACTIVITY_NOT_FOUND', 404,
        'Questa attività non è più disponibile nella sede selezionata.');
    return activity;
}

export async function assignmentIds(context: ActivityContext, activityId: string, transaction: Transaction): Promise<string[]> {
    if (context.historicalExecution && context.parentActivity?.id === activityId && context.execution) return [...context.execution.assigneeIds];
    const rows = await models(context).assignment.findAll({where: {activityId}, transaction, raw: true});
    return rows.map(row => row.userId);
}

export function assertVersion(activity: Activity, expected: number) {
    if (activity.get('version') !== expected) throw new ActivityError('ACTIVITY_VERSION_CONFLICT', 409,
        'Questa attività è stata modificata da un collega. Controlla gli aggiornamenti prima di salvare.');
}

export function assertOrder(board: ActivityBoard, expected: number, context?: ActivityContext) {
    if (context && targetsPastExecution(context)) return;
    if (board.get('orderRevision') !== expected) throw new ActivityError('ORDER_CONFLICT', 409,
        'La bacheca è cambiata. Aggiornala e ripeti lo spostamento.');
}

export async function assertCapability(context: ActivityContext, activity: Activity, capability: string, transaction: Transaction) {
    const ids = await assignmentIds(context, activity.id, transaction);
    const capabilities = activityCapabilities(context, activity.get({plain: true}) as ActivityRecord, ids);
    if (!capabilities[capability as keyof typeof capabilities]) throw new ActivityError('ACTIVITY_FORBIDDEN', 403,
        'Non hai più il permesso per eseguire questa operazione.');
}

export async function reviseBoard(board: ActivityBoard, transaction: Transaction, orderChanged: boolean, context?: ActivityContext) {
    if (context && targetsPastExecution(context)) orderChanged = false;
    await board.update({
        snapshotRevision: board.get('snapshotRevision') + 1,
        orderRevision: board.get('orderRevision') + (orderChanged ? 1 : 0)
    }, {transaction});
}

export async function recordHistory(context: ActivityContext, activityId: string, eventType: string, data: unknown, transaction: Transaction) {
    const executionId = context.parentActivity?.id === activityId ? context.executionId ?? null : null;
    if (executionId && context.execution?.closedAt) await context.execution.update({lateUpdatedAt: new Date(), lateUpdatedByUserId: context.userId}, {transaction});
    await models(context).history.create({activityId, executionId, actorUserId: context.userId, eventType, data}, {transaction});
}

export function operationInputHash(value: unknown): string {
    return createHash('sha256').update(stableJson(value)).digest('hex');
}

export async function getOperationReceipt(context: ActivityContext, boardId: string, operationId: string,
    command: string, inputHash: string, transaction: Transaction) {
    const operation = await models(context).operation.findOne({where: {boardId, actorUserId: context.userId, operationId}, transaction});
    if (operation && (operation.command !== command || operation.inputHash !== inputHash)) {
        throw new ActivityError('OPERATION_ID_REUSED', 409,
            'Non siamo riusciti a verificare questa operazione. Aggiorna l’attività prima di riprovare.');
    }
    return operation;
}

export async function writeOperationReceipt(context: ActivityContext, boardId: string, operationId: string,
    command: string, inputHash: string, status: number, responseBody: object, transaction: Transaction): Promise<void> {
    await models(context).operation.create({boardId, actorUserId: context.userId, operationId,
        command, inputHash, responseStatus: status, responseBody,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000)}, {transaction});
}

export interface ActivityOperationOptions {
    status?: number;
    receipt?: (data: Record<string, any>) => Record<string, unknown>;
    replay?: (context: ActivityContext, board: ActivityBoard, receipt: Record<string, any>, transaction: Transaction) => Promise<Record<string, any>>;
}

/** Acquire the tenant gate before row locks; receipts and compaction share the board lock. */
export async function writeOperation<T extends {operationId: string}>(
    req: Request, input: T, command: string,
    apply: (context: ActivityContext, board: ActivityBoard, transaction: Transaction) => Promise<Record<string, unknown>>,
    options: ActivityOperationOptions = {}
) {
    return sequelize.transaction(async transaction => {
        let tenantId: string;
        try {tenantId = getCurrentTenantId(req);}
        catch {throw new ActivityError('ACTIVITY_CONTEXT_REQUIRED', 403, 'Seleziona uno studio e una sede prima di aprire le attività.');}
        if (typeof tenantId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(tenantId)) {
            throw new ActivityError('ACTIVITY_CONTEXT_REQUIRED', 403, 'Seleziona uno studio e una sede prima di aprire le attività.');
        }
        await acquireTenantActivityGate(tenantId.toLowerCase(), transaction, 'shared');
        const initialContext = await resolveActivityContext(req, transaction);
        requireAccess(initialContext, 'read');
        const board = await currentBoard(initialContext, transaction, true);
        // The lock can wait behind another command: refresh membership after acquiring it.
        const context = await resolveActivityContext(req, transaction);
        requireAccess(context, 'read');
        const requestedExecutionId = req.params.executionId;
        const activityId = (input as any).activityId ?? req.params.activityId;
        const inputHash = operationInputHash(requestedExecutionId ? {...input, executionId: requestedExecutionId} : input);
        const operation = await getOperationReceipt(context, board.id, input.operationId, command, inputHash, transaction);
        if (operation) {
            // A replay never changes data. Refresh its capabilities using the current membership.
            const response = structuredClone(operation.get('responseBody')) as Record<string, any>;
            const replayExecutionId = response.executionId ?? response.activity?.currentExecutionId;
            const replayActivityId = activityId ?? response.activityId ?? response.activity?.id;
            if (replayActivityId) await prepareExecutionContext(context, board, replayActivityId, transaction, {executionId: replayExecutionId, replay: true});
            if (options.replay) return {status: operation.responseStatus as number,
                data: await options.replay(context, board, response, transaction), replayed: true};
            if (response.activity?.id) {
                const current = await activityInBoard(context, board.id, response.activity.id, transaction);
                response.activity = (await serializeActivities(context, [current], transaction))[0];
                response.orderRevision = board.get('orderRevision');
                response.snapshotRevision = board.get('snapshotRevision');
            }
            return {status: operation.get('responseStatus') as number, data: response, replayed: true};
        }
        if (activityId) await prepareExecutionContext(context, board, activityId, transaction, {
            executionId: requestedExecutionId, expectedExecutionId: (input as any).expectedExecutionId, write: true,
            management: command === 'archive' || command === 'restore' || !!(input as any).changes?.recurrence
        });
        const data = await apply(context, board, transaction);
        if (context.parentActivity?.recurrence) {
            const routineManagement = !!(input as any).changes?.recurrence || command === 'restore'
                || (command === 'archive' && (input as any).scope !== 'execution');
            if (!routineManagement) {
                if (context.historicalExecution && context.execution) await projectExecution(context, board, context.parentActivity, context.execution, transaction);
                else await captureCurrentExecution(context, context.parentActivity, transaction);
            }
            data.executionId = context.executionId ?? null;
        }
        const status = options.status ?? (command === 'create' ? 201 : 200);
        await writeOperationReceipt(context, board.id, input.operationId, command, inputHash, status,
            options.receipt ? options.receipt(data) : data, transaction);
        return {status, data, replayed: false};
    });
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.entries(value)
        .filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => JSON.stringify(key) + ':' + stableJson(item)).join(',') + '}';
    return JSON.stringify(value);
}

export async function mutationResponse(context: ActivityContext, board: ActivityBoard, activity: Activity, transaction: Transaction) {
    return {
        activity: (await serializeActivities(context, [activity], transaction))[0],
        ...(context.parentActivity?.recurrence ? {executionId: context.executionId ?? null} : {}),
        orderRevision: board.get('orderRevision'), snapshotRevision: board.get('snapshotRevision')
    };
}

/** Batch children and people once per window; never issue one query per card. */
export async function serializeActivities(context: ActivityContext, activities: Activity[], transaction: Transaction, evaluationAt = new Date()) {
    if (!activities.length) return [];
    const ids = activities.map(activity => activity.id);
    const scoped = models(context);
    const childScope = {[Op.or]: activities.map(activity => ({activityId: activity.id, executionId: activity.currentExecutionId ?? null}))};
    const [assignments, alerts, checklist, comments, eligible, links] = await Promise.all([
        scoped.assignment.findAll({where: {activityId: {[Op.in]: ids}}, transaction, raw: true}),
        scoped.alert.findAll({where: {activityId: {[Op.in]: ids}}, transaction, raw: true}),
        scoped.checklist.findAll({where: childScope, attributes: ['activityId', 'executionId', 'checked'], transaction, raw: true}),
        scoped.comment.findAll({where: {...childScope, deletedAt: null}, attributes: ['activityId', 'executionId'], transaction, raw: true, paranoid: false}),
        assignableActivityUsers(context, transaction),
        visibleActivityLinksForRecords(context, activities.map(activity => activity.get({plain: true}) as ActivityRecord), transaction)
    ]);
    const templateRecords = activities.filter(row => row.recurrence).map(row => ({...row.get({plain: true}), ...row.recurrence!.template} as ActivityRecord));
    const templateLinks = templateRecords.length ? await visibleActivityLinksForRecords(context, templateRecords, transaction) : new Map();
    const executionIds = activities.map(activity => activity.currentExecutionId).filter(Boolean) as string[];
    const executionRows = executionIds.length ? await scoped.execution.findAll({where: {id: {[Op.in]: executionIds}}, transaction}) : [];
    const [deliveries, activation] = alerts.length ? await Promise.all([
        ActivityDelivery.schema(context.schema).findAll({where: {alertId: {[Op.in]: alerts.map(row => row.id)}},
            attributes: ['alertId', 'scheduleVersion', 'status'], transaction, raw: true}),
        ActivityNotificationActivation.schema(context.schema).findByPk('activities', {transaction})
    ]) : [[], null];
    const peopleIds = [...new Set([
        ...assignments.map(row => row.userId),
        ...executionRows.flatMap(row => row.assigneeIds),
        ...activities.flatMap(row => row.recurrence ? [...row.recurrence.template.assigneeIds,
            ...(row.recurrence.template.reviewerUserId ? [row.recurrence.template.reviewerUserId] : [])] : []),
        ...activities.flatMap(row => [row.createdByUserId, row.updatedByUserId, row.reviewerUserId].filter(Boolean) as string[])
    ])];
    const people = peopleIds.length ? await User.findAll({
        where: {id: {[Op.in]: peopleIds}}, attributes: ['id', 'name', 'surname'], transaction, raw: true
    }) : [];
    const available = new Map(eligible.map(user => [user.id, user]));
    const summaries = new Map<string, ActivityUserSummary>(people.map(user => [user.id, {
        id: user.id, name: user.name ?? null, surname: user.surname ?? null,
        eligible: available.has(user.id), role: available.get(user.id)?.role ?? null
    }]));
    return activities.map(activity => {
        const execution = executionRows.find(row => row.id === activity.currentExecutionId);
        const selectedExecutionId = activity.currentExecutionId ?? null;
        const assignedIds = context.historicalExecution && context.parentActivity?.id === activity.id && execution
            ? execution.assigneeIds : assignments.filter(row => row.activityId === activity.id).map(row => row.userId);
        const items = checklist.filter(row => row.activityId === activity.id && (row.executionId ?? null) === selectedExecutionId);
        const alert = targetsPastExecution(context) ? null : alerts.find(row => row.activityId === activity.id) ?? null;
        return serializeActivity({...activity.get({plain: true}),
            executionDate: execution?.occurrenceDate ?? null, executionClosedAt: execution?.closedAt ?? null, lateUpdatedAt: execution?.lateUpdatedAt ?? null} as ActivityRecord, context, {
            people: summaries,
            assignees: assignedIds.map(id => summaries.get(id) ?? {id, name: null, surname: null, eligible: false}),
            alert, deliveryState: alert ? activityAlertDeliveryState(alert, deliveries.filter(row => row.alertId === alert.id),
                activation?.activatedAt ?? null, evaluationAt) : undefined,
            checklistProgress: {total: items.length, checked: items.filter(row => row.checked).length},
            commentCount: comments.filter(row => row.activityId === activity.id && (row.executionId ?? null) === selectedExecutionId).length,
            evaluationAt, links: links.get(activity.id), templateLinks: templateLinks.get(activity.id), createdBy: summaries.get(activity.createdByUserId) ?? null,
            updatedBy: summaries.get(activity.updatedByUserId ?? '') ?? null
        });
    });
}

const RANK_GAP = 1024n;
const RANK_MIN = -(2n ** 63n);
const RANK_MAX = 2n ** 63n - 1n;

export async function placementPosition(
    context: ActivityContext, boardId: string, status: ActivityStatus,
    placement: {kind: 'start' | 'end'} | {kind: 'before'; activityId: string},
    movingId: string | null, transaction: Transaction
): Promise<string> {
    if (targetsPastExecution(context)) return context.execution!.position;
    const scoped = models(context);
    const column = await scoped.activity.findAll({where: {boardId, status, archivedAt: null},
        order: [['position', 'ASC'], ['id', 'ASC']], transaction});
    let remaining = column.filter(row => row.id !== movingId);
    const anchorId = placement.kind === 'before' ? placement.activityId : null;
    if (placement.kind === 'before' && !remaining.some(row => row.id === placement.activityId)) {
        throw new ActivityError('ORDER_CONFLICT', 409, 'La scheda di riferimento è cambiata. Aggiorna la bacheca e ripeti lo spostamento.');
    }
    const pick = (): bigint | null => {
        if (!remaining.length) return RANK_GAP;
        if (placement.kind === 'end') {
            const position = BigInt(remaining[remaining.length - 1].position) + RANK_GAP;
            return position <= RANK_MAX ? position : null;
        }
        const index = placement.kind === 'start' ? 0 : remaining.findIndex(row => row.id === anchorId);
        const next = BigInt(remaining[index].position);
        if (index === 0) return next - RANK_GAP >= RANK_MIN ? next - RANK_GAP : null;
        const previous = BigInt(remaining[index - 1].position);
        return next - previous > 1n ? previous + (next - previous) / 2n : null;
    };
    let rank = pick();
    if (rank !== null) return rank.toString();
    // Unique partial index is immediate: first move every rank to an unused temporary slot.
    const occupied = new Set(column.map(row => String(row.position)));
    let temporary = RANK_MIN;
    for (const row of column) {
        while (occupied.has(temporary.toString())) temporary++;
        const value = temporary.toString();
        occupied.add(value);
        await scoped.activity.update({position: value}, {where: {id: row.id, boardId}, transaction, silent: true});
        temporary++;
    }
    for (let index = 0; index < remaining.length; index++) {
        const value = (BigInt(index + 1) * RANK_GAP).toString();
        await scoped.activity.update({position: value}, {where: {id: remaining[index].id, boardId}, transaction, silent: true});
        remaining[index].set('position', value);
    }
    rank = pick();
    if (rank === null) throw new ActivityError('ORDER_CONFLICT', 409, 'Non siamo riusciti a riordinare la colonna. Aggiorna la bacheca e riprova.');
    return rank.toString();
}

export {serializeBoard};
