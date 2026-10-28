import {createHash} from 'node:crypto';
import {quoteRecipient} from '../../administration/services/quoteContact.js';
import {expandAgendaSearchOccurrences} from './agendaSearch.service.js';

export type AppointmentReminderChannel = 'email' | 'whatsapp';
export type AppointmentReminderStatus = 'PREPARED' | 'PENDING' | 'SENT' | 'OPENED' | 'FAILED' | 'UNKNOWN';
export interface AppointmentReminderReference {eventId: string; occurrenceStart?: string | null}
export interface AppointmentReminderSummary {
    eventId: string;
    occurrenceStart: string | null;
    whatsapp: {available: boolean; unavailableReason: string | null; lastOpenedAt: string | null; error: string | null};
    email: {available: boolean; unavailableReason: string | null; lastSentAt: string | null; error: string | null; pending: boolean};
}
export interface ReminderOccurrence {
    eventId: string; occurrenceStart: string | null; occurrenceKey: string;
    start: string; patientId: string | null; structureId: string | null; snapshotHash: string;
}
export class AppointmentReminderError extends Error {
    constructor(public readonly statusCode: number, message: string) {super(message);}
}
export const REMINDER_PENDING_TTL_MS = 2 * 60_000;
export const REMINDER_UNKNOWN_ERROR = 'Esito email non verificabile. Controlla la posta inviata prima di reinviare.';

/** Validate the concrete occurrence against the current recurrence and exceptions, including DST. */
export function reminderOccurrence(event: Record<string, any>, requested: unknown,
    exceptions: Array<{eventId?: string | null; exdate?: string | null}> = []): ReminderOccurrence {
    const start = new Date(String(event.start ?? ''));
    if (!Number.isFinite(start.getTime())) throw new AppointmentReminderError(422, 'Orario appuntamento non valido');
    const recurring = !!String(event.recurrence ?? '').trim();
    let concreteStart = start;
    if (recurring) {
        concreteStart = new Date(String(requested ?? ''));
        if (!Number.isFinite(concreteStart.getTime())) throw new AppointmentReminderError(422, 'Seleziona una singola occorrenza della serie');
        const occurrences = expandAgendaSearchOccurrences([event], exceptions, concreteStart, concreteStart);
        if (!occurrences.some(item => new Date(item.start).getTime() === concreteStart.getTime())) {
            throw new AppointmentReminderError(409, 'Questa occorrenza non è più disponibile. Ricarica l’agenda.');
        }
    } else if (requested != null && new Date(String(requested)).getTime() !== start.getTime()) {
        throw new AppointmentReminderError(409, 'L’orario dell’appuntamento è cambiato. Ricarica l’agenda.');
    }
    const occurrenceStart = recurring ? concreteStart.toISOString() : null;
    const patientId = event.patientId ?? event.patient?.id ?? null;
    const structureId = event.structureId ?? null;
    return {eventId: String(event.id), occurrenceStart, occurrenceKey: occurrenceStart ?? 'single',
        start: concreteStart.toISOString(), patientId, structureId,
        snapshotHash: createHash('sha256').update(JSON.stringify({patientId, structureId, start: concreteStart.toISOString()})).digest('hex')};
}

export function reminderAvailability(event: Record<string, any>, patient: Record<string, any> | null,
    occurrence: ReminderOccurrence, channel: AppointmentReminderChannel, now = Date.now()): {available: boolean; unavailableReason: string | null; recipient: string | null} {
    let reason: string | null = null;
    if (event.kind === 'TIME_OFF' || !occurrence.patientId) reason = 'Appuntamento senza paziente';
    else if (String(event.status ?? '').toUpperCase() !== 'CONFIRMED') reason = 'Appuntamento non confermato';
    else if (Date.parse(occurrence.start) < now) reason = 'Appuntamento già iniziato';
    else if (!patient || patient.archivedAt) reason = 'Paziente non disponibile';
    else if (patient[channel === 'email' ? 'emailNotificationsConsent' : 'whatsappNotificationsConsent'] === false) {
        reason = channel === 'email' ? 'Comunicazioni email disabilitate' : 'Comunicazioni WhatsApp disabilitate';
    }
    const recipient = patient ? quoteRecipient(channel, null, patient) : null;
    if (!reason && !recipient) reason = channel === 'email' ? 'Email mancante o non valida' : 'Numero WhatsApp mancante o non valido';
    return {available: reason === null, unavailableReason: reason, recipient};
}

export function reminderMessage(patient: Record<string, any>, occurrence: ReminderOccurrence, premiseName?: string | null): string {
    const date = new Date(occurrence.start);
    const day = new Intl.DateTimeFormat('it-IT', {timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long'}).format(date);
    const hour = new Intl.DateTimeFormat('it-IT', {timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(date);
    const greeting = patient.name ? `Ciao ${patient.name},` : 'Buongiorno,';
    return `${greeting} ti ricordiamo l’appuntamento di ${day} alle ${hour}${premiseName ? ` presso ${premiseName}` : ''}.`
        + '\nSe hai un imprevisto avvisaci in anticipo. A presto!';
}

/** A failed resend never erases an earlier success; each channel belongs to this concrete appointment. */
export function summarizeAppointmentReminders(event: Record<string, any>, patient: Record<string, any> | null,
    occurrence: ReminderOccurrence, deliveries: Record<string, any>[], now = Date.now()): AppointmentReminderSummary {
    const entries = deliveries.filter(item => item.agendaEventId === occurrence.eventId && item.occurrenceKey === occurrence.occurrenceKey
        && item.snapshotHash === occurrence.snapshotHash)
        .sort((a, b) => Number(b.sequence ?? 0) - Number(a.sequence ?? 0)
            || Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)));
    const latest = (channel: string) => entries.find(item => item.channel === channel);
    const latestEmail = latest('email');
    const pending = latestEmail?.status === 'PENDING' && now - Date.parse(String(latestEmail.createdAt)) < REMINDER_PENDING_TTL_MS;
    const stale = latestEmail?.status === 'PENDING' && !pending;
    const availability = (channel: AppointmentReminderChannel) => {
        const {recipient, ...result} = reminderAvailability(event, patient, occurrence, channel, now);
        return result;
    };
    const timestamp = (channel: string, field: string): string | null => {
        const dates = entries.filter(item => item.channel === channel && item[field])
            .map(item => new Date(item[field]).toISOString()).sort();
        return dates.at(-1) ?? null;
    };
    return {eventId: occurrence.eventId, occurrenceStart: occurrence.occurrenceStart,
        whatsapp: {...availability('whatsapp'), lastOpenedAt: timestamp('whatsapp', 'openedAt'), error: latest('whatsapp')?.lastError ?? null},
        email: {...availability('email'), lastSentAt: timestamp('email', 'sentAt'), pending,
            error: stale || latestEmail?.status === 'UNKNOWN' ? REMINDER_UNKNOWN_ERROR : latestEmail?.lastError ?? null}};
}
