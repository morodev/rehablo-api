export const AVAILABILITY_MODES = ['INHERIT_STRUCTURE', 'CUSTOM'] as const;
export type AvailabilityMode = (typeof AVAILABILITY_MODES)[number];

export interface AvailabilityDayInput {
    id?: string;
    day: number;
    enabled: boolean;
    rangeOneStart?: string | null;
    rangeOneFinish?: string | null;
    rangeTwoStart?: string | null;
    rangeTwoFinish?: string | null;
    rangeThreeStart?: string | null;
    rangeThreeFinish?: string | null;
    rangeFourStart?: string | null;
    rangeFourFinish?: string | null;
}

export interface StructureAvailabilityInput {
    day: number;
    enabled: boolean | null;
    open: string | null;
    close: string | null;
}

export class AvailabilityValidationError extends Error {}

const RANGE_FIELDS = [
    ['rangeOneStart', 'rangeOneFinish'],
    ['rangeTwoStart', 'rangeTwoFinish'],
    ['rangeThreeStart', 'rangeThreeFinish'],
    ['rangeFourStart', 'rangeFourFinish']
] as const;

const DAY_NAMES = [
    'lunedì',
    'martedì',
    'mercoledì',
    'giovedì',
    'venerdì',
    'sabato',
    'domenica'
] as const;

export function isAvailabilityMode(value: unknown): value is AvailabilityMode {
    return typeof value === 'string' && (AVAILABILITY_MODES as readonly string[]).includes(value);
}

export function normalizeAvailabilitySchedule(
    value: unknown,
    mode: AvailabilityMode,
    structureSchedule: readonly StructureAvailabilityInput[] = []
): AvailabilityDayInput[] {
    // In modalita ereditata le fasce personali non fanno parte della configurazione
    // attiva. Client meno recenti possono ancora inviare una bozza incompleta: va
    // ignorata, non validata come se fosse un orario personalizzato.
    if (mode === 'INHERIT_STRUCTURE') {
        return emptyAvailabilitySchedule();
    }

    if (!Array.isArray(value)) {
        throw new AvailabilityValidationError('La disponibilità settimanale deve essere un array');
    }
    if (value.length !== 7) {
        throw new AvailabilityValidationError('La disponibilità deve contenere esattamente sette giorni');
    }

    const byDay = new Map<number, any>();
    for (const raw of value) {
        const day = Number(raw?.day);
        if (!Number.isInteger(day) || day < 0 || day > 6 || byDay.has(day)) {
            throw new AvailabilityValidationError('I giorni della disponibilità non sono validi o sono duplicati');
        }
        byDay.set(day, raw ?? {});
    }

    const openings = new Map(structureSchedule.map((entry) => [Number(entry.day), entry]));
    return Array.from({length: 7}, (_, day) => {
        const raw = byDay.get(day);
        if (!raw) {
            throw new AvailabilityValidationError(`Manca la disponibilità di ${DAY_NAMES[day]}`);
        }

        const enabled = raw.enabled === true;
        const normalized: AvailabilityDayInput = {
            day,
            enabled,
            rangeOneStart: null,
            rangeOneFinish: null,
            rangeTwoStart: null,
            rangeTwoFinish: null,
            rangeThreeStart: null,
            rangeThreeFinish: null,
            rangeFourStart: null,
            rangeFourFinish: null
        };
        if (!enabled) return normalized;

        const opening = openings.get(day);
        const openingStart = opening?.enabled ? timeToMinutes(opening.open) : null;
        const openingEnd = opening?.enabled ? timeToMinutes(opening.close) : null;
        if (mode === 'CUSTOM' && (openingStart === null || openingEnd === null)) {
            throw new AvailabilityValidationError(`La sede è chiusa di ${DAY_NAMES[day]}`);
        }

        const ranges: Array<{start: number; end: number}> = [];
        RANGE_FIELDS.forEach(([startField, endField], index) => {
            const rawStart = raw[startField];
            const rawEnd = raw[endField];
            const hasStart = rawStart !== null && rawStart !== undefined && rawStart !== '';
            const hasEnd = rawEnd !== null && rawEnd !== undefined && rawEnd !== '';
            if (index === 0 && (!hasStart || !hasEnd)) {
                throw new AvailabilityValidationError(`La prima fascia di ${DAY_NAMES[day]} è obbligatoria`);
            }
            if (hasStart !== hasEnd) {
                throw new AvailabilityValidationError(`La fascia ${index + 1} di ${DAY_NAMES[day]} è incompleta`);
            }
            if (!hasStart) return;

            const start = timeToMinutes(rawStart);
            const end = timeToMinutes(rawEnd);
            if (start === null || end === null || start >= end) {
                throw new AvailabilityValidationError(`La fascia ${index + 1} di ${DAY_NAMES[day]} non è valida`);
            }
            if (
                mode === 'CUSTOM' &&
                openingStart !== null &&
                openingEnd !== null &&
                (start < openingStart || end > openingEnd)
            ) {
                throw new AvailabilityValidationError(`La fascia ${index + 1} di ${DAY_NAMES[day]} supera l'orario della sede`);
            }

            ranges.push({start, end});
        });

        const ordered = [...ranges].sort((first, second) => first.start - second.start);
        for (let index = 1; index < ordered.length; index++) {
            if (ordered[index].start < ordered[index - 1].end) {
                throw new AvailabilityValidationError(`Le fasce di ${DAY_NAMES[day]} si sovrappongono`);
            }
        }
        ordered.forEach((range, index) => {
            const [startField, endField] = RANGE_FIELDS[index];
            normalized[startField] = minutesToTime(range.start);
            normalized[endField] = minutesToTime(range.end);
        });
        return normalized;
    });
}

export function emptyAvailabilitySchedule(): AvailabilityDayInput[] {
    return Array.from({length: 7}, (_, day) => ({
        day,
        enabled: false,
        rangeOneStart: null,
        rangeOneFinish: null,
        rangeTwoStart: null,
        rangeTwoFinish: null,
        rangeThreeStart: null,
        rangeThreeFinish: null,
        rangeFourStart: null,
        rangeFourFinish: null
    }));
}

function timeToMinutes(value: unknown): number | null {
    if (!value) return null;
    const match = String(value).match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return hours * 60 + minutes;
}

function minutesToTime(value: number): string {
    const hours = Math.floor(value / 60).toString().padStart(2, '0');
    const minutes = (value % 60).toString().padStart(2, '0');
    return `${hours}:${minutes}:00`;
}
