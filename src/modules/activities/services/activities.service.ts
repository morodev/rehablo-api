import {Request} from 'express';
import {Op, Transaction} from 'sequelize';
import {validateActivityReviewer, setActivityWorkflow, invalidateActivityReview, requireCompletionPermission} from './activityWorkflow.service.js';
import {sequelize} from '../../../config/database.js';
import {
    ACTIVITY_STATUSES, ActivityAgendaLookupQuery, ActivityAlertInput, ActivityAlertChannel, ActivityArchiveInput,
    ActivityContext, ActivityCreateInput, ActivityDue, ActivityLookupQuery, ActivityMoveInput, ActivityPatchInput,
    ActivityRecord, ActivitySchedule
} from '../activities.types.js';
import {Activity, ActivityBoard} from '../models/index.js';
import {ensureActivityDeliveryActivation} from './activityDeliveryActivation.service.js';
import {cancelActivityDeliveries, materializeActivityDeliveries} from './activityDeliveryPersistence.service.js';
import {ActivityError} from '../utils/activityErrors.js';
import {serializeChecklist} from '../utils/activityChildSerialization.js';
import {getActivityChildPage, readActivityChildPage} from './activityCollaboration.service.js';
import {dueFromActivity, validateActivitySchedule} from '../utils/activityValidation.js';
import {
    assignableActivityUsers, requireActivityLinks, resolveActivityContext, searchActivityAgendaLinks, searchActivityPatientLinks,
    validateActivityAssignees, visibleActivityLinkMetadata
} from './activityAccess.service.js';
import {
    activityInBoard, assertCapability, assertOrder, assertVersion, assignmentIds, currentBoard,
    models, mutationResponse, placementPosition, recordHistory, requireAccess,
    serializeActivities, serializeBoard, reviseBoard, writeOperation
} from './activityPersistence.service.js';

export function requireActivityId(value: string): string {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
        throw new ActivityError('ACTIVITY_NOT_FOUND', 404, 'Questa attività non è disponibile nella sede selezionata.');
    }
    return value;
}

export async function getActivityBoard(req: Request) {
    return read(req, async (context, board) => ({
        ...serializeBoard(board.get({plain: true})), serverNow: new Date().toISOString(),
        columns: ACTIVITY_STATUSES.map((status, index) => ({status, label: ['Da fare', 'In corso', 'In attesa', 'Completate'][index]})),
        capabilities: {canCreate: context.permissions.some(permission => permission.startsWith('activity:create:') || permission.startsWith('activity:manage:'))}
    }));
}

export async function getActivityAssignees(req: Request) {
    return read(req, async (context, _board, transaction) => {
        const query = typeof req.query.search === 'string' ? req.query.search.trim().toLocaleLowerCase('it') : '';
        const rawLimit = req.query.limit === undefined ? 20 : Number(req.query.limit);
        const rawOffset = req.query.offset === undefined ? 0 : Number(req.query.offset);
        if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200 || !Number.isInteger(rawOffset) || rawOffset < 0) {
            throw new ActivityError('ACTIVITY_VALIDATION_FAILED', 422, 'Controlla i parametri di ricerca degli operatori.');
        }
        const available = (await assignableActivityUsers(context, transaction)).filter(user =>
            !query || query.split(/\s+/).every(part => `${user.name ?? ''} ${user.surname ?? ''}`.toLocaleLowerCase('it').includes(part)));
        return {items: available.slice(rawOffset, rawOffset + rawLimit), total: available.length,
            nextOffset: rawOffset + rawLimit < available.length ? rawOffset + rawLimit : null};
    });
}

export async function getActivityAgendaEvents(req: Request) {
    return read(req, async (context, _board, transaction) => {
        const page = parseActivityLookupQuery(req, 'degli appuntamenti');
        const patientId = req.query.patientId === undefined ? null : req.query.patientId;
        if (patientId !== null && (typeof patientId !== 'string'
            || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(patientId))) {
            throw new ActivityError('ACTIVITY_VALIDATION_FAILED', 422, 'Controlla i parametri di ricerca degli appuntamenti.');
        }
        const input: ActivityAgendaLookupQuery = {...page, patientId: typeof patientId === 'string' ? patientId.toLowerCase() : null};
        return searchActivityAgendaLinks(context, input, transaction);
    });
}

export async function getActivityPatients(req: Request) {
    return read(req, async (context, _board, transaction) =>
        searchActivityPatientLinks(context, parseActivityLookupQuery(req, 'dei pazienti'), transaction));
}

function parseActivityLookupQuery(req: Request, resource: string): ActivityLookupQuery {
    const query = req.query.query === undefined ? '' : req.query.query;
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (typeof query !== 'string' || query.length > 200
        || (req.query.offset !== undefined && (typeof req.query.offset !== 'string' || !/^\d+$/.test(req.query.offset)))
        || (req.query.limit !== undefined && (typeof req.query.limit !== 'string' || !/^\d+$/.test(req.query.limit)))
        || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new ActivityError('ACTIVITY_VALIDATION_FAILED', 422, `Controlla i parametri di ricerca ${resource}.`);
    }
    return {query: query.trim().replace(/\s+/g, ' '), offset, limit};
}

export async function getActivity(req: Request, activityId: string) {
    requireActivityId(activityId);
    return read(req, async (context, board, transaction) => {
        const activity = await activityInBoard(context, board.id, activityId, transaction);
        const scoped = models(context);
        const [checklistRows, commentsPage, historyPage, links] = await Promise.all([
            scoped.checklist.findAll({where: {activityId}, order: [['position', 'ASC'], ['id', 'ASC']], transaction}),
            readActivityChildPage(context, board, activity, 'comments', {limit: 20, cursor: null, offset: 0}, transaction),
            readActivityChildPage(context, board, activity, 'history', {limit: 20, cursor: null, offset: 0}, transaction),
            visibleActivityLinkMetadata(context, activity, transaction)
        ]);
        return {activity: (await serializeActivities(context, [activity], transaction))[0],
            checklist: await serializeChecklist(context, checklistRows, transaction), history: historyPage.items,
            commentsPage, historyPage, links, orderRevision: board.get('orderRevision'), snapshotRevision: board.get('snapshotRevision')};
    });
}

export async function getActivityHistory(req: Request, activityId: string) {
    const page = await getActivityChildPage(req, activityId, 'history');
    const offset = Number(req.query.offset ?? 0), limit = Number(req.query.limit ?? 20);
    return {...page, nextOffset: !req.query.cursor && offset + limit < page.total ? offset + limit : null};
}

export async function createActivity(req: Request, input: ActivityCreateInput) {
    return writeOperation(req, input, 'create', async (context, board, transaction) => {
        requireAccess(context, 'create');
        await validateActivityAssignees(context, input.assigneeIds, transaction);
        await validateActivityReviewer(context, input.reviewerUserId ?? null, input.assigneeIds, transaction);
        if (input.reviewerUserId && input.status === 'COMPLETED') throw new ActivityError('REVIEW_REQUIRED', 422, 'Crea l’attività aperta per inviarla al revisore.', {status: 'È necessaria la revisione.'});
        await requireActivityLinks(context, input, transaction);
        const now = new Date();
        validateActivitySchedule({...input, archivedAt: null}, null, now, context.timezone);
        if (input.status === 'COMPLETED' && input.checklist.length) throw new ActivityError('ACTIVITY_VALIDATION_FAILED', 422,
            'Crea l’attività aperta e controlla la checklist prima di completarla.', {status: 'La checklist contiene elementi da completare.'});
        const position = await placementPosition(context, board.id, input.status, {kind: 'end'}, null, transaction);
        const scoped = models(context);
        const activity = await scoped.activity.create({
            boardId: board.id, title: input.title, description: input.description,
            reviewerUserId: input.reviewerUserId ?? null, reviewStatus: 'not_requested',
            status: input.status, priority: input.priority, position, version: 1,
            checklistRevision: input.checklist.length ? 1 : 0, ...dueFields(input.due),
            createdByUserId: context.userId, updatedByUserId: context.userId,
            patientId: input.patientId, agendaEventId: input.agendaEventId,
            completedAt: input.status === 'COMPLETED' ? now : null,
            completedByUserId: input.status === 'COMPLETED' ? context.userId : null,
            archivedAt: null, archivedByUserId: null, reassignmentRequired: false
        }, {transaction});
        await replaceAssignments(context, activity.id, input.assigneeIds, transaction);
        if (input.checklist.length) await scoped.checklist.bulkCreate(input.checklist.map((item, index) => ({
            activityId: activity.id, text: item.text, position: String((index + 1) * 1024),
            checked: false, version: 1, createdByUserId: context.userId
        })), {transaction});
        await persistAlert(context, activity.id, input.alert, transaction);
        await recordHistory(context, activity.id, 'CREATED', {
            status: input.status, priority: input.priority, assigneeIds: input.assigneeIds,
            checklistCount: input.checklist.length
        }, transaction);
        await reviseBoard(board, transaction, true);
        return mutationResponse(context, board, activity, transaction);
    });
}

export async function patchActivity(req: Request, activityId: string, input: ActivityPatchInput, command = 'patch') {
    requireActivityId(activityId);
    return writeOperation(req, {...input, activityId}, command, async (context, board, transaction) => {
        requireAccess(context, 'update');
        const activity = await activityInBoard(context, board.id, activityId, transaction);
        const reviewerOnly = Object.keys(input.changes).every(key => key === 'reviewerUserId');
        await assertCapability(context, activity, activity.archivedAt ? 'canRestore' : reviewerOnly ? 'canAssignReviewer' : 'canEdit', transaction);
        if (activity.archivedAt) throw new ActivityError('INVALID_TRANSITION', 409, 'Ripristina l’attività prima di modificarla.');
        assertVersion(activity, input.expectedVersion);
        const original = await currentSchedule(context, activity, transaction);
        const changes = input.changes;
        if (changes.reviewerUserId !== undefined && changes.reviewerUserId !== activity.reviewerUserId) {
            await assertCapability(context, activity, 'canAssignReviewer', transaction);
        }
        const nextAssignees = changes.assigneeIds ?? original.assigneeIds;
        const nextReviewer = changes.reviewerUserId === undefined ? activity.reviewerUserId : changes.reviewerUserId;
        if (changes.reviewerUserId !== undefined || changes.assigneeIds !== undefined) {
            await validateActivityReviewer(context, nextReviewer, nextAssignees, transaction, nextReviewer === activity.reviewerUserId);
        }
        const reviewInvalidated = (changes.title !== undefined && changes.title !== activity.title)
            || (changes.description !== undefined && changes.description !== activity.description)
            || (changes.reviewerUserId !== undefined && changes.reviewerUserId !== activity.reviewerUserId)
            || (changes.assigneeIds !== undefined && JSON.stringify([...changes.assigneeIds].sort()) !== JSON.stringify([...original.assigneeIds].sort()));
        const workflowChanged = reviewInvalidated ? await invalidateActivityReview(context, board, activity, transaction) : false;
        if (changes.assigneeIds !== undefined) await validateActivityAssignees(context, changes.assigneeIds, transaction);
        if (changes.patientId !== undefined || changes.agendaEventId !== undefined) {
            await requireActivityLinks(context, {
                patientId: changes.patientId === undefined ? activity.patientId : changes.patientId,
                agendaEventId: changes.agendaEventId === undefined ? activity.agendaEventId : changes.agendaEventId
            }, transaction);
        }
        const proposed: ActivitySchedule = {
            due: changes.due === undefined ? original.due : changes.due,
            alert: changes.alert === undefined ? original.alert : changes.alert,
            assigneeIds: changes.assigneeIds === undefined ? original.assigneeIds : changes.assigneeIds,
            status: activity.status, archivedAt: activity.archivedAt
        };
        if (changes.alert) {
            const eligible = new Set((await assignableActivityUsers(context, transaction)).map(user => user.id));
            if (!proposed.assigneeIds.some(id => eligible.has(id))) throw new ActivityError('INVALID_ALERT', 422,
                'Assegna l’attività ad almeno un operatore attivo della sede prima di attivare l’avviso.',
                {assigneeIds: 'Non ci sono assegnatari attualmente idonei a ricevere questo avviso.'});
        }
        validateActivitySchedule(proposed, original, new Date(), context.timezone);
        const fields: Record<string, unknown> = {version: activity.version + 1, updatedByUserId: context.userId};
        for (const key of ['title', 'description', 'priority', 'patientId', 'agendaEventId', 'reviewerUserId'] as const) {
            if (changes[key] !== undefined) fields[key] = changes[key];
        }
        if (changes.due !== undefined) Object.assign(fields, dueFields(changes.due));
        if (changes.assigneeIds !== undefined) {
            await replaceAssignments(context, activity.id, changes.assigneeIds, transaction);
            fields.reassignmentRequired = false;
        }
        await activity.update(fields, {transaction});
        if (changes.alert !== undefined) await persistAlert(context, activity.id, changes.alert, transaction);
        await recordHistory(context, activity.id, 'UPDATED', {
            fields: Object.keys(changes),
            ...(changes.assigneeIds !== undefined ? {previousAssigneeIds: original.assigneeIds, assigneeIds: changes.assigneeIds} : {})
        }, transaction);
        await reviseBoard(board, transaction, workflowChanged);
        return mutationResponse(context, board, activity, transaction);
    });
}

export async function moveActivity(req: Request, activityId: string, input: ActivityMoveInput) {
    requireActivityId(activityId);
    return writeOperation(req, {...input, activityId}, 'move', async (context, board, transaction) => {
        requireAccess(context, 'update');
        const activity = await activityInBoard(context, board.id, activityId, transaction);
        await assertCapability(context, activity, activity.archivedAt ? 'canRestore' : 'canMove', transaction);
        if (activity.archivedAt) throw new ActivityError('INVALID_TRANSITION', 409, 'Ripristina l’attività prima di cambiarne lo stato.');
        assertVersion(activity, input.expectedVersion);
        assertOrder(board, input.expectedOrderRevision);
        const previousStatus = activity.status;
        const completing = input.targetStatus === 'COMPLETED' && previousStatus !== 'COMPLETED';
        if (completing) {
            await requireCompletionPermission(context, activity, transaction);
            if (input.expectedChecklistRevision !== activity.checklistRevision) throw new ActivityError('CHECKLIST_VERSION_CONFLICT', 409,
                'La checklist è stata aggiornata. Controllala prima di completare l’attività.');
            const incomplete = await models(context).checklist.count({where: {activityId, checked: false}, transaction});
            if (incomplete && !input.allowIncompleteChecklist) throw new ActivityError('CHECKLIST_INCOMPLETE', 409,
                `Ci sono ancora ${incomplete} elementi da completare. Vuoi completare comunque l’attività?`);
        }
        if (activity.reviewStatus === 'pending' && previousStatus === 'WAITING' && input.targetStatus !== 'WAITING') {
            await assertCapability(context, activity, 'canReview', transaction);
            throw new ActivityError('REVIEW_ACTION_REQUIRED', 409, 'Usa Approva e completa oppure Rimanda in corso per concludere la revisione.');
        }
        const position = await placementPosition(context, board.id, input.targetStatus, input.placement, activityId, transaction);
        const reopened = previousStatus === 'COMPLETED' && input.targetStatus !== 'COMPLETED';
        // Compaction may have changed this row through a static update in the same transaction.
        activity.set('position', position);
        activity.changed('position', true);
        await activity.update({
            status: input.targetStatus, position, version: activity.version + (previousStatus === input.targetStatus ? 0 : 1), updatedByUserId: context.userId,
            ...(completing ? {completedAt: new Date(), completedByUserId: context.userId} : {}),
            ...(reopened ? {completedAt: null, completedByUserId: null} : {}),
            ...(input.targetStatus !== previousStatus && input.targetStatus !== 'COMPLETED' ? {reviewStatus: 'not_requested', reviewApprovedAt: null, reviewApprovedByUserId: null} : {})
        }, {transaction});
        if (completing) await persistAlert(context, activity.id, null, transaction);
        await recordHistory(context, activity.id, completing ? 'COMPLETED' : reopened ? 'REOPENED' : previousStatus === input.targetStatus ? 'REORDERED' : 'STATUS_CHANGED',
            {from: previousStatus, to: input.targetStatus, allowIncompleteChecklist: completing && input.allowIncompleteChecklist === true}, transaction);
        await reviseBoard(board, transaction, true);
        return mutationResponse(context, board, activity, transaction);
    });
}

export async function archiveActivity(req: Request, activityId: string, input: ActivityArchiveInput, restore = false) {
    requireActivityId(activityId);
    return writeOperation(req, {...input, activityId}, restore ? 'restore' : 'archive', async (context, board, transaction) => {
        requireAccess(context, 'update');
        const activity = await activityInBoard(context, board.id, activityId, transaction);
        if (Boolean(activity.archivedAt) !== restore) throw new ActivityError('INVALID_TRANSITION', 409,
            restore ? 'Questa attività è già nella bacheca.' : 'Questa attività è già archiviata.');
        await assertCapability(context, activity, restore ? 'canRestore' : 'canArchive', transaction);
        assertVersion(activity, input.expectedVersion);
        assertOrder(board, input.expectedOrderRevision);
        const position = restore ? await placementPosition(context, board.id, activity.status, {kind: 'end'}, activityId, transaction) : activity.position;
        await activity.update({
            archivedAt: restore ? null : new Date(), archivedByUserId: restore ? null : context.userId,
            version: activity.version + 1, updatedByUserId: context.userId, position
        }, {transaction});
        if (!restore) await persistAlert(context, activity.id, null, transaction);
        await recordHistory(context, activity.id, restore ? 'RESTORED' : 'ARCHIVED', {status: activity.status}, transaction);
        await reviseBoard(board, transaction, true);
        return mutationResponse(context, board, activity, transaction);
    });
}

async function read<T>(req: Request, callback: (context: ActivityContext, board: ActivityBoard, transaction: Transaction) => Promise<T>) {
    return sequelize.transaction({isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ, readOnly: true}, async transaction => {
        const context = await resolveActivityContext(req, transaction);
        requireAccess(context, 'read');
        const board = await currentBoard(context, transaction);
        return callback(context, board, transaction);
    });
}

export function dueFields(due: ActivityDue) {
    return {
        dueKind: due?.kind ?? null,
        dueAt: due?.kind === 'timed' ? new Date(due.at) : null,
        dueDate: due?.kind === 'allDay' ? due.date : null,
        dueTimezone: due?.kind === 'allDay' ? due.timezone : null
    };
}

async function currentSchedule(context: ActivityContext, activity: Activity, transaction: Transaction): Promise<ActivitySchedule> {
    const alert = await models(context).alert.findOne({where: {activityId: activity.id}, transaction});
    return {
        due: dueFromActivity(activity.get({plain: true}) as ActivityRecord),
        assigneeIds: await assignmentIds(context, activity.id, transaction),
        alert: alert?.enabled && alert.scheduledAt ? {
            scheduledAt: alert.scheduledAt.toISOString(), channels: alert.channels as ActivityAlertChannel[]
        } : null,
        status: activity.status, archivedAt: activity.archivedAt
    };
}

async function replaceAssignments(context: ActivityContext, activityId: string, ids: string[], transaction: Transaction) {
    const assignment = models(context).assignment;
    await assignment.destroy({where: {activityId, ...(ids.length ? {userId: {[Op.notIn]: ids}} : {})}, transaction});
    if (ids.length) await assignment.bulkCreate(ids.map(userId => ({activityId, userId, assignedByUserId: context.userId})), {transaction, ignoreDuplicates: true});
    const alert = await models(context).alert.findOne({where: {activityId}, transaction});
    if (alert) {
        await cancelActivityDeliveries(context.schema, alert.id, transaction, {keep: ids});
        await materializeActivityDeliveries(context.schema, alert, transaction, {reactivateRecipients: true});
    }
}

async function persistAlert(context: ActivityContext, activityId: string, input: ActivityAlertInput | null, transaction: Transaction) {
    if (input) await ensureActivityDeliveryActivation(context.schema, transaction);
    const scoped = models(context);
    const existing = await scoped.alert.findOne({where: {activityId}, transaction});
    const unchanged = existing && existing.enabled === Boolean(input)
        && (!input || (existing.scheduledAt?.toISOString() === input.scheduledAt
            && JSON.stringify(existing.channels) === JSON.stringify(input.channels)));
    if (unchanged || (!existing && !input)) {
        if (existing) await materializeActivityDeliveries(context.schema, existing, transaction);
        return;
    }
    let persisted = existing;
    if (existing) {
        await existing.update({enabled: Boolean(input), scheduledAt: input ? new Date(input.scheduledAt) : existing.scheduledAt,
            channels: input?.channels ?? existing.channels, scheduleVersion: existing.scheduleVersion + 1}, {transaction});
        await cancelActivityDeliveries(context.schema, existing.id, transaction);
    } else {
        persisted = await scoped.alert.create({activityId, enabled: true, scheduledAt: new Date(input!.scheduledAt), channels: input!.channels, scheduleVersion: 1}, {transaction});
    }
    if (persisted) await materializeActivityDeliveries(context.schema, persisted, transaction);
    await recordHistory(context, activityId, input ? 'ALERT_SCHEDULED' : 'ALERT_CANCELLED',
        input ? {scheduledAt: input.scheduledAt, channels: input.channels} : {}, transaction);
}
