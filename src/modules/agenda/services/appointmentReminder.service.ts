import {Request} from 'express';
import {Model, Op, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {getSelectedStructureId, getUserId, scopeWhere} from '../../../middleware/rbac.js';
import AgendaEvent from '../models/agendaEvent.model.js';
import AgendaEventException from '../models/agendaEventException.model.js';
import AppointmentReminderDelivery from '../models/appointmentReminderDelivery.model.js';
import Patient from '../../patients/models/patient.model.js';
import Structure from '../../auth/models/structure.model.js';
import {
    AppointmentReminderChannel, AppointmentReminderError, AppointmentReminderReference, AppointmentReminderSummary,
    ReminderOccurrence, REMINDER_PENDING_TTL_MS, REMINDER_UNKNOWN_ERROR,
    reminderAvailability, reminderMessage, reminderOccurrence, summarizeAppointmentReminders
} from './appointmentReminder.policy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = {ownerField: 'calendarId', structureField: 'structureId', includeUnassigned: false};
const plain = (record: Model): Record<string, any> => record.get({plain: true});

function agendaScope(req: Request): Record<string | symbol, any> {
    const structureId = getSelectedStructureId(req);
    if (req.user?.actor === 'patient') throw new AppointmentReminderError(403, 'Operazione riservata agli operatori');
    if (!structureId) throw new AppointmentReminderError(422, 'Seleziona una sede');
    return {[Op.and]: [scopeWhere(req, fields), {structureId}]};
}

interface Context {record: AgendaEvent; event: Record<string, any>; patient: Record<string, any> | null; occurrence: ReminderOccurrence}
async function loadContext(req: Request, transaction?: Transaction): Promise<Context> {
    const eventId = req.params.agendaEventId;
    if (!UUID.test(eventId ?? '')) throw new AppointmentReminderError(404, 'Appuntamento non trovato');
    const record = await AgendaEvent.schema(req.tenantSchema!).findOne({
        where: {id: eventId, ...agendaScope(req)}, transaction,
        ...(transaction ? {lock: transaction.LOCK.UPDATE} : {})
    });
    if (!record) throw new AppointmentReminderError(404, 'Appuntamento non trovato');
    const event = plain(record);
    const patientId = event.patientId ?? event.patient?.id;
    const [patient, exceptions] = await Promise.all([
        UUID.test(patientId ?? '') ? Patient.schema(req.tenantSchema!).findOne({where: {id: patientId, archivedAt: null}, transaction}) : null,
        event.recurrence ? AgendaEventException.schema(req.tenantSchema!).findAll({where: {eventId}, transaction}) : []
    ]);
    return {record, event, patient: patient ? plain(patient) : null,
        occurrence: reminderOccurrence(event, req.body?.occurrenceStart, exceptions.map(row => plain(row)))};
}

async function summary(req: Request, context: Context): Promise<AppointmentReminderSummary> {
    const deliveries = await AppointmentReminderDelivery.schema(req.tenantSchema!).findAll({
        where: {agendaEventId: context.occurrence.eventId, occurrenceKey: context.occurrence.occurrenceKey},
        order: [['sequence', 'DESC']], limit: 500
    });
    return summarizeAppointmentReminders(context.event, context.patient, context.occurrence, deliveries.map(plain));
}

function assertAvailable(context: Context, channel: AppointmentReminderChannel): string {
    const availability = reminderAvailability(context.event, context.patient, context.occurrence, channel);
    if (!availability.available || !availability.recipient) throw new AppointmentReminderError(422, availability.unavailableReason ?? 'Canale non disponibile');
    return availability.recipient;
}

async function messageFor(req: Request, context: Context, transaction: Transaction): Promise<{message: string; centerName: string}> {
    const tenantId = req.user?.tid ?? req.user?.tenants?.[0]?.id;
    if (!tenantId || !context.occurrence.structureId) throw new AppointmentReminderError(422, 'Sede appuntamento non disponibile');
    const structure = await Structure.findOne({where: {id: context.occurrence.structureId, tenantId}, transaction});
    if (!structure) throw new AppointmentReminderError(422, 'Sede appuntamento non disponibile');
    const centerName = structure.get('name') || 'Il tuo centro';
    return {message: reminderMessage(context.patient!, context.occurrence, centerName), centerName};
}

function deliveryValues(req: Request, context: Context, channel: AppointmentReminderChannel, recipient: string, message: string): Record<string, any> {
    return {agendaEventId: context.occurrence.eventId, occurrenceKey: context.occurrence.occurrenceKey,
        occurrenceStart: context.occurrence.occurrenceStart, structureId: context.occurrence.structureId,
        patientId: context.occurrence.patientId, snapshotHash: context.occurrence.snapshotHash,
        channel, recipient, message, requestedBy: getUserId(req)};
}

/** Batch summaries use the current patient record; stale embedded snapshots never override refusals. */
export async function appointmentReminderSummaries(req: Request): Promise<AppointmentReminderSummary[]> {
    const references = req.body?.appointments as AppointmentReminderReference[];
    if (!Array.isArray(references) || references.length > 250 || references.some(item => !item || !UUID.test(item.eventId ?? '')
        || item.occurrenceStart != null && (typeof item.occurrenceStart !== 'string' || !Number.isFinite(Date.parse(item.occurrenceStart))))) {
        throw new AppointmentReminderError(400, 'Elenco appuntamenti non valido (massimo 250)');
    }
    const scope = agendaScope(req);
    if (!references.length) return [];
    const eventIds = [...new Set(references.map(item => item.eventId))];
    const records = await AgendaEvent.schema(req.tenantSchema!).findAll({where: {id: {[Op.in]: eventIds}, ...scope}});
    const events = records.map(plain);
    const patientIds = [...new Set(events.map(event => event.patientId ?? event.patient?.id).filter(id => UUID.test(id ?? '')))];
    const [patients, exceptions, deliveries] = await Promise.all([
        patientIds.length ? Patient.schema(req.tenantSchema!).findAll({where: {id: {[Op.in]: patientIds}, archivedAt: null}}) : [],
        AgendaEventException.schema(req.tenantSchema!).findAll({where: {eventId: {[Op.in]: eventIds}}}),
        AppointmentReminderDelivery.schema(req.tenantSchema!).findAll({where: {agendaEventId: {[Op.in]: events.map(item => item.id)}}})
    ]);
    const patientsById = new Map(patients.map(item => [String(item.get('id')), plain(item)] as const));
    const values = deliveries.map(plain), excluded = exceptions.map(plain);
    const unavailable = (reference: AppointmentReminderReference, reason: string): AppointmentReminderSummary => ({
        eventId: reference.eventId, occurrenceStart: reference.occurrenceStart ?? null,
        whatsapp: {available: false, unavailableReason: reason, error: null, lastOpenedAt: null},
        email: {available: false, unavailableReason: reason, error: null, lastSentAt: null, pending: false}
    });
    return references.flatMap(reference => {
        const event = events.find(item => item.id === reference.eventId);
        if (!event) return [unavailable(reference, 'Appuntamento non disponibile. Ricarica l’agenda.')];
        try {
            const occurrence = reminderOccurrence(event, reference.occurrenceStart, excluded);
            return [summarizeAppointmentReminders(event, patientsById.get(occurrence.patientId ?? '') ?? null, occurrence, values)];
        } catch (error) {
            if (!(error instanceof AppointmentReminderError)) throw error;
            return [unavailable(reference, error.message)];
        }
    });
}

export interface AppointmentReminderEmailInput {recipient: string; message: string; centerName: string}
/** SMTP is loaded only for real delivery. Tests replace this seam and never contact providers. */
export const appointmentReminderTransport = {send: async (input: AppointmentReminderEmailInput): Promise<void> => {
    const [{transporter}, {env}] = await Promise.all([import('../../../services/email.service.js'), import('../../../config/env.js')]);
    const result = await transporter.sendMail({from: {name: input.centerName, address: env.emailFrom},
        to: input.recipient, subject: `Promemoria appuntamento - ${input.centerName}`, text: input.message});
    if (!Array.isArray(result.accepted) || !result.accepted.some((entry: string | {address: string}) =>
        String(typeof entry === 'string' ? entry : entry.address).toLowerCase() === input.recipient.toLowerCase())) {
        throw Object.assign(new Error('Il server email non ha accettato il destinatario'), {code: 'EENVELOPE'});
    }
}};

function definiteEmailFailure(error: unknown): boolean {
    const value = error as {code?: string; command?: string; responseCode?: number};
    return ['EAUTH', 'EENVELOPE', 'ECONNREFUSED', 'ENOTFOUND'].includes(value?.code ?? '')
        || value?.command === 'CONN' || typeof value?.responseCode === 'number' && value.responseCode >= 400;
}

export async function sendAppointmentReminderEmail(req: Request): Promise<{summary: AppointmentReminderSummary}> {
    const key = String(req.header('Idempotency-Key') ?? '').trim();
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key)) throw new AppointmentReminderError(400, 'Idempotency-Key obbligatoria e non valida');
    const prepared = await sequelize.transaction(async transaction => {
        const context = await loadContext(req, transaction);
        const recipient = assertAvailable(context, 'email');
        const identity = {agendaEventId: context.occurrence.eventId, occurrenceKey: context.occurrence.occurrenceKey, channel: 'email'};
        const previous = await AppointmentReminderDelivery.schema(req.tenantSchema!).findOne({where: {...identity, idempotencyKey: key}, transaction});
        if (previous) {
            if (previous.get('snapshotHash') !== context.occurrence.snapshotHash) throw new AppointmentReminderError(409, 'L’appuntamento è cambiato. Ricarica l’agenda.');
            return {context, delivery: previous, replay: true, centerName: ''};
        }
        const pending = await AppointmentReminderDelivery.schema(req.tenantSchema!).findAll({where: {...identity, status: 'PENDING'}, transaction});
        for (const entry of pending) {
            if (Date.now() - new Date(entry.get('createdAt') as Date).getTime() < REMINDER_PENDING_TTL_MS) {
                throw new AppointmentReminderError(409, 'Invio email già in corso');
            }
            await entry.update({status: 'UNKNOWN', lastError: REMINDER_UNKNOWN_ERROR}, {transaction});
        }
        const {message, centerName} = await messageFor(req, context, transaction);
        const delivery = await AppointmentReminderDelivery.schema(req.tenantSchema!).create({
            ...deliveryValues(req, context, 'email', recipient, message), idempotencyKey: key, status: 'PENDING'
        }, {transaction});
        return {context, delivery, replay: false, centerName};
    });
    if (!prepared.replay) {
        try {
            await appointmentReminderTransport.send({recipient: String(prepared.delivery.get('recipient')),
                message: String(prepared.delivery.get('message')), centerName: prepared.centerName});
            await prepared.delivery.update({status: 'SENT', sentAt: new Date(), lastError: null});
        } catch (error) {
            const definite = definiteEmailFailure(error);
            await prepared.delivery.update({status: definite ? 'FAILED' : 'UNKNOWN',
                lastError: definite ? 'Email non inviata. Controlla l’indirizzo e riprova.' : REMINDER_UNKNOWN_ERROR});
        }
    }
    // Return a fresh view after delivery: changes to the patient or appointment are reflected immediately.
    const current = await loadContext(req);
    return {summary: await summary(req, current)};
}

export async function prepareAppointmentReminderWhatsApp(req: Request): Promise<{deliveryId: string; url: string}> {
    return sequelize.transaction(async transaction => {
        const context = await loadContext(req, transaction);
        const recipient = assertAvailable(context, 'whatsapp');
        const {message} = await messageFor(req, context, transaction);
        const delivery = await AppointmentReminderDelivery.schema(req.tenantSchema!).create({
            ...deliveryValues(req, context, 'whatsapp', recipient, message), status: 'PREPARED'
        }, {transaction});
        return {deliveryId: String(delivery.get('id')), url: `https://wa.me/${recipient.replace(/^\+/, '')}?text=${encodeURIComponent(message)}`};
    });
}

export async function markAppointmentReminderWhatsAppOpened(req: Request): Promise<{summary: AppointmentReminderSummary}> {
    if (!UUID.test(req.params.deliveryId ?? '')) throw new AppointmentReminderError(404, 'Apertura WhatsApp non trovata');
    const context = await sequelize.transaction(async transaction => {
        const current = await loadContext(req, transaction);
        const delivery = await AppointmentReminderDelivery.schema(req.tenantSchema!).findOne({
            where: {id: req.params.deliveryId, agendaEventId: current.occurrence.eventId, occurrenceKey: current.occurrence.occurrenceKey,
                channel: 'whatsapp', requestedBy: getUserId(req), snapshotHash: current.occurrence.snapshotHash}, transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!delivery) throw new AppointmentReminderError(404, 'Apertura WhatsApp non trovata');
        if (!delivery.get('openedAt')) {
            assertAvailable(current, 'whatsapp');
            if (Date.now() - new Date(delivery.get('createdAt') as Date).getTime() > 5 * 60_000) {
                throw new AppointmentReminderError(409, 'La preparazione WhatsApp è scaduta. Riapri la chat dall’agenda.');
            }
            await delivery.update({status: 'OPENED', openedAt: new Date(), lastError: null}, {transaction});
        }
        return current;
    });
    return {summary: await summary(req, context)};
}
