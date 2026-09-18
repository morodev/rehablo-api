import rrulePackage from 'rrule';

const {rrulestr} = rrulePackage;
const AGENDA_TIME_ZONE = 'Europe/Rome';
const agendaDateParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: AGENDA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
});

function parseDate(value: unknown): Date | null {
    const date = value ? new Date(value as string | number | Date) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
}

function utcRuleDate(date: Date): string {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function toAgendaFloatingDate(actualDate: Date): Date {
    const parts = Object.fromEntries(
        agendaDateParts
            .formatToParts(actualDate)
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, Number(part.value)])
    ) as Record<string, number>;
    return new Date(Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second
    ));
}

function fromAgendaFloatingDate(floatingDate: Date): Date {
    const expected = floatingDate.getTime();
    let guess = expected;
    for (let index = 0; index < 3; index++) {
        const representedLocalTime = toAgendaFloatingDate(new Date(guess)).getTime();
        guess += expected - representedLocalTime;
    }
    return new Date(guess);
}

/** Converte una data civile dell'agenda nei corretti estremi UTC di Europe/Rome. */
export function agendaDateBoundary(value: string, endOfDay: boolean): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const dayStart = new Date(Date.UTC(year, month - 1, day));
    if (dayStart.getUTCFullYear() !== year
        || dayStart.getUTCMonth() !== month - 1
        || dayStart.getUTCDate() !== day) return null;
    if (!endOfDay) return fromAgendaFloatingDate(dayStart);

    const nextDayStart = fromAgendaFloatingDate(new Date(dayStart.getTime() + 24 * 60 * 60_000));
    return new Date(nextDayStart.getTime() - 1);
}

function recurrenceParts(recurrence: string): string[] {
    return recurrence
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part && !part.startsWith('UNTIL=') && !part.startsWith('COUNT='));
}

function occurrenceId(eventId: string, start: Date): string {
    return `${eventId}_${utcRuleDate(start)}`;
}

/** Espande le serie con la stessa semantica floating-time usata dall'agenda. */
export function expandAgendaSearchOccurrences(
    events: Record<string, any>[],
    exceptions: Array<{eventId?: string | null; exdate?: string | null}>,
    from?: Date | null,
    to?: Date | null
): Record<string, any>[] {
    const exceptionsByEvent = new Map<string, Date[]>();
    for (const exception of exceptions) {
        const date = parseDate(exception.exdate);
        if (!exception.eventId || !date) continue;
        const current = exceptionsByEvent.get(exception.eventId) ?? [];
        current.push(date);
        exceptionsByEvent.set(exception.eventId, current);
    }

    const occurrences: Record<string, any>[] = [];
    for (const event of events) {
        const eventStart = parseDate(event.start);
        if (!eventStart) continue;

        if (!String(event.recurrence ?? '').trim()) {
            if (from && eventStart < from) continue;
            if (to && eventStart > to) continue;
            occurrences.push({
                ...event,
                agendaEventId: event.id,
                occurrenceStart: eventStart.toISOString()
            });
            continue;
        }

        const seriesEnd = parseDate(event.end);
        const duration = Number(event.duration);
        const parts = recurrenceParts(String(event.recurrence));
        if (!seriesEnd || !Number.isFinite(duration) || duration <= 0
            || !parts.some((part) => part.startsWith('FREQ='))) continue;

        const rangeStart = from && from > eventStart ? from : eventStart;
        const rangeEnd = to && to < seriesEnd ? to : seriesEnd;
        if (rangeStart > rangeEnd) continue;

        const lines = [
            `DTSTART:${utcRuleDate(toAgendaFloatingDate(eventStart))}`,
            `RRULE:${parts.join(';')};UNTIL=${utcRuleDate(toAgendaFloatingDate(seriesEnd))}`,
            ...(exceptionsByEvent.get(String(event.id)) ?? [])
                .map((date) => `EXDATE:${utcRuleDate(toAgendaFloatingDate(date))}`)
        ];

        try {
            const ruleSet = rrulestr(lines.join('\n'), {forceset: true});
            const starts = ruleSet.between(
                toAgendaFloatingDate(rangeStart),
                toAgendaFloatingDate(rangeEnd),
                true
            );
            for (const floatingStart of starts) {
                const start = fromAgendaFloatingDate(floatingStart);
                if (from && start < from || to && start > to) continue;
                occurrences.push({
                    ...event,
                    id: occurrenceId(String(event.id), start),
                    agendaEventId: event.id,
                    recurringEventId: event.id,
                    isFirstInstance: start.getTime() === eventStart.getTime(),
                    start: start.toISOString(),
                    end: new Date(start.getTime() + duration * 60_000).toISOString(),
                    duration,
                    occurrenceStart: start.toISOString()
                });
            }
        } catch {
            // Una regola legacy non valida non deve rendere inutilizzabile l'intera ricerca.
        }
    }
    return occurrences;
}
