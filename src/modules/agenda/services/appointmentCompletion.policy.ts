import type {AgendaEventAttributes} from '../models/agendaEvent.model.js';

export const AUTOMATIC_APPOINTMENT_COMPLETION_INTERVAL_MS = 30_000;
export const AUTOMATIC_APPOINTMENT_COMPLETION_LOOKBACK_MS = 24 * 60 * 60_000;

type AppointmentLike = Pick<
    AgendaEventAttributes,
    | 'start'
    | 'end'
    | 'duration'
    | 'status'
    | 'recurrence'
    | 'recurringEventId'
    | 'invoiceId'
    | 'carePackageId'
    | 'packageReservationStatus'
    | 'patientId'
    | 'patient'
    | 'missedArrivalReportedAt'
>;

export function appointmentEndAt(event: AppointmentLike): Date | null {
    const startAt = Date.parse(String(event.start ?? ''));
    if (!Number.isFinite(startAt)) return null;

    const explicitEndAt = Date.parse(String(event.end ?? ''));
    if (Number.isFinite(explicitEndAt) && explicitEndAt > startAt) {
        return new Date(explicitEndAt);
    }

    const durationMinutes = Number(event.duration);
    return Number.isFinite(durationMinutes) && durationMinutes > 0
        ? new Date(startAt + durationMinutes * 60_000)
        : null;
}

/**
 * Decide se completare un appuntamento terminato che non ha ricevuto alcun esito
 * o segnalazione esplicita.
 */
export function shouldAutoCompleteAppointment(
    event: AppointmentLike,
    now: Date = new Date()
): boolean {
    if (String(event.status ?? '').toUpperCase() !== 'CONFIRMED') return false;
    if (event.invoiceId || event.recurrence || event.recurringEventId || event.missedArrivalReportedAt) return false;
    if (event.carePackageId && event.packageReservationStatus !== 'RESERVED') return false;

    const patient = event.patient as Record<string, unknown> | null | undefined;
    if (!event.patientId && !patient?.id) return false;

    const end = appointmentEndAt(event);
    if (!end) return false;

    const elapsed = now.getTime() - end.getTime();
    return elapsed >= 0 && elapsed <= AUTOMATIC_APPOINTMENT_COMPLETION_LOOKBACK_MS;
}

/**
 * Riaprire manualmente una seduta gia' completata serve a correggerne la presenza.
 * La segnalazione impedisce al job automatico di completarla di nuovo prima che
 * l'operatore possa scegliere l'esito corretto.
 */
export function shouldOpenAttendanceCorrection(
    event: AppointmentLike,
    nextStatus: string,
    now: Date = new Date()
): boolean {
    if (String(event.status ?? '').toUpperCase() !== 'COMPLETED') return false;
    if (String(nextStatus ?? '').toUpperCase() !== 'CONFIRMED') return false;
    if (event.missedArrivalReportedAt) return false;

    const end = appointmentEndAt(event);
    return Boolean(end && now.getTime() >= end.getTime());
}

