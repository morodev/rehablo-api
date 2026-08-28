import { Request, Response } from 'express';
import { Op } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { scopeWhere } from '../../../middleware/rbac.js';
import Patient from '../../patients/models/patient.model.js';
import Reminder, { ReminderPriority, ReminderStatus } from '../models/reminder.model.js';

const REMINDER_SCOPE_FIELDS = {
    ownerField: 'assigneeUserId',
    structureField: 'structureId',
    includeUnassigned: false
};

const STATUSES: ReminderStatus[] = ['OPEN', 'DONE', 'SNOOZED', 'CANCELLED'];
const PRIORITIES: ReminderPriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

function parseDate(value: unknown): Date | null {
    if (!value) return null;
    const date = new Date(value as string);
    return Number.isNaN(date.getTime()) ? null : date;
}

function resolveWritableStructureId(req: Request): string | null {
    return req.access?.structureId ?? null;
}

async function assertPatientVisible(req: Request, res: Response, patientId?: string | null): Promise<boolean> {
    if (!patientId) return true;

    const patient = await Patient.schema(req.tenantSchema!).findOne({
        where: {
            id: patientId,
            structureId: req.access?.structureId ?? null,
            archivedAt: null
        }
    });

    if (patient) return true;
    sendErrorResponse(res, 404, 'Paziente non trovato');
    return false;
}

export const createReminder = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const body = req.body?.reminder ?? req.body ?? {};

    const title = `${body.title ?? ''}`.trim();
    if (!title) {
        return sendErrorResponse(res, 400, 'title is required');
    }

    const patientId = body.patientId ?? null;
    const structureId = resolveWritableStructureId(req);
    if (!structureId) {
        return sendErrorResponse(res, 400, 'Seleziona una sede prima di creare il promemoria');
    }
    if (!(await assertPatientVisible(req, res, patientId))) {
        return;
    }

    const assigneeUserId = req.access?.scope === 'own'
        ? req.access.userId
        : body.assigneeUserId ?? req.access?.userId ?? req.user!.id;

    const reminder = await Reminder.schema(schema).create({
        title,
        description: body.description ?? null,
        dueAt: parseDate(body.dueAt),
        remindAt: parseDate(body.remindAt),
        status: STATUSES.includes(body.status) ? body.status : 'OPEN',
        priority: PRIORITIES.includes(body.priority) ? body.priority : 'NORMAL',
        assigneeUserId,
        createdByUserId: req.user!.id,
        structureId,
        patientId,
        noteId: body.noteId ?? null,
        agendaEventId: body.agendaEventId ?? null,
        completedAt: null,
        snoozedUntil: parseDate(body.snoozedUntil)
    });

    return sendSuccessResponse(res, 201, reminder, 'Promemoria creato correttamente');
});

export const getReminders = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { q, status, patientId, agendaEventId, noteId, from, to, assignedToMe } = req.query as Record<string, string | undefined>;

    const where: Record<string, unknown> = {
        ...scopeWhere(req, REMINDER_SCOPE_FIELDS),
        ...(status && STATUSES.includes(status as ReminderStatus) ? { status } : {}),
        ...(patientId ? { patientId } : {}),
        ...(agendaEventId ? { agendaEventId } : {}),
        ...(noteId ? { noteId } : {}),
        ...(assignedToMe === 'true' ? { assigneeUserId: req.access?.userId ?? req.user!.id } : {})
    };

    const fromDate = parseDate(from);
    const toDate = parseDate(to);
    if (fromDate && toDate) {
        where.dueAt = { [Op.between]: [fromDate, toDate] };
    } else if (fromDate) {
        where.dueAt = { [Op.gte]: fromDate };
    } else if (toDate) {
        where.dueAt = { [Op.lte]: toDate };
    }

    if (q?.trim()) {
        where[Op.or as any] = [
            { title: { [Op.iLike]: `%${q.trim()}%` } },
            { description: { [Op.iLike]: `%${q.trim()}%` } }
        ];
    }

    const reminders = await Reminder.schema(schema).findAll({
        where,
        order: [
            ['status', 'ASC'],
            ['dueAt', 'ASC'],
            ['updatedAt', 'DESC']
        ],
        limit: 500
    });

    return sendSuccessResponse(res, 200, reminders, 'Promemoria caricati correttamente');
});

export const updateReminder = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const body = req.body?.reminder ?? req.body ?? {};

    if (body.patientId && !(await assertPatientVisible(req, res, body.patientId))) {
        return;
    }

    const update: Record<string, unknown> = {
        ...body,
        updatedByUserId: req.user!.id
    };

    if (update.status && !STATUSES.includes(update.status as ReminderStatus)) {
        delete update.status;
    }
    if (update.priority && !PRIORITIES.includes(update.priority as ReminderPriority)) {
        delete update.priority;
    }
    if ('dueAt' in update) update.dueAt = parseDate(update.dueAt);
    if ('remindAt' in update) update.remindAt = parseDate(update.remindAt);
    if ('snoozedUntil' in update) update.snoozedUntil = parseDate(update.snoozedUntil);

    if (req.access?.scope === 'own') {
        delete update.assigneeUserId;
        delete update.structureId;
    } else if (req.access?.scope === 'structure') {
        update.structureId = req.access.structureId;
    }
    delete update.id;
    delete update.createdByUserId;

    const [rowsUpdated] = await Reminder.schema(schema).update(update, {
        where: { id: req.params.reminderId, ...scopeWhere(req, REMINDER_SCOPE_FIELDS) }
    });

    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Promemoria non trovato');
    }

    const updated = await Reminder.schema(schema).findOne({
        where: { id: req.params.reminderId, ...scopeWhere(req, REMINDER_SCOPE_FIELDS) }
    });
    return sendSuccessResponse(res, 200, updated, 'Promemoria aggiornato correttamente');
});

export const completeReminder = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const [rowsUpdated] = await Reminder.schema(schema).update(
        {
            status: 'DONE',
            completedAt: new Date(),
            snoozedUntil: null,
            updatedByUserId: req.user!.id
        },
        { where: { id: req.params.reminderId, ...scopeWhere(req, REMINDER_SCOPE_FIELDS) } }
    );

    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Promemoria non trovato');
    }

    const updated = await Reminder.schema(schema).findOne({
        where: { id: req.params.reminderId, ...scopeWhere(req, REMINDER_SCOPE_FIELDS) }
    });
    return sendSuccessResponse(res, 200, updated, 'Promemoria completato correttamente');
});

export const snoozeReminder = asyncHandler(async (req: Request, res: Response) => {
    const snoozedUntil = parseDate(req.body?.snoozedUntil);
    if (!snoozedUntil) {
        return sendErrorResponse(res, 400, 'snoozedUntil is required');
    }

    const schema = req.tenantSchema!;
    const [rowsUpdated] = await Reminder.schema(schema).update(
        {
            status: 'SNOOZED',
            snoozedUntil,
            updatedByUserId: req.user!.id
        },
        { where: { id: req.params.reminderId, ...scopeWhere(req, REMINDER_SCOPE_FIELDS) } }
    );

    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Promemoria non trovato');
    }

    const updated = await Reminder.schema(schema).findOne({
        where: { id: req.params.reminderId, ...scopeWhere(req, REMINDER_SCOPE_FIELDS) }
    });
    return sendSuccessResponse(res, 200, updated, 'Promemoria posticipato correttamente');
});

export const deleteReminder = asyncHandler(async (req: Request, res: Response) => {
    const removed = await Reminder.schema(req.tenantSchema!).destroy({
        where: { id: req.params.reminderId, ...scopeWhere(req, REMINDER_SCOPE_FIELDS) }
    });

    if (removed === 0) {
        return sendErrorResponse(res, 404, 'Promemoria non trovato');
    }

    return sendSuccessResponse(res, 200, { removed }, 'Promemoria eliminato correttamente');
});

export default {
    createReminder,
    getReminders,
    updateReminder,
    completeReminder,
    snoozeReminder,
    deleteReminder
};
