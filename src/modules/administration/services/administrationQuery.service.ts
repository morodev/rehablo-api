const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ROME_TIME_ZONE = 'Europe/Rome';

export class AdministrationQueryError extends Error {
    readonly statusCode = 400;
}

export type AdministrationStructureSelection =
    | { kind: 'all' }
    | { kind: 'none' }
    | { kind: 'structure'; structureId: string };

export interface AdministrationAccess {
    scope?: 'own' | 'structure' | 'tenant';
    structureId?: string | null;
}

export interface AdministrationDateRange {
    from?: string;
    to?: string;
    fromInstant?: Date;
    toInstant?: Date;
}

function optionalText(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    return String(value).trim() || null;
}

export function parseAdministrationUuid(value: unknown, label = 'structureId'): string | null {
    const text = optionalText(value);
    if (!text) return null;
    if (!UUID_RE.test(text)) throw new AdministrationQueryError(`${label} non valido`);
    return text;
}

export function resolveAdministrationStructure(
    access: AdministrationAccess | null | undefined,
    requestedStructureId: unknown
): AdministrationStructureSelection {
    const requested = parseAdministrationUuid(requestedStructureId);
    if (access?.scope === 'tenant') {
        return requested ? { kind: 'structure', structureId: requested } : { kind: 'all' };
    }
    if (access?.scope === 'structure') {
        const selected = parseAdministrationUuid(access.structureId);
        return selected ? { kind: 'structure', structureId: selected } : { kind: 'none' };
    }
    return { kind: 'none' };
}

function parseDate(value: unknown, label: string): string | undefined {
    const text = optionalText(value);
    if (!text) return undefined;
    const match = DATE_RE.exec(text);
    if (!match) throw new AdministrationQueryError(`${label} deve essere nel formato YYYY-MM-DD`);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        throw new AdministrationQueryError(`${label} non valida`);
    }
    return text;
}

const romeDateParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ROME_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

function toRomeFloatingDate(actualDate: Date): Date {
    const parts = Object.fromEntries(
        romeDateParts.formatToParts(actualDate)
            .filter(part => part.type !== 'literal')
            .map(part => [part.type, Number(part.value)])
    ) as Record<string, number>;
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
}

export function romeDateBoundary(value: string, endOfDay: boolean): Date {
    const [year, month, day] = value.split('-').map(Number);
    const floating = new Date(Date.UTC(year, month - 1, day));
    if (endOfDay) floating.setUTCDate(floating.getUTCDate() + 1);
    const expected = floating.getTime();
    let guess = expected;
    for (let index = 0; index < 3; index++) {
        guess += expected - toRomeFloatingDate(new Date(guess)).getTime();
    }
    return new Date(guess - (endOfDay ? 1 : 0));
}

export function resolveAdministrationDateRange(fromValue: unknown, toValue: unknown): AdministrationDateRange {
    const from = parseDate(fromValue, 'from');
    const to = parseDate(toValue, 'to');
    if (from && to && from > to) throw new AdministrationQueryError('Il periodo selezionato non è valido');
    return {
        from,
        to,
        ...(from ? { fromInstant: romeDateBoundary(from, false) } : {}),
        ...(to ? { toInstant: romeDateBoundary(to, true) } : {})
    };
}

export function romeToday(): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: ROME_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
}
