/** Validate explicit reopening against the locked appointment, never a client snapshot. */
export function appointmentRescheduleError(
    current: Record<string, any>, patch: Record<string, any>, reopenForReschedule: boolean, now = Date.now()
): string | null {
    const completed = String(current.status ?? '').trim().toUpperCase() === 'COMPLETED';
    const patient = !!(current.patientId || current.patient?.id) && current.kind !== 'TIME_OFF';
    const recurring = !!(current.recurrence || current.recurringEventId);
    const start = Date.parse(String(patch.start ?? current.start ?? ''));
    const originalStart = Date.parse(String(current.start ?? ''));
    // Agenda edits normalize seconds; only a different calendar minute is a reschedule.
    const changedStart = Number.isFinite(start) && Number.isFinite(originalStart)
        && Math.floor(start / 60_000) !== Math.floor(originalStart / 60_000);
    const futureMove = changedStart && Math.floor(start / 60_000) > Math.floor(now / 60_000);
    if (reopenForReschedule) {
        if (!patient || recurring || patch.recurrence || patch.recurringEventId) {
            return 'La riapertura per riprogrammazione richiede un appuntamento singolo con paziente.';
        }
        if (!completed) return 'Lo stato dell’appuntamento è cambiato. Ricarica l’agenda prima di riprogrammarlo.';
        const end = Date.parse(String(patch.end ?? ''));
        if (!futureMove || !Number.isFinite(end) || end <= start
            || String(patch.status ?? '').trim().toUpperCase() !== 'CONFIRMED') {
            return 'Conferma la riapertura con un nuovo orario futuro e una durata valida.';
        }
        return null;
    }
    if (patient && !recurring && completed && futureMove) {
        return 'L’appuntamento risulta effettuato. Conferma la riapertura prima di spostarlo nel futuro.';
    }
    return null;
}
