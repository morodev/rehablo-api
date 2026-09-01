import { Request, Response } from 'express';
import { Op, fn, col } from 'sequelize';
import moment from 'moment';
import { sequelize } from '../../../config/database.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { scopeWhere } from '../../../middleware/rbac.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { sendNewEventMail } from '../../../services/email.service.js';
import AgendaEvent from '../models/agendaEvent.model.js';
import AgendaEventException from '../models/agendaEventException.model.js';
import EventType from '../models/eventType.model.js';
import Service from '../../products-services/models/service.model.js';
import Patient from '../../patients/models/patient.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import TimeOffRequest from '../models/timeOffRequest.model.js';
import { StructureUser, TenantUser, User } from '../../auth/models/index.js';
import { getInvoiceAgendaLinksByEventIds, getLinkedInvoiceId } from '../../invoice/services/invoiceAgendaEvent.service.js';
import {
    DeferredOperatorAssignment,
    InvalidDeferredOperatorReassignmentError,
    reassignDeferredOperatorAppointments
} from '../services/operatorReassignment.service.js';

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
const MISSED_ARRIVAL_GRACE_MS = 15 * 60_000;
const APPOINTMENT_STATUSES = new Set(['CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW']);
const MISSED_ARRIVAL_RESOLUTIONS = new Set(['ARRIVING', 'CANCELLED', 'NO_SHOW', 'COMPLETED']);
const NO_SHOW_BILLING_DECISIONS = new Set(['PENDING', 'WAIVED']);
const APPOINTMENT_PAYMENT_STATUSES = new Set(['unpaid', 'partial', 'paid']);
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const ATTENDANCE_MANAGED_FIELDS = [
    'missedArrivalReportedAt',
    'missedArrivalReportedBy',
    'missedArrivalResolvedAt',
    'missedArrivalResolvedBy',
    'missedArrivalResolution',
    'noShowBillingDecision'
] as const;
const APPOINTMENT_PAYMENT_MANAGED_FIELDS = [
    'appointmentPaymentStatus',
    'appointmentPaidAmount',
    'appointmentPaidAt',
    'appointmentPaymentMethod',
    'appointmentPaymentNote',
    'appointmentPaymentRecordedBy'
] as const;

function removeAttendanceManagedFields(payload: Record<string, any>): void {
    ATTENDANCE_MANAGED_FIELDS.forEach((field) => delete payload[field]);
}

function removeAppointmentPaymentManagedFields(payload: Record<string, any>): void {
    APPOINTMENT_PAYMENT_MANAGED_FIELDS.forEach((field) => delete payload[field]);
}

type AppointmentPriceSource = 'SERVICE' | 'EVENT_TYPE' | null;
interface AppointmentPrice {
    amount: number | null;
    source: AppointmentPriceSource;
}

const roundMoney = (value: unknown): number => Math.round(Number(value) * 100) / 100;

function isValidDateOnly(value: unknown): value is string {
    if (typeof value !== 'string' || !DATE_ONLY_REGEX.test(value)) return false;
    const parsed = new Date(`${value}T12:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function todayInRome(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
}

/** Risolve in blocco il prezzo autorevole: servizio collegato, altrimenti prezzo del tipo legacy. */
async function appointmentPricesByEvent(
    schema: string,
    events: Array<Record<string, any>>
): Promise<Map<string, AppointmentPrice>> {
    const eventTypeIds = [...new Set(events.map((event) => event.eventTypeId).filter(Boolean))] as string[];
    const eventTypes = eventTypeIds.length
        ? await EventType.schema(schema).findAll({ where: { id: { [Op.in]: eventTypeIds } } })
        : [];
    const eventTypeById = new Map(eventTypes.map((eventType) => [eventType.id, eventType]));
    const serviceIds = [...new Set(eventTypes.map((eventType) => eventType.linkedServiceId).filter(Boolean))] as string[];
    const services = serviceIds.length
        ? await Service.schema(schema).findAll({ where: { id: { [Op.in]: serviceIds } } })
        : [];
    const serviceById = new Map(services.map((service) => [service.id, service]));

    return new Map<string, AppointmentPrice>(events.map((event): [string, AppointmentPrice] => {
        const eventType = event.eventTypeId ? eventTypeById.get(event.eventTypeId) : null;
        if (eventType?.linkedServiceId) {
            const service = serviceById.get(eventType.linkedServiceId);
            const servicePrice = Number(service?.sellingPrice);
            return [event.id, {
                amount: Number.isFinite(servicePrice) && servicePrice >= 0 ? roundMoney(servicePrice) : null,
                source: service ? 'SERVICE' : null
            }];
        }

        const eventTypePrice = Number(eventType?.price);
        return [event.id, {
            amount: Number.isFinite(eventTypePrice) && eventType?.price !== null && eventType?.price !== undefined
                ? roundMoney(eventTypePrice)
                : null,
            source: eventType?.price !== null && eventType?.price !== undefined ? 'EVENT_TYPE' : null
        }];
    }));
}

function normalizedStatus(value: unknown): string {
    return String(value ?? '').trim().toUpperCase();
}

function hasOpenMissedArrival(event: AgendaEvent): boolean {
    return Boolean(event.get('missedArrivalReportedAt')) && !event.get('missedArrivalResolvedAt');
}

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
    const eventIds = plainEvents.map((event) => event.id as string).filter(Boolean);
    const [links, appointmentPrices] = await Promise.all([
        getInvoiceAgendaLinksByEventIds(schema, eventIds),
        appointmentPricesByEvent(schema, plainEvents)
    ]);
    const linkedInvoiceByEventId = new Map(links.map((link) => [link.agendaEventId, link.invoiceId]));
    plainEvents.forEach((event) => {
        event.invoiceId = event.invoiceId ?? linkedInvoiceByEventId.get(event.id) ?? null;
        const price = appointmentPrices.get(event.id);
        event.appointmentExpectedAmount = price?.amount ?? null;
        event.appointmentPriceSource = price?.source ?? null;
    });
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
    // Keep a scalar reference for indexed reporting while preserving the immutable snapshot.
    event.patientId = plain.id;
    return false;
}

async function rejectOperatorOutsideStructure(
    req: Request,
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

    const [membership, identity, assignment] = await Promise.all([
        TenantUser.findOne({
            where: { tenantId: getCurrentTenantId(req), userId: calendarId }
        }),
        User.findByPk(calendarId, { attributes: ['id', 'deactivatedAt'] }),
        StructureUser.findOne({ where: { userId: calendarId, structureId } })
    ]);
    if (!membership) {
        sendErrorResponse(res, 409, 'L\'operatore non appartiene a questo studio');
        return true;
    }
    if (!identity || membership.deactivatedAt || identity.deactivatedAt) {
        sendErrorResponse(res, 409, 'L\'operatore e\' fuori dal team e non puo\' ricevere nuovi appuntamenti');
        return true;
    }
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
        where: {
            [Op.and]: [
                {
                    [Op.or]: [
                        { start: { [Op.between]: [startDate, endDate] } },
                        {
                            recurrence: { [Op.not]: null },
                            start: { [Op.lte]: endDate },
                            end: { [Op.gte]: startDate }
                        }
                    ]
                },
                scopeWhere(req, AGENDA_SCOPE_FIELDS)
            ]
        }
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
    removeAttendanceManagedFields(payload);
    removeAppointmentPaymentManagedFields(payload);

    if (payload.status !== undefined) {
        const status = normalizedStatus(payload.status);
        if (!APPOINTMENT_STATUSES.has(status) || status === 'NO_SHOW') {
            return sendErrorResponse(res, 400, 'Stato appuntamento non valido');
        }
        payload.status = status;
    }

    // Chi gestisce solo la propria agenda non può creare eventi nel calendario di altri.
    if (req.access?.scope === 'own') {
        payload.calendarId = req.access.userId;
    }
    // Traccia la struttura in cui si svolge l'appuntamento: senza, lo scope `structure`
    // non potrebbe distinguere le sedi.
    payload.structureId = req.access?.structureId ?? null;

    if (await rejectOperatorOutsideStructure(req, res, payload)) return;
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
    removeAttendanceManagedFields(event);
    removeAppointmentPaymentManagedFields(event);

    const current = await AgendaEvent.schema(schema).findOne({
        where: { id, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) }
    });
    if (!current) {
        return sendErrorResponse(res, 404, `Error updating agendaEvent with id=${id}`);
    }
    const linkedInvoiceId = await getLinkedInvoiceId(schema, current.id, current.get('invoiceId') as string | null);
    if (linkedInvoiceId) {
        return sendErrorResponse(
            res,
            409,
            'Appuntamento fatturato: modifica e cambio stato non sono consentiti',
            { invoiceId: linkedInvoiceId }
        );
    }

    if (event.status !== undefined) {
        const status = normalizedStatus(event.status);
        if (!APPOINTMENT_STATUSES.has(status)) {
            return sendErrorResponse(res, 400, 'Stato appuntamento non valido');
        }
        if (status === 'NO_SHOW' && normalizedStatus(current.get('status')) !== 'NO_SHOW') {
            return sendErrorResponse(res, 409, 'Usa la gestione del mancato arrivo per registrare un no-show');
        }
        event.status = status;

        // Compatibilita' con i client precedenti: se una segnalazione aperta viene chiusa
        // direttamente come effettuata o cancellata, manteniamo comunque l'audit completo.
        if (hasOpenMissedArrival(current) && (status === 'COMPLETED' || status === 'CANCELLED')) {
            event.missedArrivalResolvedAt = new Date();
            event.missedArrivalResolvedBy = req.access!.userId;
            event.missedArrivalResolution = status;
        }
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
    event.patientId = candidate.patientId;

    const scheduleChanged = ['calendarId', 'structureId', 'start', 'end', 'duration', 'recurrence']
        .some((field) => {
            if (!Object.prototype.hasOwnProperty.call(event, field)) return false;
            const incoming = event[field] ?? null;
            const existing = current.get(field as keyof AgendaEvent) ?? null;
            if (field === 'start' || field === 'end') {
                const incomingTime = Date.parse(String(incoming));
                const existingTime = Date.parse(String(existing));
                if (Number.isFinite(incomingTime) && Number.isFinite(existingTime)) {
                    return incomingTime !== existingTime;
                }
            }
            return String(incoming) !== String(existing);
        });
    if (scheduleChanged) {
        if (await rejectOperatorOutsideStructure(req, res, candidate)) return;
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

/**
 * Riassegna in blocco gli appuntamenti futuri rimasti sul calendario di un operatore
 * disattivato. Ogni elemento porta il proprio replacementUserId: la UI puo' quindi
 * assegnare un unico operatore a tutti oppure suddividere liberamente la selezione.
 */
export const reassignDeferredOperatorEvents = asyncHandler(async (req: Request, res: Response) => {
    const rawAssignments = req.body?.assignments;
    if (!Array.isArray(rawAssignments) || rawAssignments.length === 0 || rawAssignments.length > 500) {
        return sendErrorResponse(res, 400, 'Seleziona da 1 a 500 appuntamenti da riassegnare');
    }

    const assignments: DeferredOperatorAssignment[] = [];
    const uniqueTargets = new Set<string>();
    for (const raw of rawAssignments) {
        const eventId = typeof raw?.eventId === 'string' ? raw.eventId.trim() : '';
        const replacementUserId = typeof raw?.replacementUserId === 'string'
            ? raw.replacementUserId.trim()
            : '';
        const occurrenceStart = raw?.occurrenceStart == null
            ? null
            : String(raw.occurrenceStart);
        if (!UUID_REGEX.test(eventId) || !UUID_REGEX.test(replacementUserId)) {
            return sendErrorResponse(res, 400, 'Appuntamento o nuovo operatore non validi');
        }
        if (occurrenceStart && Number.isNaN(Date.parse(occurrenceStart))) {
            return sendErrorResponse(res, 400, 'Occorrenza ricorrente non valida');
        }

        const targetKey = `${eventId}:${occurrenceStart ?? ''}`;
        if (uniqueTargets.has(targetKey)) {
            return sendErrorResponse(res, 400, 'La selezione contiene appuntamenti duplicati');
        }
        uniqueTargets.add(targetKey);
        assignments.push({ eventId, occurrenceStart, replacementUserId });
    }

    try {
        const result = await sequelize.transaction((transaction) =>
            reassignDeferredOperatorAppointments(
                getCurrentTenantId(req),
                req.tenantSchema!,
                assignments,
                scopeWhere(req, AGENDA_SCOPE_FIELDS),
                transaction
            )
        );
        return sendSuccessResponse(
            res,
            200,
            result,
            result.reassignedAppointments === 1
                ? 'Appuntamento riassegnato'
                : `${result.reassignedAppointments} appuntamenti riassegnati`
        );
    } catch (error) {
        if (error instanceof InvalidDeferredOperatorReassignmentError) {
            return sendErrorResponse(res, 409, error.message);
        }
        throw error;
    }
});

/** Registra l'incasso della singola seduta senza creare o modificare una fattura. */
export const updateAppointmentPayment = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.agendaEventId;
    const requestedStatus = String(req.body?.status ?? '').trim().toLowerCase();

    if (!UUID_REGEX.test(id)) {
        return sendErrorResponse(res, 400, 'Appuntamento non valido');
    }
    if (!APPOINTMENT_PAYMENT_STATUSES.has(requestedStatus)) {
        return sendErrorResponse(res, 400, 'Stato incasso non valido');
    }

    const event = await AgendaEvent.schema(schema).findOne({
        where: { id, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) }
    });
    if (!event) {
        return sendErrorResponse(res, 404, 'Appuntamento non trovato o non accessibile');
    }
    if (event.get('recurrence') || event.get('recurringEventId')) {
        return sendErrorResponse(res, 422, 'Prima di registrare l\'incasso, separa la singola occorrenza dalla serie');
    }
    const linkedInvoiceId = await getLinkedInvoiceId(schema, event.id, event.get('invoiceId') as string | null);
    if (linkedInvoiceId) {
        return sendErrorResponse(res, 409, 'Appuntamento giÃ  fatturato: gestisci i pagamenti dalla fattura', { invoiceId: linkedInvoiceId });
    }
    const appointmentStatus = normalizedStatus(event.get('status'));
    if (!['CONFIRMED', 'COMPLETED'].includes(appointmentStatus)) {
        return sendErrorResponse(res, 409, 'L\'incasso Ã¨ disponibile solo per una seduta confermata o effettuata');
    }
    const patient = event.get('patient') as Record<string, unknown> | null;
    if (!event.get('patientId') && !patient?.id) {
        return sendErrorResponse(res, 422, 'L\'incasso richiede un appuntamento con paziente');
    }
    const startAt = Date.parse(String(event.get('start') ?? ''));
    if (!Number.isFinite(startAt) || startAt > Date.now()) {
        return sendErrorResponse(res, 409, 'Non Ã¨ possibile registrare l\'incasso di un appuntamento futuro');
    }

    if (requestedStatus === 'unpaid') {
        await event.update({
            appointmentPaymentStatus: 'unpaid',
            appointmentPaidAmount: null,
            appointmentPaidAt: null,
            appointmentPaymentMethod: null,
            appointmentPaymentNote: null,
            appointmentPaymentRecordedBy: req.access!.userId
        });
        const [decorated] = await withInvoiceStatus(schema, [event]);
        return sendSuccessResponse(res, 200, decorated, 'Incasso seduta rimosso');
    }

    const paidAt = req.body?.paidAt;
    if (!isValidDateOnly(paidAt)) {
        return sendErrorResponse(res, 400, 'La data dell\'incasso Ã¨ obbligatoria');
    }
    if (paidAt > todayInRome()) {
        return sendErrorResponse(res, 400, 'La data dell\'incasso non puÃ² essere futura');
    }

    const plainEvent = event.get({ plain: true }) as Record<string, any>;
    const expected = (await appointmentPricesByEvent(schema, [plainEvent])).get(event.id)
        ?? { amount: null, source: null };
    const rawAmount = req.body?.amount;
    const amount = (rawAmount === null || rawAmount === undefined || rawAmount === '') && requestedStatus === 'paid'
        ? expected.amount
        : roundMoney(rawAmount);
    if (amount === null || !Number.isFinite(amount) || amount <= 0) {
        return sendErrorResponse(res, 400, 'L\'importo dell\'incasso deve essere maggiore di zero');
    }
    if (expected.amount !== null && expected.amount > 0 && amount > expected.amount + 0.009) {
        return sendErrorResponse(
            res,
            409,
            `Il prezzo della seduta Ã¨ â‚¬ ${expected.amount.toFixed(2)}: l\'incasso non puÃ² essere superiore`,
            { expectedAmount: expected.amount, priceSource: expected.source }
        );
    }

    const method = typeof req.body?.method === 'string' ? req.body.method.trim() || null : null;
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() || null : null;
    if (method && method.length > 255) {
        return sendErrorResponse(res, 400, 'Metodo di pagamento troppo lungo');
    }
    if (note && note.length > 2000) {
        return sendErrorResponse(res, 400, 'Nota incasso troppo lunga');
    }

    const paymentStatus = expected.amount !== null && expected.amount > 0 && amount < expected.amount - 0.009
        ? 'partial'
        : 'paid';
    await event.update({
        appointmentPaymentStatus: paymentStatus,
        appointmentPaidAmount: amount,
        appointmentPaidAt: paidAt,
        appointmentPaymentMethod: method,
        appointmentPaymentNote: note,
        appointmentPaymentRecordedBy: req.access!.userId,
        ...(req.body?.markCompleted === true && appointmentStatus === 'CONFIRMED' ? { status: 'COMPLETED' } : {})
    });

    const [decorated] = await withInvoiceStatus(schema, [event]);
    return sendSuccessResponse(
        res,
        200,
        decorated,
        paymentStatus === 'partial' ? 'Acconto seduta registrato' : 'Incasso seduta registrato'
    );
});

/**
 * Apre un alert condiviso quando un appuntamento e' ancora confermato 15 minuti dopo l'inizio.
 * Non cambiamo automaticamente lo stato: potrebbe essere una seduta iniziata ma non ancora chiusa.
 */
export const reportMissedArrival = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.agendaEventId;
    if (!UUID_REGEX.test(id)) {
        return sendErrorResponse(res, 400, 'Appuntamento non valido');
    }

    const event = await AgendaEvent.schema(schema).findOne({
        where: { id, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) }
    });
    if (!event) {
        return sendErrorResponse(res, 404, 'Appuntamento non trovato o non accessibile');
    }
    if (event.get('recurrence')) {
        return sendErrorResponse(res, 422, 'Il mancato arrivo va registrato su un appuntamento singolo');
    }
    const linkedInvoiceId = await getLinkedInvoiceId(schema, event.id, event.get('invoiceId') as string | null);
    if (linkedInvoiceId) {
        return sendErrorResponse(res, 409, 'Appuntamento fatturato: segnalazione non consentita', { invoiceId: linkedInvoiceId });
    }
    if (normalizedStatus(event.get('status')) !== 'CONFIRMED') {
        return sendErrorResponse(res, 409, 'Il mancato arrivo si può segnalare solo su un appuntamento confermato');
    }
    const patient = event.get('patient') as Record<string, unknown> | null;
    if (!event.get('patientId') && !patient?.id) {
        return sendErrorResponse(res, 422, 'La segnalazione richiede un appuntamento con paziente');
    }
    const startAt = Date.parse(String(event.get('start') ?? ''));
    if (!Number.isFinite(startAt)) {
        return sendErrorResponse(res, 422, 'Orario di inizio appuntamento non valido');
    }
    const availableAt = startAt + MISSED_ARRIVAL_GRACE_MS;
    if (Date.now() < availableAt) {
        return sendErrorResponse(res, 409, 'Il mancato arrivo sarà segnalabile 15 minuti dopo l\'inizio', {
            availableAt: new Date(availableAt).toISOString()
        });
    }

    if (!hasOpenMissedArrival(event)) {
        await event.update({
            missedArrivalReportedAt: new Date(),
            missedArrivalReportedBy: req.access!.userId,
            missedArrivalResolvedAt: null,
            missedArrivalResolvedBy: null,
            missedArrivalResolution: null,
            noShowBillingDecision: null
        });
    }
    return sendSuccessResponse(res, 200, event, 'Mancato arrivo segnalato');
});

/** Chiude l'alert dopo il contatto e applica l'esito scelto dall'operatore. */
export const resolveMissedArrival = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.agendaEventId;
    const resolution = normalizedStatus(req.body.resolution);
    if (!UUID_REGEX.test(id)) {
        return sendErrorResponse(res, 400, 'Appuntamento non valido');
    }
    if (!MISSED_ARRIVAL_RESOLUTIONS.has(resolution)) {
        return sendErrorResponse(res, 400, 'Esito del contatto non valido');
    }

    const event = await AgendaEvent.schema(schema).findOne({
        where: { id, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) }
    });
    if (!event) {
        return sendErrorResponse(res, 404, 'Appuntamento non trovato o non accessibile');
    }
    const linkedInvoiceId = await getLinkedInvoiceId(schema, event.id, event.get('invoiceId') as string | null);
    if (linkedInvoiceId) {
        return sendErrorResponse(res, 409, 'Appuntamento fatturato: esito non modificabile', { invoiceId: linkedInvoiceId });
    }
    if (!hasOpenMissedArrival(event)) {
        return sendErrorResponse(res, 409, 'Non esiste una segnalazione di mancato arrivo aperta');
    }

    let noShowBillingDecision: string | null = null;
    if (resolution === 'NO_SHOW') {
        noShowBillingDecision = normalizedStatus(req.body.noShowBillingDecision || 'PENDING');
        if (!NO_SHOW_BILLING_DECISIONS.has(noShowBillingDecision)) {
            return sendErrorResponse(res, 400, 'Decisione di addebito no-show non valida');
        }
    }
    const status = resolution === 'ARRIVING' ? 'CONFIRMED' : resolution;
    await event.update({
        status,
        missedArrivalResolvedAt: new Date(),
        missedArrivalResolvedBy: req.access!.userId,
        missedArrivalResolution: resolution,
        noShowBillingDecision
    });

    return sendSuccessResponse(res, 200, event, 'Segnalazione di mancato arrivo chiusa');
});

/** Permette di cambiare la sola decisione economica senza alterare lo stato NO_SHOW. */
export const updateNoShowBillingDecision = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.agendaEventId;
    const decision = normalizedStatus(req.body.decision);
    if (!UUID_REGEX.test(id)) {
        return sendErrorResponse(res, 400, 'Appuntamento non valido');
    }
    if (!NO_SHOW_BILLING_DECISIONS.has(decision)) {
        return sendErrorResponse(res, 400, 'Decisione di addebito no-show non valida');
    }

    const event = await AgendaEvent.schema(schema).findOne({
        where: { id, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) }
    });
    if (!event) {
        return sendErrorResponse(res, 404, 'Appuntamento non trovato o non accessibile');
    }
    if (normalizedStatus(event.get('status')) !== 'NO_SHOW') {
        return sendErrorResponse(res, 409, 'La decisione economica è disponibile solo per i no-show');
    }
    const linkedInvoiceId = await getLinkedInvoiceId(schema, event.id, event.get('invoiceId') as string | null);
    if (linkedInvoiceId) {
        return sendErrorResponse(res, 409, 'Il no-show è già stato fatturato', { invoiceId: linkedInvoiceId });
    }

    await event.update({ noShowBillingDecision: decision });
    return sendSuccessResponse(res, 200, event, 'Decisione economica aggiornata');
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
    const linkedInvoiceId = await getLinkedInvoiceId(schema, current.id, current.get('invoiceId') as string | null);
    if (linkedInvoiceId) {
        return sendErrorResponse(
            res,
            409,
            'Appuntamento fatturato: eliminazione non consentita',
            { invoiceId: linkedInvoiceId }
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
    removeAttendanceManagedFields(event);
    if (event.status !== undefined) {
        const status = normalizedStatus(event.status);
        if (!APPOINTMENT_STATUSES.has(status) || status === 'NO_SHOW') {
            return sendErrorResponse(res, 400, 'Stato appuntamento non valido');
        }
        event.status = status;
    }

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
    if (await rejectOperatorOutsideStructure(req, res, recurringCandidate)) return;
    if (await rejectInvalidPatient(res, schema, recurringCandidate)) return;
    event.structureId = recurringCandidate.structureId;
    event.calendarId = recurringCandidate.calendarId;
    event.patient = recurringCandidate.patient;
    event.patientId = recurringCandidate.patientId;

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
    reassignDeferredOperatorEvents,
    findAgendaEventsByUsers,
    findAppointmentsForPatientById,
    updateAgendaEvent,
    updateAppointmentPayment,
    reportMissedArrival,
    resolveMissedArrival,
    updateNoShowBillingDecision,
    deleteAgendaEvent,
    getAllEventExceptions,
    updateRecurringEvent,
    deleteRecurringEvent,
    eventDashboardWithFilter,
    findAllHolidays
};

