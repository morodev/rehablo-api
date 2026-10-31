import {ActivityError} from './activityErrors.js';

export interface ActivityRecurrenceRule {
    frequency: 'daily' | 'weekly'; interval: number; startsOn: string; endsOn: string | null;
}
export interface ActivityRecurrenceTemplate {
    title: string; description: string | null; priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
    assigneeIds: string[]; reviewerUserId: string | null; patientId: string | null; agendaEventId: string | null;
    checklist: Array<{text: string}>;
}
export interface ActivityRecurrenceState extends ActivityRecurrenceRule {
    status: 'active' | 'stopped' | 'ended'; nextDate: string | null;
    blockedReason: string | null; template: ActivityRecurrenceTemplate;
}

function invalid(field: string, message: string): never {
    throw new ActivityError('ACTIVITY_VALIDATION_FAILED', 422, message, {[field]: message});
}

export function recurrenceCivilDate(value: unknown, field: string): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return invalid(field, 'Indica una data valida nel formato anno-mese-giorno.');
    }
    const date = new Date(value + 'T00:00:00.000Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value < '0001-01-01') {
        return invalid(field, 'La data selezionata non esiste.');
    }
    return value;
}

export function parseActivityRecurrenceRule(value: unknown): ActivityRecurrenceRule {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('recurrence', 'Controlla la ripetizione.');
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some(key => !['frequency', 'interval', 'startsOn', 'endsOn'].includes(key))) {
        return invalid('recurrence', 'La ripetizione contiene campi non previsti.');
    }
    if (record.frequency !== 'daily' && record.frequency !== 'weekly') return invalid('recurrence.frequency', 'Scegli giorni o settimane.');
    if (!Number.isSafeInteger(record.interval) || Number(record.interval) < 1 || Number(record.interval) > 36500) {
        return invalid('recurrence.interval', 'Indica un intervallo intero fra 1 e 36500.');
    }
    const startsOn = recurrenceCivilDate(record.startsOn, 'recurrence.startsOn');
    const endsOn = record.endsOn == null ? null : recurrenceCivilDate(record.endsOn, 'recurrence.endsOn');
    if (endsOn && endsOn < startsOn) return invalid('recurrence.endsOn', 'Il termine non può precedere la prima esecuzione.');
    return {frequency: record.frequency, interval: Number(record.interval), startsOn, endsOn};
}

export function recurrenceLocalDate(instant: Date, timezone = 'Europe/Rome'): string {
    if (!Number.isFinite(instant.getTime())) throw new Error('Invalid recurrence clock');
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(instant)
        .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addRecurrenceDays(date: string, days: number): string {
    const result = new Date(recurrenceCivilDate(date, 'recurrence.startsOn') + 'T00:00:00.000Z');
    result.setUTCDate(result.getUTCDate() + days);
    if (!Number.isFinite(result.getTime()) || result.getUTCFullYear() > 9999 || result.getUTCFullYear() < 1) {
        return invalid('recurrence.interval', 'La prossima esecuzione supera le date supportate.');
    }
    return result.toISOString().slice(0, 10);
}

export function nextRecurrenceDate(rule: ActivityRecurrenceRule, date: string): string | null {
    const next = addRecurrenceDays(date, rule.interval * (rule.frequency === 'weekly' ? 7 : 1));
    return rule.endsOn && next > rule.endsOn ? null : next;
}

/** The date anchor never drifts when a delayed run or a late completion is recorded. */
export function recurrenceDateOnOrAfter(rule: ActivityRecurrenceRule, date: string): string | null {
    recurrenceCivilDate(date, 'recurrence.startsOn');
    const elapsed = Math.max(0, Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(rule.startsOn + 'T00:00:00Z')) / 86400000));
    const step = rule.interval * (rule.frequency === 'weekly' ? 7 : 1);
    const next = addRecurrenceDays(rule.startsOn, Math.ceil(elapsed / step) * step);
    return rule.endsOn && next > rule.endsOn ? null : next;
}

/** First instant outside the execution's local calendar day; days can be 23 or 25 hours. */
export function activityExecutionDeadline(date: string, timezone = 'Europe/Rome'): Date {
    const next = addRecurrenceDays(date, 1);
    const wallEpoch = Date.parse(next + 'T00:00:00.000Z');
    const formatter = new Intl.DateTimeFormat('en-GB', {timeZone: timezone, year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
    let instant = wallEpoch;
    for (let attempt = 0; attempt < 5; attempt++) {
        const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).filter(part => part.type !== 'literal')
            .map(part => [part.type, Number(part.value)]));
        const local = new Date(0);
        local.setUTCFullYear(parts.year, parts.month - 1, parts.day);
        local.setUTCHours(parts.hour, parts.minute, parts.second, 0);
        const delta = wallEpoch - local.getTime();
        if (delta === 0) return new Date(instant);
        instant += delta;
    }
    throw new Error('Cannot resolve recurrence calendar deadline');
}

export function recurrenceOutcome(status: string, reviewStatus: string, checked: number, total: number): string {
    if (status === 'COMPLETED') return 'completed';
    if (reviewStatus === 'pending') return 'pending_review';
    if (checked > 0 || status === 'IN_PROGRESS' || status === 'WAITING') return 'partial';
    return 'not_recorded';
}
