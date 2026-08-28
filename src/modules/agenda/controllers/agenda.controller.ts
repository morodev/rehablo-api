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
import Invoice from '../../invoice/models/invoice.model.js';
import TimeOffRequest from '../models/timeOffRequest.model.js';
import { StructureUser } from '../../auth/models/index.js';

/**
 * Campi per il filtro row-level RBAC.
 * `calendarId` è l'id dell'utente proprietario del calendario: è l'owner dell'appuntamento.
 * `structureId` è nullable sugli eventi storici, quindi restano visibili a scope struttura.
 */
const AGENDA_SCOPE_FIELDS = {
    ownerField: 'calendarId',
    structureField: 'structureId',
    includeUnassigned: false
};

// Simple RFC-4122 UUID matcher used to reject malformed ids (e.g. a stray numeric
// placeholder like `1`) with a clean 400 instead of letting Postgres blow up with
// "invalid input syntax for type uuid" (which the generic error handler turns into
// an opaque 500).
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Aggiunge al feed dell'agenda soltanto lo stato necessario alla UI.
 * Le fatture vengono lette in blocco: una query per il feed, mai una query per appuntamento.
 */
async function withInvoiceStatus(
    schema: string,
    agendaEvents: AgendaEvent[]
): Promise<Record<string, any>[]> {
    const plainEvents = agendaEvents.map((event) =>
        event.get({ plain: true }) as Record<string, any>
    );
    const invoiceIds = Array.from(new Set(
        plainEvents
            .map((event) => event.invoiceId as string | null | undefined)
            .filter((invoiceId): invoiceId is string => !!invoiceId)
    ));

    if (invoiceIds.length === 0) {
        return plainEvents;
    }

    const invoices = await Invoice.schema(schema).findAll({
        where: { id: { [Op.in]: invoiceIds } },
        attributes: ['id', 'status']
    });
    const statusByInvoiceId = new Map(
        invoices.map((invoice) => [
            invoice.get('id') as string,
            invoice.get('status') as string | null
        ])
    );

    return plainEvents.map((event) => ({
        ...event,
        invoiceStatus: event.invoiceId
            ? statusByInvoiceId.get(event.invoiceId) ?? null
            : null
    }));
}

/**
 * Restituisce l'intervallo della singola occorrenza che si sta salvando.
 * Negli eventi ricorrenti `end` indica la fine della serie, quindi l'estremo
 * dell'occorrenza va ricavato da `duration`.
 */
function agendaOccurrenceInterval(event: Record<string, any>): { start: Date; end: Date } | null {
    const start = new Date(event.start);
    if (Number.isNaN(start.getTime())) return null;

    const duration = Number(event.duration);
    const end = event.recurrence && Number.isFinite(duration) && duration > 0
        ? new Date(start.getTime() + duration * 60_000)
        : new Date(event.end);

    if (Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) return null;
    return { start, end };
}

function isLegacyTimeOffEvent(event: Record<string, any>): boolean {
    const title = typeof event.title === 'string' ? event.title : event.title?.title;
    const patient = event.patient;
    const hasPatient = !!patient &&
        (typeof patient !== 'object' || Object.keys(patient).length > 0);
    return !hasPatient && (title === 'Ferie' || title === 'Permesso');
}

/**
 * Verifica che l'appuntamento punti a un paziente attivo della stessa sede e sostituisce
 * l'oggetto ricevuto dal client con uno snapshot minimo letto dal database.
 */
async function rejectInvalidPatient(
    res: Response,
    schema: string,
    event: Record<string, any>
): Promise<boolean> {
    if (isLegacyTimeOffEvent(event)) return false;

    const patientId = event.patient && typeof event.patient === 'object' ? event.patient.id : null;
    const structureId = event.structureId;
    if (!patientId || !structureId || !UUID_REGEX.test(patientId) || !UUID_REGEX.test(structureId)) {
        sendErrorResponse(res, 400, 'Paziente e sede sono obbligatori per un appuntamento');
        return true;
    }

    const patient = await Patient.schema(schema).findOne({
        where: { id: patientId, structureId, archivedAt: null }
    });
    if (!patient) {
        sendErrorResponse(res, 409, 'Il paziente non appartiene alla sede selezionata o è archiviato');
        return true;
    }

    const plain = patient.get({ plain: true });
    event.patient = {
        id: plain.id,
        name: plain.name,
        surname: plain.surname,
        fiscalCode: plain.fiscalCode,
        emails: plain.emails,
        phoneNumbers: plain.phoneNumbers
    };
    return false;
}

async function rejectOperatorOutsideStructure(
    res: Response,
    event: Record<string, any>
): Promise<boolean> {
    if (isLegacyTimeOffEvent(event)) return false;

    const calendarId = event.calendarId;
    const structureId = event.structureId;
    if (!calendarId || !structureId) {
        sendErrorResponse(res, 400, 'Operatore e sede sono obbligatori per un appuntamento');
        return true;
    }
    if (!UUID_REGEX.test(calendarId) || !UUID_REGEX.test(structureId)) {
        sendErrorResponse(res, 400, 'Operatore o sede non validi');
        return true;
    }

    const assignment = await StructureUser.findOne({ where: { userId: calendarId, structureId } });
    if (assignment) return false;

    sendErrorResponse(res, 409, 'L\'operatore non è assegnato alla sede selezionata');
    return true;
}

async function validateAndNormalizeEventType(
    schema: string,
    event: Record<string, any>
): Promise<string | null> {
    if (isLegacyTimeOffEvent(event) || event.eventTypeId === undefined || event.eventTypeId === null) {
        return null;
    }
    if (!UUID_REGEX.test(event.eventTypeId)) {
        return 'Tipo appuntamento non valido';
    }

    const eventType = await EventType.schema(schema).findByPk(event.eventTypeId);
    if (!eventType) {
        return 'Tipo appuntamento non trovato';
    }

    // Il titolo resta denormalizzato per la leggibilità dello storico, ma quando
    // esiste un id il valore autorevole è il tipo salvato nel tenant.
    event.title = eventType.title;
    return null;
}

async function findApprovedTimeOffConflict(
    schema: string,
    event: Record<string, any>,
    agendaEventId?: string
): Promise<TimeOffRequest | null> {
    // Compatibilita' con i vecchi client durante il rollout: gli AgendaEvent
    // Ferie/Permesso sono migrati nello stesso intervallo e non sono appuntamenti.
    if (isLegacyTimeOffEvent(event) || !event.calendarId) return null;

    const interval = agendaOccurrenceInterval(event);
    if (!interval) return null;

    const where: Record<string | symbol, any> = {
        userId: event.calendarId,
        status: 'APPROVED',
        start: { [Op.lt]: interval.end },
        end: { [Op.gt]: interval.start }
    };
    if (agendaEventId) {
        where[Op.or] = [
            { legacyAgendaEventId: null },
            { legacyAgendaEventId: { [Op.ne]: agendaEventId } }
        ];
    }

    return TimeOffRequest.schema(schema).findOne({ where });
}

async function rejectApprovedTimeOffConflict(
    res: Response,
    schema: string,
    event: Record<string, any>,
    agendaEventId?: string
): Promise<boolean> {
    const conflict = await findApprovedTimeOffConflict(schema, event, agendaEventId);
    if (!conflict) return false;

    sendErrorResponse(
        res,
        409,
        `L'operatore ha un'assenza approvata dal ${moment(conflict.start).format('DD/MM/YYYY HH:mm')} al ${moment(conflict.end).format('DD/MM/YYYY HH:mm')}`
    );
    return true;
}

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

    return sendSuccessResponse(
        res,
        200,
        { agendaEvents: await withInvoiceStatus(schema, agendaEvents) },
        'Agenda events loaded'
    );
});

export const findAgendaEventsByUsers = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const calendarIds = ((req.query.calendarIds as string) || '').split(',').filter(Boolean);

    // I calendari richiesti vengono comunque intersecati con quelli visibili allo scope.
    const agendaEvents = await AgendaEvent.schema(schema).findAll({
        where: { calendarId: { [Op.or]: calendarIds }, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) }
    });

    return sendSuccessResponse(
        res,
        200,
        { agendaEvents: await withInvoiceStatus(schema, agendaEvents) },
        'Agenda events loaded'
    );
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
            structureId: req.access?.structureId ?? null,
            archivedAt: null
        }
    });
    if (!patient) {
        return sendErrorResponse(res, 404, 'Patient not found');
    }

    const agendaEvents = await AgendaEvent.schema(schema).findAll({
        where: { patient: { id: patientId } as any, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) }
    });

    return sendSuccessResponse(
        res,
        200,
        { agendaEvents: await withInvoiceStatus(schema, agendaEvents) },
        'Agenda events loaded'
    );
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

    // Il collegamento fiscale e' server-managed dal controller fatture. In particolare,
    // copia/incolla di un appuntamento gia' fatturato non deve duplicarne invoiceId.
    delete payload.invoiceId;

    // Chi gestisce solo la propria agenda non può creare eventi nel calendario di altri.
    if (req.access?.scope === 'own') {
        payload.calendarId = req.access.userId;
    }
    // Traccia la struttura in cui si svolge l'appuntamento: senza, lo scope `structure`
    // non potrebbe distinguere le sedi.
    payload.structureId = req.access?.structureId ?? null;

    if (await rejectOperatorOutsideStructure(res, payload)) return;
    if (await rejectInvalidPatient(res, schema, payload)) return;

    const eventTypeError = await validateAndNormalizeEventType(schema, payload);
    if (eventTypeError) return sendErrorResponse(res, 400, eventTypeError);

    if (await rejectApprovedTimeOffConflict(res, schema, payload)) return;

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
    const event = { ...req.body.event };
    delete event.invoiceId;

    const current = await AgendaEvent.schema(schema).findOne({
        where: { id, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) }
    });
    if (!current) {
        return sendErrorResponse(res, 404, `Error updating agendaEvent with id=${id}`);
    }
    if (current.get('invoiceId')) {
        return sendErrorResponse(
            res,
            409,
            'Appuntamento fatturato: modifica e cambio stato non sono consentiti',
            { invoiceId: current.get('invoiceId') }
        );
    }

    if (typeof event.title !== 'string' && event.title !== undefined) {
        event.title = event.title?.title;
    }

    if (req.access?.scope === 'own') {
        event.calendarId = req.access.userId;
    }
    event.structureId = req.access?.structureId ?? current.get('structureId');

    const eventTypeError = await validateAndNormalizeEventType(schema, event);
    if (eventTypeError) return sendErrorResponse(res, 400, eventTypeError);

    const candidate = { ...current.get({ plain: true }), ...event };
    if (await rejectInvalidPatient(res, schema, candidate)) return;
    event.patient = candidate.patient;

    const scheduleChanged = ['calendarId', 'structureId', 'start', 'end', 'duration', 'recurrence']
        .some((field) => Object.prototype.hasOwnProperty.call(event, field));
    if (scheduleChanged) {
        if (await rejectOperatorOutsideStructure(res, candidate)) return;
        if (await rejectApprovedTimeOffConflict(res, schema, candidate, id)) return;
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

    const current = await AgendaEvent.schema(schema).findOne({
        where: { id, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) }
    });
    if (!current) {
        return sendErrorResponse(res, 404, 'Appuntamento non trovato');
    }
    if (current.get('invoiceId')) {
        return sendErrorResponse(
            res,
            409,
            'Appuntamento fatturato: eliminazione non consentita',
            { invoiceId: current.get('invoiceId') }
        );
    }

    await current.destroy();
    return sendSuccessResponse(res, 200, { removed: 1 }, 'Evento eliminato correttamente');
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
    const { event: requestedEvent, originalEvent, mode } = req.body;
    const event = { ...requestedEvent };
    delete event.invoiceId;

    // Gate di accesso: se la serie non rientra nello scope, l'operazione si ferma qui.
    // Le modifiche successive agiscono tutte sullo stesso `recurringEventId`.
    const recurringEvent = await AgendaEvent.schema(schema).findOne({
        where: { id: event.recurringEventId, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) }
    });
    if (!recurringEvent) {
        return sendErrorResponse(res, 404, 'Recurring event not found');
    }
    if (recurringEvent.get('invoiceId')) {
        return sendErrorResponse(res, 409, 'Serie fatturata: modifica non consentita');
    }

    const eventTypeError = await validateAndNormalizeEventType(schema, event);
    if (eventTypeError) return sendErrorResponse(res, 400, eventTypeError);

    const recurringCandidate = { ...recurringEvent.get({ plain: true }), ...event };
    recurringCandidate.structureId = req.access?.structureId ?? recurringCandidate.structureId;
    if (req.access?.scope === 'own') recurringCandidate.calendarId = req.access.userId;
    if (await rejectOperatorOutsideStructure(res, recurringCandidate)) return;
    if (await rejectInvalidPatient(res, schema, recurringCandidate)) return;
    event.structureId = recurringCandidate.structureId;
    event.calendarId = recurringCandidate.calendarId;
    event.patient = recurringCandidate.patient;

    if (mode === 'single') {
        const { range, recurringEventId, ...newEvent } = event;
        newEvent.id = undefined;
        newEvent.end = moment(newEvent.start).add(newEvent.duration, 'minutes').toISOString();
        newEvent.duration = null;
        newEvent.recurrence = null;

        if (await rejectApprovedTimeOffConflict(res, schema, newEvent)) return;

        await AgendaEvent.schema(schema).create(newEvent);
        await AgendaEventException.schema(schema).create({
            eventId: originalEvent.recurringEventId,
            exdate: moment(originalEvent.start).toISOString()
        });

        return sendSuccessResponse(res, 201, true, 'Recurring event updated (single)');
    }

    if (mode === 'future') {
        if (await rejectApprovedTimeOffConflict(res, schema, event, recurringEvent.id)) return;

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
        const candidate = { ...recurringEvent.get({ plain: true }), ...event };
        if (await rejectApprovedTimeOffConflict(res, schema, candidate, recurringEvent.id)) return;

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
    if (series.get('invoiceId')) {
        return sendErrorResponse(res, 409, 'Serie fatturata: eliminazione non consentita');
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

