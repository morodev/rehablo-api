export interface TimeOffRequestContent {
    type: unknown;
    start: unknown;
    end: unknown;
    allDay: unknown;
    reason: unknown;
}

function time(value: unknown): number | null {
    const parsed = value instanceof Date ? value.getTime() : new Date(value as string).getTime();
    return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
    const normalized = `${value ?? ''}`.trim();
    return normalized || null;
}

/**
 * Decide se una PATCH modifica davvero il contenuto approvato della richiesta.
 * Un payload equivalente non deve riaprire il workflow di approvazione.
 */
export function hasTimeOffRequestContentChanges(
    current: TimeOffRequestContent,
    next: TimeOffRequestContent
): boolean {
    return `${current.type ?? ''}` !== `${next.type ?? ''}`
        || time(current.start) !== time(next.start)
        || time(current.end) !== time(next.end)
        || Boolean(current.allDay) !== Boolean(next.allDay)
        || text(current.reason) !== text(next.reason);
}
