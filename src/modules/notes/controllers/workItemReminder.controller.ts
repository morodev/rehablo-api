import {Request, Response} from 'express';
import {Op} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendErrorResponse, sendSuccessResponse} from '../../../utils/response.js';
import {textSearchWhere} from '../../../utils/search.js';
import Patient from '../../patients/models/patient.model.js';
import Reminder, {ReminderPriority, ReminderStatus} from '../models/reminder.model.js';
import ReminderAlertState from '../models/reminderAlertState.model.js';
import {enqueueSnoozedExternalAlert} from '../services/reminderExternalDelivery.service.js';
import {contactReminderOccurrenceAt, dailyContactReminderAlertAt, isPatientContactReminder, sameRomeReminderDay} from '../services/patientContactReminder.policy.js';
import {reconcilePatientContactReminders} from '../services/patientContactReminder.service.js';
import {
    assignedReminderIds,
    assignableUsers,
    normalizeAssignedUserIds,
    reminderAssignmentIds,
    replaceReminderAssignments,
    serializeReminders,
    validateAssignedUsers,
    visibleReminderWhere
} from '../services/workItemAccess.service.js';

const STATUSES: ReminderStatus[] = ['OPEN', 'DONE', 'SNOOZED', 'CANCELLED'];
const PRIORITIES: ReminderPriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

function parseDate(value: unknown): Date | null {
    if (!value) return null;
    const date = new Date(value as string);
    return Number.isNaN(date.getTime()) ? null : date;
}

async function assertPatientVisible(req: Request, res: Response, patientId?: string | null): Promise<boolean> {
    if (!patientId) return true;
    const patient = await Patient.schema(req.tenantSchema!).findOne({
        where: {id: patientId, structureId: req.access?.structureId ?? null, archivedAt: null}
    });
    if (patient) return true;
    sendErrorResponse(res, 404, 'Paziente non trovato');
    return false;
}

async function findVisibleReminder(req: Request, reminderId: string): Promise<Reminder | null> {
    const visibility = await visibleReminderWhere(req);
    return Reminder.schema(req.tenantSchema!).findOne({
        where: {[Op.and]: [{id: reminderId, structureId: req.access!.structureId}, visibility] as any[]}
    });
}

async function sendReminder(res: Response, req: Request, status: number, reminder: Reminder, message: string) {
    const [serialized] = await serializeReminders(req, [reminder]);
    return sendSuccessResponse(res, status, serialized, message);
}

function scheduleFor(reminder: Reminder): Date | null {
    return reminder.remindAt ?? reminder.dueAt ?? null;
}

export const getAssignableReminderUsers = asyncHandler(async (req: Request, res: Response) => {
    return sendSuccessResponse(res, 200, await assignableUsers(req), 'Operatori caricati correttamente');
});
export const getReminderById = asyncHandler(async (req: Request, res: Response) => {
    const reminder = await findVisibleReminder(req, req.params.reminderId);
    if (!reminder) return sendErrorResponse(res, 404, 'Promemoria non trovato');
    await reconcilePatientContactReminders(req.tenantSchema!, [reminder]);
    return sendReminder(res, req, 200, reminder, 'Promemoria caricato');
});

export const createReminder = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const body = req.body?.reminder ?? req.body ?? {};
    const title = `${body.title ?? ''}`.trim();
    if (!title) return sendErrorResponse(res, 400, 'Inserisci un titolo per il promemoria');
    if (!req.access?.structureId) return sendErrorResponse(res, 400, 'Seleziona una sede prima di creare il promemoria');
    if (!(await assertPatientVisible(req, res, body.patientId ?? null))) return;

    const assignedUserIds = normalizeAssignedUserIds(body.assignedUserIds, body.assigneeUserId, req.access.userId);
    if (!(await validateAssignedUsers(req, assignedUserIds))) {
        return sendErrorResponse(res, 422, 'Seleziona almeno un operatore valido della sede');
    }
    const reminder = await sequelize.transaction(async transaction => {
        const created = await Reminder.schema(schema).create({
            title,
            description: body.description ?? null,
            dueAt: parseDate(body.dueAt),
            dueAllDay: !!body.dueAllDay,
            remindAt: parseDate(body.remindAt),
            status: STATUSES.includes(body.status) ? body.status : 'OPEN',
            priority: PRIORITIES.includes(body.priority) ? body.priority : 'NORMAL',
            assigneeUserId: assignedUserIds[0],
            createdByUserId: req.access!.userId,
            structureId: req.access!.structureId,
            patientId: body.patientId ?? null,
            noteId: body.noteId ?? null,
            agendaEventId: body.agendaEventId ?? null,
            completedAt: null,
            snoozedUntil: null
        }, {transaction});
        await replaceReminderAssignments(schema, created.id, assignedUserIds, req.access!.userId, transaction);
        return created;
    });
    return sendReminder(res, req, 201, reminder, 'Promemoria creato correttamente');
});

export const getReminders = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const {q, status, patientId, agendaEventId, noteId, from, to, assignedToMe, createdByMe} = req.query as Record<string, string | undefined>;
    const visibility = await visibleReminderWhere(req);
    const base: Record<string, unknown> = {
        structureId: req.access!.structureId,
        ...(status && STATUSES.includes(status as ReminderStatus) ? {status} : {}),
        ...(patientId ? {patientId} : {}),
        ...(agendaEventId ? {agendaEventId} : {}),
        ...(noteId ? {noteId} : {}),
        ...(createdByMe === 'true' ? {createdByUserId: req.access!.userId} : {})
    };
    if (assignedToMe === 'true') base.id = {[Op.in]: await assignedReminderIds(schema, req.access!.userId)};
    const fromDate = parseDate(from);
    const toDate = parseDate(to);
    const dateRange = fromDate && toDate ? {[Op.between]: [fromDate, toDate]} : fromDate ? {[Op.gte]: fromDate} : toDate ? {[Op.lte]: toDate} : null;

    const search = textSearchWhere(['title', 'description'], q);
    const parts: any[] = [visibility, base];
    if (dateRange) parts.push({[Op.or]: [{sourceType: 'PATIENT_MISSING_CONTACTS'}, {dueAt: dateRange}]});
    if (search) parts.push(search);
    const reminders = await Reminder.schema(schema).findAll({
        where: {[Op.and]: parts},
        order: [['status', 'ASC'], ['dueAt', 'ASC'], ['updatedAt', 'DESC']],
        ...(dateRange ? {} : {limit: 500})
    });
    await reconcilePatientContactReminders(schema, reminders);
    const reference = fromDate ?? toDate ?? new Date();
    const serialized = await serializeReminders(req, reminders, {reference});
    const filtered = serialized.filter(row => {
        const occurrence = row.occurrenceAt || row.dueAt ? new Date(row.occurrenceAt ?? row.dueAt) : null;
        return (!status || row.status === status) && (!fromDate || (occurrence && occurrence >= fromDate)) && (!toDate || (occurrence && occurrence <= toDate));
    }).sort((left, right) => Number(new Date(left.occurrenceAt ?? left.dueAt ?? 0)) - Number(new Date(right.occurrenceAt ?? right.dueAt ?? 0))).slice(0, 500);
    return sendSuccessResponse(res, 200, filtered, 'Promemoria caricati correttamente');
});

export const updateReminder = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const body = req.body?.reminder ?? req.body ?? {};
    const reminder = await findVisibleReminder(req, req.params.reminderId);
    if (!reminder) return sendErrorResponse(res, 404, 'Promemoria non trovato');
    const automatic = isPatientContactReminder(reminder);
    if (automatic) {
        const protectedFields = ['patientId', 'agendaEventId', 'noteId', 'structureId', 'sourceType', 'assigneeUserId', 'assignedUserIds', 'dueAt', 'dueAllDay', 'remindAt'];
        if (protectedFields.some(field => Object.hasOwn(body, field))) return sendErrorResponse(res, 422, 'Paziente, assegnazione e avviso quotidiano sono gestiti automaticamente');
        if (body.status && body.status !== reminder.status && !['DONE', 'CANCELLED'].includes(body.status)) return sendErrorResponse(res, 422, 'Un sollecito concluso non può essere riaperto da questo editor');
    }

    const currentUserId = req.access!.userId;
    const isCreator = reminder.createdByUserId === currentUserId;
    const assignedIds = await reminderAssignmentIds(schema, reminder.id);
    if (!isCreator && !assignedIds.includes(currentUserId)) return sendErrorResponse(res, 403, 'Promemoria non trovato');
    if (!isCreator && ('assignedUserIds' in body || 'assigneeUserId' in body)) {
        return sendErrorResponse(res, 403, 'Solo il creatore può cambiare gli operatori assegnati');
    }
    if (body.patientId && !(await assertPatientVisible(req, res, body.patientId))) return;

    const nextAssignedIds = isCreator && ('assignedUserIds' in body || body.assigneeUserId)
        ? normalizeAssignedUserIds(body.assignedUserIds, body.assigneeUserId, currentUserId)
        : assignedIds;
    if (isCreator && !(await validateAssignedUsers(req, nextAssignedIds))) {
        return sendErrorResponse(res, 422, 'Seleziona almeno un operatore valido della sede');
    }

    const creatorFields = ['title', 'description', 'dueAt', 'dueAllDay', 'remindAt', 'status', 'priority',
        'patientId', 'noteId', 'agendaEventId'] as const;
    const collaboratorFields = ['title', 'description', 'status', 'priority'] as const;
    const update: Record<string, unknown> = {updatedByUserId: currentUserId, structureId: req.access!.structureId};
    for (const field of isCreator ? creatorFields : collaboratorFields) {
        if (field in body) update[field] = body[field];
    }
    if (typeof update.title === 'string') {
        update.title = update.title.trim();
        if (!update.title) return sendErrorResponse(res, 400, 'Inserisci un titolo per il promemoria');
    }
    if ('dueAt' in update) update.dueAt = parseDate(update.dueAt);
    if ('remindAt' in update) update.remindAt = parseDate(update.remindAt);
    if (update.status && !STATUSES.includes(update.status as ReminderStatus)) delete update.status;
    if (update.priority && !PRIORITIES.includes(update.priority as ReminderPriority)) delete update.priority;
    if (update.status === 'DONE') update.completedAt = reminder.completedAt ?? new Date();
    else if ('status' in update) update.completedAt = null;
    update.assigneeUserId = nextAssignedIds[0];

    const scheduleChanged = isCreator && ('dueAt' in body || 'remindAt' in body || 'dueAllDay' in body);
    const updated = await sequelize.transaction(async transaction => {
        const current = automatic ? await Reminder.schema(schema).findByPk(reminder.id, {transaction, lock: transaction.LOCK.UPDATE}) : reminder;
        if (!current) throw Object.assign(new Error('Promemoria non trovato'), {statusCode: 404});
        if (automatic && update.status && update.status !== current.status && !['DONE', 'CANCELLED'].includes(String(update.status))) {
            throw Object.assign(new Error('Il sollecito è stato concluso: aggiorna il dettaglio'), {statusCode: 409});
        }
        if (automatic && ['DONE', 'CANCELLED'].includes(String(update.status))) update.completedAt = current.completedAt ?? new Date();
        await current.update(update, {transaction});
        if (isCreator) await replaceReminderAssignments(schema, reminder.id, nextAssignedIds, currentUserId, transaction);
        if (!automatic && (scheduleChanged || isCreator)) {
            await ReminderAlertState.schema(schema).destroy({where: {reminderId: reminder.id}, transaction});
        }
        return current;
    });
    return sendReminder(res, req, 200, updated, 'Promemoria aggiornato correttamente');
});

export const completeReminder = asyncHandler(async (req: Request, res: Response) => {
    const reminder = await findVisibleReminder(req, req.params.reminderId);
    if (!reminder) return sendErrorResponse(res, 404, 'Promemoria non trovato');
    const currentUserId = req.access!.userId;
    const assignedIds = await reminderAssignmentIds(req.tenantSchema!, reminder.id);
    if (reminder.createdByUserId !== currentUserId && !assignedIds.includes(currentUserId)) {
        return sendErrorResponse(res, 404, 'Promemoria non trovato');
    }
    await reminder.update({status: 'DONE', completedAt: new Date(), snoozedUntil: null, updatedByUserId: currentUserId});
    return sendReminder(res, req, 200, reminder, 'Promemoria completato correttamente');
});

export const snoozeReminderAlert = asyncHandler(async (req: Request, res: Response) => {
    const snoozedUntil = parseDate(req.body?.snoozedUntil);
    if (!snoozedUntil || snoozedUntil.getTime() <= Date.now()) {
        return sendErrorResponse(res, 400, 'Scegli una data futura per il posticipo');
    }
    const reminder = await findVisibleReminder(req, req.params.reminderId);
    if (!reminder) return sendErrorResponse(res, 404, 'Promemoria non trovato');
    const userId = req.access!.userId;
    if (!(await reminderAssignmentIds(req.tenantSchema!, reminder.id)).includes(userId)) {
        return sendErrorResponse(res, 403, 'Solo un operatore assegnato può posticipare il proprio avviso');
    }
    const model = ReminderAlertState.schema(req.tenantSchema!);
    const updated = await sequelize.transaction(async transaction => {
        if (isPatientContactReminder(reminder) && reminder.patientId) await Patient.schema(req.tenantSchema!).findByPk(reminder.patientId, {transaction, lock: transaction.LOCK.UPDATE, attributes: ['id']});
        const locked = await Reminder.schema(req.tenantSchema!).findByPk(reminder.id, {transaction, lock: transaction.LOCK.UPDATE});
        if (!locked || !['OPEN', 'SNOOZED'].includes(locked.status) || locked.structureId !== req.access!.structureId
            || !(await reminderAssignmentIds(req.tenantSchema!, locked.id)).includes(userId)) throw Object.assign(new Error('Promemoria non disponibile per il posticipo'), {statusCode: 409});
        const occurrence = contactReminderOccurrenceAt(locked);
        if (occurrence && snoozedUntil < occurrence) throw Object.assign(new Error('Il posticipo non può precedere l’avviso previsto'), {statusCode: 422});
        const [state] = await model.findOrCreate({
            where: {reminderId: reminder.id, userId},
            defaults: {reminderId: reminder.id, userId, scheduledFor: scheduleFor(locked), deliveredAt: new Date(), snoozedUntil},
            transaction
        });
        await state.update({scheduledFor: scheduleFor(locked), deliveredAt: new Date(), snoozedUntil}, {transaction});
        await enqueueSnoozedExternalAlert(req.tenantSchema!, locked, userId, snoozedUntil, transaction);
        return locked;
    });
    return sendReminder(res, req, 200, updated, 'Avviso posticipato');
});

export const claimReminderAlerts = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const userId = req.access!.userId;
    const assignedIds = await assignedReminderIds(schema, userId);
    if (!assignedIds.length) return sendSuccessResponse(res, 200, [], 'Nessun avviso');
    const now = new Date();
    const reminders = await Reminder.schema(schema).findAll({
        where: {
            id: {[Op.in]: assignedIds},
            structureId: req.access!.structureId,
            status: {[Op.in]: ['OPEN', 'SNOOZED']},
            [Op.or]: [
                {sourceType: 'PATIENT_MISSING_CONTACTS'},
                {remindAt: {[Op.lte]: now}},
                {remindAt: null, dueAt: {[Op.lte]: now}}
            ]
        },
        order: [['remindAt', 'ASC'], ['dueAt', 'ASC']],
    });

    const claimed = await sequelize.transaction(async transaction => {
        const result: Reminder[] = [];
        const states = ReminderAlertState.schema(schema);
        for (const reminder of reminders) {
            if (result.length >= 20) break;
            // Contact writers lock the patient before completing its reminders; keep the same order.
            if (isPatientContactReminder(reminder) && reminder.patientId) await Patient.schema(schema).findByPk(reminder.patientId, {transaction, lock: transaction.LOCK.UPDATE, attributes: ['id']});
            const locked = await Reminder.schema(schema).findByPk(reminder.id, {transaction, lock: transaction.LOCK.UPDATE});
            if (!locked || !['OPEN', 'SNOOZED'].includes(locked.status)) continue;
            await reconcilePatientContactReminders(schema, [locked], transaction);
            if (!['OPEN', 'SNOOZED'].includes(locked.status)) continue;
            let state = await states.findOne({where: {reminderId: reminder.id, userId}, transaction, lock: transaction.LOCK.UPDATE});
            const automatic = isPatientContactReminder(locked);
            if (state?.snoozedUntil && state.snoozedUntil > now) continue;
            const scheduled = automatic ? state?.snoozedUntil ?? dailyContactReminderAlertAt(locked, now) : scheduleFor(locked);
            if (!scheduled || (automatic && !state?.snoozedUntil && state?.deliveredAt && sameRomeReminderDay(state.deliveredAt, now))) continue;
            if (!state) {
                state = await states.create({reminderId: reminder.id, userId, scheduledFor: scheduled, deliveredAt: now, snoozedUntil: null}, {transaction});
                result.push(locked);
                continue;
            }
            const sameSchedule = state.scheduledFor?.getTime() === scheduled.getTime();
            if (state.snoozedUntil && state.snoozedUntil.getTime() > now.getTime()) continue;
            if (sameSchedule && state.deliveredAt && !state.snoozedUntil) continue;
            await state.update({scheduledFor: scheduled, deliveredAt: now, snoozedUntil: null}, {transaction});
            result.push(locked);
        }
        return result;
    });
    return sendSuccessResponse(res, 200, await serializeReminders(req, claimed), 'Avvisi caricati correttamente');
});

export const deleteReminder = asyncHandler(async (req: Request, res: Response) => {
    const reminder = await findVisibleReminder(req, req.params.reminderId);
    if (!reminder) return sendErrorResponse(res, 404, 'Promemoria non trovato');
    if (reminder.createdByUserId !== req.access!.userId) {
        return sendErrorResponse(res, 403, 'Solo il creatore può eliminare il promemoria');
    }
    await reminder.destroy();
    return sendSuccessResponse(res, 200, {removed: 1}, 'Promemoria eliminato correttamente');
});

export default {
    getReminderById,
    createReminder,
    getReminders,
    updateReminder,
    completeReminder,
    snoozeReminderAlert,
    claimReminderAlerts,
    deleteReminder,
    getAssignableReminderUsers
};
