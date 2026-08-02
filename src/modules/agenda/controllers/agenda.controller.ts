import { Request, Response } from 'express';
import { Op, fn, col } from 'sequelize';
import moment from 'moment';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { scopeWhere } from '../../../middleware/rbac.js';
import { sendNewEventMail } from '../../../services/email.service.js';
import AgendaEvent from '../models/agendaEvent.model.js';
import AgendaEventException from '../models/agendaEventException.model.js';
import EventType from '../models/eventType.model.js';
import Patient from '../../patients/models/patient.model.js';

/**
 * Campi per il filtro row-level RBAC.
 * `calendarId` è l'id dell'utente proprietario del calendario: è l'owner dell'appuntamento.
 * `structureId` è nullable sugli eventi storici, quindi restano visibili a scope struttura.
 */
const AGENDA_SCOPE_FIELDS = {
    ownerField: 'calendarId',
    structureField: 'structureId',
    includeUnassigned: true
};

// Simple RFC-4122 UUID matcher used to reject malformed ids (e.g. a stray numeric
// placeholder like `1`) with a clean 400 instead of letting Postgres blow up with
// "invalid input syntax for type uuid" (which the generic error handler turns into
// an opaque 500).
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const eventDashboardWithFilter = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const startDate = new Date(req.query.startDate as string);
    const endDate = new Date(req.query.endDate as string);

    const agendaEvents = await AgendaEvent.schema(schema).findAll({
        where: { start: { [Op.between]: [startDate, endDate] }, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) },
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
        where: { start: { [Op.between]: [startDate, endDate] }, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) }
    });

    return sendSuccessResponse(res, 200, { agendaEvents }, 'Agenda events loaded');
});

export const findAgendaEventsByUsers = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const calendarIds = ((req.query.calendarIds as string) || '').split(',').filter(Boolean);

    // I calendari richiesti vengono comunque intersecati con quelli visibili allo scope.
    const agendaEvents = await AgendaEvent.schema(schema).findAll({
        where: { calendarId: { [Op.or]: calendarIds }, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) }
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

    if (!patientId || !UUID_REGEX.test(patientId)) {
        return sendErrorResponse(res, 400, 'Invalid or missing patientId');
    }

    // Il paziente deve rientrare nello scope: altrimenti si rivelerebbe la sua esistenza.
    const patient = await Patient.schema(schema).findOne({
        where: {
            id: patientId,
            ...scopeWhere(req, { ownerField: 'userId', structureField: 'structureId', includeUnassigned: true })
        }
    });
    if (!patient) {
        return sendErrorResponse(res, 404, 'Patient not found');
    }

    const agendaEvents = await AgendaEvent.schema(schema).findAll({
        where: { patient: { id: patientId } as any, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) }
    });

    return sendSuccessResponse(res, 200, { agendaEvents }, 'Agenda events loaded');
});

export const findAllHolidays = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;

    const agendaEvents = await AgendaEvent.schema(schema).findAll({
        where: {
            [Op.and]: [
                { [Op.or]: [{ title: 'Ferie' }, { title: 'Permesso' }] },
                scopeWhere(req, AGENDA_SCOPE_FIELDS)
            ]
        }
    });

    return sendSuccessResponse(res, 200, { agendaEvents }, 'Holidays loaded');
});

export const saveAgendaEvent = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const payload = { ...req.body.agendaEvent };

    // Chi gestisce solo la propria agenda non può creare eventi nel calendario di altri.
    if (req.access?.scope === 'own') {
        payload.calendarId = req.access.userId;
    }
    // Traccia la struttura in cui si svolge l'appuntamento: senza, lo scope `structure`
    // non potrebbe distinguere le sedi.
    if (!payload.structureId && req.access?.structureId) {
        payload.structureId = req.access.structureId;
    }

    const agendaEvent = await AgendaEvent.schema(schema).create(payload);

    const patient: any = agendaEvent.get('patient');
    if (patient?.emails?.length > 0 && patient.emails[0]?.email) {
        // Fire-and-forget: un SMTP non configurato/irraggiungibile non deve far fallire la
        // creazione dell'appuntamento (già salvato correttamente a DB), stessa logica usata
        // per signup/forgot-password in email.service.ts.
        sendNewEventMail(agendaEvent.get({ plain: true })).catch((err) => {
            console.error('[saveAgendaEvent] notification email could not be sent:', err);
        });
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

    const [rowsUpdated] = await AgendaEvent.schema(schema).update(event, {
        where: { id, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) }
    });
    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, `Error updating agendaEvent with id=${id}`);
    }

    const updated = await AgendaEvent.schema(schema).findByPk(id);
    return sendSuccessResponse(res, 200, updated, 'Agenda event updated');
});

export const deleteAgendaEvent = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.query.id as string;

    const removed = await AgendaEvent.schema(schema).destroy({
        where: { id, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) }
    });
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

    // Gate di accesso: se la serie non rientra nello scope, l'operazione si ferma qui.
    // Le modifiche successive agiscono tutte sullo stesso `recurringEventId`.
    const recurringEvent = await AgendaEvent.schema(schema).findOne({
        where: { id: event.recurringEventId, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) }
    });
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

    // Gate di accesso valido per tutti i mode: anche la cancellazione di una singola
    // occorrenza (che crea solo un'eccezione) deve agire su una serie visibile.
    const series = await AgendaEvent.schema(schema).findOne({
        where: { id: event.recurringEventId, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) }
    });
    if (!series) {
        return sendErrorResponse(res, 404, 'Recurring event not found');
    }

    if (mode === 'single') {
        await AgendaEventException.schema(schema).create({
            eventId: event.recurringEventId,
            exdate: moment(event.start).toISOString()
        });
        return sendSuccessResponse(res, 201, true, 'Recurring event deleted (single)');
    }

    if (mode === 'future') {
        const eventFound: any = series.get({ plain: true });
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

