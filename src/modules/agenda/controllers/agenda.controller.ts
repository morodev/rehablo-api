import { Request, Response } from 'express';
import { Op, fn, col } from 'sequelize';
import moment from 'moment';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { sendNewEventMail } from '../../../services/email.service.js';
import AgendaEvent from '../models/agendaEvent.model.js';
import AgendaEventException from '../models/agendaEventException.model.js';
import EventType from '../models/eventType.model.js';
import Patient from '../../patients/models/patient.model.js';

export const eventDashboardWithFilter = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const startDate = new Date(req.query.startDate as string);
    const endDate = new Date(req.query.endDate as string);

    const agendaEvents = await AgendaEvent.schema(schema).findAll({
        where: { start: { [Op.between]: [startDate, endDate] } },
        attributes: [
            'calendarId',
            [fn('DATE_TRUNC', 'month', fn('TO_DATE', col('start'), 'YYYY-MM-DD')), 'month_start'],
            [fn('COUNT', col('*')), 'count']
        ],
        group: ['calendarId', fn('DATE_TRUNC', 'month', fn('TO_DATE', col('start'), 'YYYY-MM-DD'))]
    });

    return sendSuccessResponse(res, 200, agendaEvents, 'Load event group by month and calendar');
});

export const findAllAgendaEvents = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const startDate = new Date(req.query.start as string).toISOString();
    const endDate = new Date(req.query.end as string).toISOString();

    const agendaEvents = await AgendaEvent.schema(schema).findAll({
        where: { start: { [Op.between]: [startDate, endDate] } }
    });

    return sendSuccessResponse(res, 200, { agendaEvents }, 'Agenda events loaded');
});

export const findAgendaEventsByUsers = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const calendarIds = ((req.query.calendarIds as string) || '').split(',').filter(Boolean);

    const agendaEvents = await AgendaEvent.schema(schema).findAll({
        where: { calendarId: { [Op.or]: calendarIds } }
    });

    return sendSuccessResponse(res, 200, { agendaEvents }, 'Agenda events loaded');
});

/**
 * Looks up the appointments of a given patient. In the former microservice architecture this
 * required an HTTP call to rehablo-patient-registry; in the monolith it's a direct, in-process
 * lookup against the Patients module.
 */
export const findAppointmentsForPatientById = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const patientId = req.query.patientId as string;

    const patient = await Patient.schema(schema).findByPk(patientId);
    if (!patient) {
        return sendErrorResponse(res, 404, 'Patient not found');
    }

    const agendaEvents = await AgendaEvent.schema(schema).findAll({
        where: { patient: { id: patientId } as any }
    });

    return sendSuccessResponse(res, 200, { agendaEvents }, 'Agenda events loaded');
});

export const findAllHolidays = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;

    const agendaEvents = await AgendaEvent.schema(schema).findAll({
        where: { [Op.or]: [{ title: 'Ferie' }, { title: 'Permesso' }] }
    });

    return sendSuccessResponse(res, 200, { agendaEvents }, 'Holidays loaded');
});

export const saveAgendaEvent = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const agendaEvent = await AgendaEvent.schema(schema).create(req.body.agendaEvent);

    const patient: any = agendaEvent.get('patient');
    if (patient?.emails?.length > 0 && patient.emails[0]?.email) {
        await sendNewEventMail(agendaEvent.get({ plain: true }));
    }

    return sendSuccessResponse(res, 201, agendaEvent, 'Agenda event created');
});

export const updateAgendaEvent = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.body.id;
    const event = req.body.event;

    if (typeof event.title !== 'string') {
        event.title = event.title?.title;
    }

    const [rowsUpdated] = await AgendaEvent.schema(schema).update(event, { where: { id } });
    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, `Error updating agendaEvent with id=${id}`);
    }

    const updated = await AgendaEvent.schema(schema).findByPk(id);
    return sendSuccessResponse(res, 200, updated, 'Agenda event updated');
});

export const deleteAgendaEvent = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.query.id as string;

    const removed = await AgendaEvent.schema(schema).destroy({ where: { id } });
    return sendSuccessResponse(res, 200, { removed }, 'Evento eliminato correttamente');
});

export const getAllEventExceptions = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const exceptions = await AgendaEventException.schema(schema).findAll();
    return sendSuccessResponse(res, 200, exceptions, 'Event exceptions loaded');
});

function parseRecurrenceRules(recurrence: string): Record<string, string> {
    const rules: Record<string, string> = {};
    recurrence.split(';').forEach((rule) => {
        const [key, value] = rule.split('=');
        rules[key] = value;
    });
    return rules;
}

function stringifyRecurrenceRules(rules: Record<string, string>): string {
    return Object.entries(rules)
        .map(([key, value]) => `${key}=${value}`)
        .join(';');
}

export const updateRecurringEvent = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { event, originalEvent, mode } = req.body;

    const recurringEvent = await AgendaEvent.schema(schema).findByPk(event.recurringEventId);
    if (!recurringEvent) {
        return sendErrorResponse(res, 404, 'Recurring event not found');
    }

    if (mode === 'single') {
        const { range, recurringEventId, ...newEvent } = event;
        newEvent.id = undefined;
        newEvent.end = moment(newEvent.start).add(newEvent.duration, 'minutes').toISOString();
        newEvent.duration = null;
        newEvent.recurrence = null;

        await AgendaEvent.schema(schema).create(newEvent);
        await AgendaEventException.schema(schema).create({
            eventId: originalEvent.recurringEventId,
            exdate: moment(originalEvent.start).toISOString()
        });

        return sendSuccessResponse(res, 201, true, 'Recurring event updated (single)');
    }

    if (mode === 'future') {
        const eventFound: any = recurringEvent.get({ plain: true });
        eventFound.end = moment(originalEvent.start).subtract(1, 'day').endOf('day').toISOString();

        const parsedRules = parseRecurrenceRules(originalEvent.recurrence);
        parsedRules['UNTIL'] = moment(eventFound.end).utc().format('YYYYMMDD[T]HHmmss[Z]');
        eventFound.recurrence = stringifyRecurrenceRules(parsedRules);

        await AgendaEvent.schema(schema).update(eventFound, { where: { id: originalEvent.recurringEventId } });

        const { recurringEventId, ...newEvent } = event;
        newEvent.id = undefined;
        await AgendaEvent.schema(schema).create(newEvent);

        return sendSuccessResponse(res, 201, true, 'Recurring event updated (future)');
    }

    if (mode === 'all') {
        const { id, recurringEventId, range, ...updateAll } = event;
        await AgendaEvent.schema(schema).update(updateAll, { where: { id: event.recurringEventId } });
        return sendSuccessResponse(res, 201, true, 'Recurring event updated (all)');
    }

    return sendErrorResponse(res, 400, 'Unsupported recurrence update mode');
});

export const deleteRecurringEvent = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const event = JSON.parse((req.query.event as string) ?? '{}');
    const mode = req.query.mode as string;

    if (mode === 'single') {
        await AgendaEventException.schema(schema).create({
            eventId: event.recurringEventId,
            exdate: moment(event.start).toISOString()
        });
        return sendSuccessResponse(res, 201, true, 'Recurring event deleted (single)');
    }

    if (mode === 'future') {
        const recurringEvent = await AgendaEvent.schema(schema).findByPk(event.recurringEventId);
        if (!recurringEvent) {
            return sendErrorResponse(res, 404, 'Recurring event not found');
        }

        const eventFound: any = recurringEvent.get({ plain: true });
        eventFound.end = moment(event.start).subtract(1, 'day').endOf('day').toISOString();

        const parsedRules = parseRecurrenceRules(eventFound.recurrence);
        parsedRules['UNTIL'] = moment(event.end).utc().format('YYYYMMDD[T]HHmmss[Z]');
        eventFound.recurrence = stringifyRecurrenceRules(parsedRules);

        await AgendaEvent.schema(schema).update(eventFound, { where: { id: event.recurringEventId } });
        return sendSuccessResponse(res, 201, true, 'Recurring event deleted (future)');
    }

    if (mode === 'all') {
        await AgendaEvent.schema(schema).destroy({ where: { id: event.recurringEventId } });
        return sendSuccessResponse(res, 201, true, 'Recurring event deleted (all)');
    }

    return sendErrorResponse(res, 400, 'Unsupported recurrence delete mode');
});

export default {
    saveAgendaEvent,
    findAllAgendaEvents,
    findAgendaEventsByUsers,
    findAppointmentsForPatientById,
    updateAgendaEvent,
    deleteAgendaEvent,
    getAllEventExceptions,
    updateRecurringEvent,
    deleteRecurringEvent,
    eventDashboardWithFilter,
    findAllHolidays
};

