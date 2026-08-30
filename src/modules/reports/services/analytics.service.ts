import { Request } from 'express';
import { Op } from 'sequelize';
import rrulePackage from 'rrule';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import AgendaEventException from '../../agenda/models/agendaEventException.model.js';
import EventType from '../../agenda/models/eventType.model.js';
import TimeOffRequest from '../../agenda/models/timeOffRequest.model.js';
import { getInvoiceAgendaLinksByEventIds } from '../../invoice/services/invoiceAgendaEvent.service.js';
import {
    StructureAvailability,
    User,
    UserAvailability
} from '../../auth/models/index.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPORT_TIME_ZONE = 'Europe/Rome';
const DAY_MS = 86_400_000;
const { rrulestr } = rrulePackage;

export type AnalyticsGranularity = 'day' | 'week' | 'month';
export type AnalyticsCompare = 'none' | 'previous_period' | 'previous_year';

export interface AnalyticsQuery {
    from: string;
    to: string;
    granularity: AnalyticsGranularity;
    compare: AnalyticsCompare;
    structureId: string | null;
    operatorId: string | null;
    eventTypeId: string | null;
}

export interface ReportOccurrence {
    id: string;
    sourceEventId: string;
    occurrenceKey: string;
    start: Date;
    end: Date;
    durationMinutes: number;
    status: string;
    calendarId: string | null;
    structureId: string | null;
    patientId: string | null;
    eventTypeId: string | null;
    invoiceId: string | null;
    title: string | null;
    patientName: string;
}

export class AnalyticsQueryError extends Error {}

const localDateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
});
const localTimeFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: REPORT_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
});

export function localDateKey(date: Date): string {
    const parts = localDateFormatter.formatToParts(date);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
}

function currentLocalDate(): string {
    return localDateKey(new Date());
}

function addDays(date: string, days: number): string {
    const value = new Date(`${date}T12:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
    return Math.round(
        (Date.parse(`${to}T12:00:00.000Z`) - Date.parse(`${from}T12:00:00.000Z`)) / DAY_MS
    );
}

function defaultRange(): { from: string; to: string } {
    const to = currentLocalDate();
    return { from: `${to.slice(0, 7)}-01`, to };
}

export function parseAnalyticsQuery(req: Request): AnalyticsQuery {
    const defaults = defaultRange();
    const from = String(req.query.from ?? defaults.from);
    const to = String(req.query.to ?? defaults.to);
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
        throw new AnalyticsQueryError('Intervallo date non valido');
    }
    const dayCount = daysBetween(from, to) + 1;
    if (dayCount > 735) throw new AnalyticsQueryError('Il periodo massimo consentito è 24 mesi');

    const requestedGranularity = String(req.query.granularity ?? 'auto');
    const granularity: AnalyticsGranularity = requestedGranularity === 'auto'
        ? dayCount <= 31 ? 'day' : dayCount <= 180 ? 'week' : 'month'
        : requestedGranularity === 'day' || requestedGranularity === 'week' || requestedGranularity === 'month'
            ? requestedGranularity
            : (() => { throw new AnalyticsQueryError('Granularità non valida'); })();

    const requestedCompare = String(req.query.compare ?? 'previous_period');
    const compare: AnalyticsCompare = requestedCompare === 'none' || requestedCompare === 'previous_period' || requestedCompare === 'previous_year'
        ? requestedCompare
        : (() => { throw new AnalyticsQueryError('Confronto non valido'); })();

    const optionalUuid = (name: string): string | null => {
        const value = req.query[name];
        if (value == null || value === '') return null;
        if (typeof value !== 'string' || !UUID_RE.test(value)) {
            throw new AnalyticsQueryError(`${name} non valido`);
        }
        return value;
    };

    const requestedStructure = optionalUuid('structureId');
    const requestedOperator = optionalUuid('operatorId');
    const eventTypeId = optionalUuid('eventTypeId');
    const access = req.access!;

    let structureId = requestedStructure;
    let operatorId = requestedOperator;
    if (access.scope === 'structure') {
        if (requestedStructure && requestedStructure !== access.structureId) {
            throw new AnalyticsQueryError('La sede richiesta non è accessibile');
        }
        structureId = access.structureId;
    }
    if (access.scope === 'own') {
        if (requestedOperator && requestedOperator !== access.userId) {
            throw new AnalyticsQueryError('L’operatore richiesto non è accessibile');
        }
        operatorId = access.userId;
        structureId = access.structureId;
    }

    return { from, to, granularity, compare, structureId, operatorId, eventTypeId };
}

export function comparisonRange(query: AnalyticsQuery): AnalyticsQuery | null {
    if (query.compare === 'none') return null;
    if (query.compare === 'previous_year') {
        const previousYear = (date: string): string => {
            const year = Number(date.slice(0, 4)) - 1;
            const month = Number(date.slice(5, 7));
            const requestedDay = Number(date.slice(8, 10));
            const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
            return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(requestedDay, lastDay)).padStart(2, '0')}`;
        };
        return {
            ...query,
            from: previousYear(query.from),
            to: previousYear(query.to),
            compare: 'none'
        };
    }
    const length = daysBetween(query.from, query.to) + 1;
    return {
        ...query,
        from: addDays(query.from, -length),
        to: addDays(query.from, -1),
        compare: 'none'
    };
}

function utcRuleDate(date: Date): string {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function patientDisplayName(patient: unknown): string {
    if (!patient || typeof patient !== 'object') return '';
    const value = patient as Record<string, unknown>;
    return [value.name, value.surname].filter(Boolean).join(' ').trim();
}

function occurrenceDuration(event: Record<string, any>, start: Date): number {
    const explicit = Number(event.duration);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const end = event.end ? new Date(event.end) : null;
    if (end && !Number.isNaN(end.getTime()) && end > start) {
        return Math.max(Math.round((end.getTime() - start.getTime()) / 60_000), 0);
    }
    return 0;
}

function inDateRange(date: Date, query: AnalyticsQuery): boolean {
    const key = localDateKey(date);
    return key >= query.from && key <= query.to;
}

function eventToOccurrence(event: Record<string, any>, start: Date): ReportOccurrence {
    const durationMinutes = occurrenceDuration(event, start);
    const patientId = event.patientId ?? event.patient?.id ?? null;
    return {
        id: event.recurrence ? `${event.id}:${start.toISOString()}` : event.id,
        sourceEventId: event.id,
        occurrenceKey: start.toISOString(),
        start,
        end: new Date(start.getTime() + durationMinutes * 60_000),
        durationMinutes,
        status: String(event.status ?? 'CONFIRMED').toUpperCase(),
        calendarId: event.calendarId ?? null,
        structureId: event.structureId ?? null,
        patientId,
        eventTypeId: event.eventTypeId ?? null,
        invoiceId: event.invoiceId ?? null,
        title: typeof event.title === 'string' ? event.title : event.title?.title ?? null,
        patientName: patientDisplayName(event.patient)
    };
}

export function expandRecurringEvent(
    event: Record<string, any>,
    exceptionTimestamps: Set<number>,
    query: AnalyticsQuery
): ReportOccurrence[] {
    const start = new Date(event.start);
    if (Number.isNaN(start.getTime())) return [];
    if (!event.recurrence) return inDateRange(start, query) ? [eventToOccurrence(event, start)] : [];

    const paddedStart = new Date(`${query.from}T00:00:00.000Z`);
    paddedStart.setUTCHours(paddedStart.getUTCHours() - 3);
    const paddedEnd = new Date(`${query.to}T23:59:59.999Z`);
    paddedEnd.setUTCHours(paddedEnd.getUTCHours() + 3);
    try {
        const parts = String(event.recurrence)
            .split(';')
            .filter((part) => !part.startsWith('UNTIL=') && !part.startsWith('COUNT='));
        const seriesEnd = new Date(event.end);
        if (!Number.isNaN(seriesEnd.getTime())) parts.push(`UNTIL=${utcRuleDate(seriesEnd)}`);
        const rule = rrulestr(`DTSTART:${utcRuleDate(start)}\nRRULE:${parts.join(';')}`, { forceset: true });
        return rule
            .between(paddedStart, paddedEnd, true)
            .filter((date) => !exceptionTimestamps.has(date.getTime()) && inDateRange(date, query))
            .map((date) => eventToOccurrence(event, date));
    } catch (error) {
        console.error(`[analytics] RRULE non valida sull'evento ${event.id}`, error);
        return inDateRange(start, query) ? [eventToOccurrence(event, start)] : [];
    }
}

export async function loadOccurrences(
    schema: string,
    query: AnalyticsQuery
): Promise<ReportOccurrence[]> {
    // The stored timestamps are UTC while report days are Europe/Rome. A small padded SQL range
    // prevents losing appointments close to local midnight; `inDateRange` applies the exact cut.
    const paddedStart = new Date(`${query.from}T00:00:00.000Z`);
    paddedStart.setUTCHours(paddedStart.getUTCHours() - 3);
    const paddedEnd = new Date(`${query.to}T23:59:59.999Z`);
    paddedEnd.setUTCHours(paddedEnd.getUTCHours() + 3);
    const where: Record<string | symbol, any> = {
        [Op.or]: [
            { recurrence: null, start: { [Op.between]: [paddedStart.toISOString(), paddedEnd.toISOString()] } },
            { recurrence: { [Op.ne]: null }, start: { [Op.lte]: paddedEnd.toISOString() }, end: { [Op.gte]: paddedStart.toISOString() } }
        ]
    };
    if (query.structureId) where.structureId = query.structureId;
    if (query.operatorId) where.calendarId = query.operatorId;
    if (query.eventTypeId) where.eventTypeId = query.eventTypeId;

    const events = await AgendaEvent.schema(schema).findAll({ where });
    const plain = events.map((event) => event.get({ plain: true }) as Record<string, any>);
    const appointmentLinks = await getInvoiceAgendaLinksByEventIds(
        schema,
        plain.map((event) => event.id as string)
    );
    const invoiceByEventId = new Map(
        appointmentLinks.map((link) => [link.agendaEventId, link.invoiceId])
    );
    plain.forEach((event) => {
        event.invoiceId = event.invoiceId ?? invoiceByEventId.get(event.id) ?? null;
    });
    const seriesIds = plain.filter((event) => event.recurrence).map((event) => event.id);
    const exceptions = seriesIds.length
        ? await AgendaEventException.schema(schema).findAll({ where: { eventId: { [Op.in]: seriesIds } } })
        : [];
    const byEvent = new Map<string, Set<number>>();
    exceptions.forEach((exception) => {
        const eventId = exception.eventId;
        const parsed = exception.exdate ? Date.parse(exception.exdate) : Number.NaN;
        if (!eventId || !Number.isFinite(parsed)) return;
        const values = byEvent.get(eventId) ?? new Set<number>();
        values.add(parsed);
        byEvent.set(eventId, values);
    });

    return plain.flatMap((event) => expandRecurringEvent(event, byEvent.get(event.id) ?? new Set(), query));
}

function mondayOf(dateKey: string): string {
    const date = new Date(`${dateKey}T12:00:00.000Z`);
    const day = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - day);
    return date.toISOString().slice(0, 10);
}

export function bucketKey(date: Date, granularity: AnalyticsGranularity): string {
    const day = localDateKey(date);
    if (granularity === 'day') return day;
    if (granularity === 'week') return mondayOf(day);
    return day.slice(0, 7);
}

function blankActivityTotals() {
    return {
        total: 0,
        completed: 0,
        cancelled: 0,
        confirmed: 0,
        pastUnresolved: 0,
        deliveredMinutes: 0,
        cancellationRate: 0
    };
}

function accumulateActivity(target: ReturnType<typeof blankActivityTotals>, occurrence: ReportOccurrence) {
    target.total += 1;
    if (occurrence.status === 'COMPLETED') {
        target.completed += 1;
        target.deliveredMinutes += occurrence.durationMinutes;
    } else if (occurrence.status === 'CANCELLED') {
        target.cancelled += 1;
    } else {
        target.confirmed += 1;
        if (occurrence.end.getTime() < Date.now()) target.pastUnresolved += 1;
    }
}

function finishActivity(target: ReturnType<typeof blankActivityTotals>) {
    const denominator = target.completed + target.cancelled;
    target.cancellationRate = denominator ? Math.round((target.cancelled / denominator) * 10_000) / 100 : 0;
    target.deliveredMinutes = Math.round(target.deliveredMinutes);
    return target;
}

function rangesOfRow(row: Record<string, any>): Array<[number, number]> {
    const values = row.open != null
        ? [[row.open, row.close]]
        : [
            [row.rangeOneStart, row.rangeOneFinish],
            [row.rangeTwoStart, row.rangeTwoFinish],
            [row.rangeThreeStart, row.rangeThreeFinish],
            [row.rangeFourStart, row.rangeFourFinish]
        ];
    return values.flatMap(([start, end]) => {
        if (!start || !end) return [];
        const [sh, sm] = String(start).split(':').map(Number);
        const [eh, em] = String(end).split(':').map(Number);
        const from = sh * 60 + sm;
        const to = eh * 60 + em;
        return to > from ? [[from, to] as [number, number]] : [];
    });
}

function localMinute(date: Date): number {
    const parts = localTimeFormatter.formatToParts(date);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return Number(value.hour) * 60 + Number(value.minute);
}

async function operatorCapacity(
    schema: string,
    query: AnalyticsQuery,
    operatorIds: string[]
): Promise<Map<string, number | null>> {
    if (!query.structureId || operatorIds.length === 0) {
        return new Map(operatorIds.map((id) => [id, null]));
    }
    const [users, customRows, structureRows, approvedTimeOff] = await Promise.all([
        User.findAll({ where: { id: { [Op.in]: operatorIds } }, attributes: ['id', 'availabilityMode'] }),
        UserAvailability.findAll({ where: { userId: { [Op.in]: operatorIds } } }),
        StructureAvailability.findAll({ where: { structureId: query.structureId } }),
        TimeOffRequest.schema(schema).findAll({
            where: {
                structureId: query.structureId,
                userId: { [Op.in]: operatorIds },
                status: 'APPROVED',
                start: { [Op.lte]: new Date(Date.parse(`${query.to}T23:59:59.999Z`) + 3 * 3_600_000) },
                end: { [Op.gte]: new Date(Date.parse(`${query.from}T00:00:00.000Z`) - 3 * 3_600_000) }
            }
        })
    ]);
    const modeByUser = new Map(users.map((user) => [user.id, user.availabilityMode]));
    const customByUserDay = new Map<string, Record<string, any>>();
    customRows.forEach((row) => customByUserDay.set(`${row.userId}:${row.day}`, row.get({ plain: true })));
    const structureByDay = new Map(structureRows.map((row) => [row.day, row.get({ plain: true })]));
    const totals = new Map(operatorIds.map((id) => [id, 0 as number | null]));
    const schedule = new Map<string, Array<[number, number]>>();

    for (let date = query.from; date <= query.to; date = addDays(date, 1)) {
        const jsDay = new Date(`${date}T12:00:00.000Z`).getUTCDay();
        const day = (jsDay + 6) % 7;
        operatorIds.forEach((operatorId) => {
            const custom = modeByUser.get(operatorId) === 'CUSTOM';
            const row = custom ? customByUserDay.get(`${operatorId}:${day}`) : structureByDay.get(day);
            const ranges = row?.enabled ? rangesOfRow(row) : [];
            schedule.set(`${operatorId}:${date}`, ranges);
            const minutes = ranges.reduce((sum, [start, end]) => sum + end - start, 0);
            totals.set(operatorId, (totals.get(operatorId) ?? 0) + minutes);
        });
    }

    approvedTimeOff.forEach((row) => {
        const startKey = localDateKey(row.start);
        const endKey = localDateKey(row.end);
        const first = startKey < query.from ? query.from : startKey;
        const last = endKey > query.to ? query.to : endKey;
        let unavailableMinutes = 0;
        for (let date = first; date <= last; date = addDays(date, 1)) {
            const absenceStart = row.allDay || date > startKey ? 0 : localMinute(row.start);
            const absenceEnd = row.allDay || date < endKey ? 24 * 60 : localMinute(row.end);
            for (const [workStart, workEnd] of schedule.get(`${row.userId}:${date}`) ?? []) {
                unavailableMinutes += Math.max(Math.min(workEnd, absenceEnd) - Math.max(workStart, absenceStart), 0);
            }
        }
        totals.set(row.userId, Math.max((totals.get(row.userId) ?? 0) - unavailableMinutes, 0));
    });
    return totals;
}

export async function aggregateActivity(
    schema: string,
    query: AnalyticsQuery,
    occurrences?: ReportOccurrence[]
) {
    const rows = occurrences ?? await loadOccurrences(schema, query);
    const totals = blankActivityTotals();
    const series = new Map<string, ReturnType<typeof blankActivityTotals>>();
    const byOperator = new Map<string, ReturnType<typeof blankActivityTotals>>();
    const byType = new Map<string, ReturnType<typeof blankActivityTotals>>();

    rows.forEach((occurrence) => {
        accumulateActivity(totals, occurrence);
        const bucket = bucketKey(occurrence.start, query.granularity);
        const bucketTotals = series.get(bucket) ?? blankActivityTotals();
        accumulateActivity(bucketTotals, occurrence);
        series.set(bucket, bucketTotals);
        if (occurrence.calendarId) {
            const operatorTotals = byOperator.get(occurrence.calendarId) ?? blankActivityTotals();
            accumulateActivity(operatorTotals, occurrence);
            byOperator.set(occurrence.calendarId, operatorTotals);
        }
        const typeKey = occurrence.eventTypeId ?? `legacy:${occurrence.title ?? 'Altro'}`;
        const typeTotals = byType.get(typeKey) ?? blankActivityTotals();
        accumulateActivity(typeTotals, occurrence);
        byType.set(typeKey, typeTotals);
    });

    // A selected professional must still appear with zero values; an empty table would make it
    // impossible to distinguish "no activity" from a missing/failed filter.
    if (query.operatorId && !byOperator.has(query.operatorId)) {
        byOperator.set(query.operatorId, blankActivityTotals());
    }

    const operatorIds = [...byOperator.keys()];
    const typeIds = [...byType.keys()].filter((id) => !id.startsWith('legacy:'));
    const [users, eventTypes, capacity] = await Promise.all([
        operatorIds.length ? User.findAll({ where: { id: { [Op.in]: operatorIds } }, attributes: ['id', 'name', 'surname'] }) : [],
        typeIds.length ? EventType.schema(schema).findAll({ where: { id: { [Op.in]: typeIds } }, attributes: ['id', 'title'] }) : [],
        operatorCapacity(schema, query, operatorIds)
    ]);
    const userNames = new Map<string, string>(users.map((user): [string, string] => [
        user.id,
        [user.name, user.surname].filter(Boolean).join(' ') || user.id
    ]));
    const typeNames = new Map<string, string>(eventTypes.map((type): [string, string] => [type.id, type.title]));
    return {
        period: query,
        totals: finishActivity(totals),
        series: [...series.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, values]) => ({ bucket, ...finishActivity(values) })),
        operators: [...byOperator.entries()].map(([operatorId, values]) => {
            const finished = finishActivity(values);
            const availableMinutes = capacity.get(operatorId) ?? null;
            return {
                operatorId,
                operatorName: userNames.get(operatorId) ?? operatorId,
                ...finished,
                availableMinutes,
                utilizationRate: availableMinutes
                    ? Math.round((finished.deliveredMinutes / availableMinutes) * 10_000) / 100
                    : null
            };
        }).sort((a, b) => b.completed - a.completed),
        eventTypes: [...byType.entries()].map(([eventTypeId, values]) => ({
            eventTypeId: eventTypeId.startsWith('legacy:') ? null : eventTypeId,
            eventTypeName: eventTypeId.startsWith('legacy:') ? eventTypeId.slice(7) : typeNames.get(eventTypeId) ?? 'Altro',
            ...finishActivity(values)
        })).sort((a, b) => b.completed - a.completed),
        details: rows.sort((a, b) => b.start.getTime() - a.start.getTime()).slice(0, 200).map((row) => ({
            id: row.id,
            start: row.start,
            end: row.end,
            patientName: row.patientName,
            title: row.title,
            status: row.status,
            operatorId: row.calendarId,
            invoiceId: row.invoiceId
        }))
    };
}

export function percentageChange(current: number, previous: number): number | null {
    if (previous === 0) return current === 0 ? 0 : null;
    return Math.round(((current - previous) / Math.abs(previous)) * 10_000) / 100;
}
