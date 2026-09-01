import { Op, Transaction } from 'sequelize';
import rrulePackage from 'rrule';
import AgendaEvent from '../models/agendaEvent.model.js';
import AgendaEventException from '../models/agendaEventException.model.js';
import { StructureUser, TenantUser, User } from '../../auth/models/index.js';

const { rrulestr } = rrulePackage;
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

export interface ReplacementOperator {
    id: string;
    fullName: string;
    email: string;
}

export interface OperatorDeactivationImpact {
    hasFutureAppointments: boolean;
    futureSingleAppointments: number;
    futureRecurringSeries: number;
    replacementOperators: ReplacementOperator[];
}

export interface ReassignmentResult {
    reassignedSingleAppointments: number;
    reassignedRecurringSeries: number;
}

export interface DeferredOperatorAssignment {
    /** Id del singolo appuntamento oppure della serie ricorrente. */
    eventId: string;
    /** Obbligatorio per assegnare una sola occorrenza di una serie. */
    occurrenceStart?: string | null;
    replacementUserId: string;
}

export interface DeferredOperatorReassignmentResult {
    reassignedAppointments: number;
    reassignedRecurringOccurrences: number;
}

interface FutureAssignment {
    event: AgendaEvent;
    nextStart: Date;
    previousStart: Date | null;
    exceptions: AgendaEventException[];
}

export class FutureAppointmentsRequireReplacementError extends Error {
    constructor(public readonly impact: OperatorDeactivationImpact) {
        super('Gli appuntamenti futuri richiedono un operatore sostitutivo');
        this.name = 'FutureAppointmentsRequireReplacementError';
    }
}

export class InvalidReplacementOperatorError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidReplacementOperatorError';
    }
}

export class InvalidDeferredOperatorReassignmentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidDeferredOperatorReassignmentError';
    }
}

function parseDate(value: unknown): Date | null {
    const date = value ? new Date(value as string | number | Date) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
}

function utcRuleDate(date: Date): string {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * RRule nel client lavora su orari locali "floating" e poi applica l'offset del giorno.
 * Replichiamo la stessa semantica in modo esplicito, senza dipendere dal fuso del server:
 * una seduta delle 10:00 resta alle 10:00 anche attraversando il cambio ora.
 */
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
    // Due iterazioni sono normalmente sufficienti; la terza copre anche il salto DST.
    for (let index = 0; index < 3; index++) {
        const representedLocalTime = toAgendaFloatingDate(new Date(guess)).getTime();
        guess += expected - representedLocalTime;
    }
    return new Date(guess);
}

function recurrenceParts(recurrence: string): string[] {
    return recurrence
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part && !part.startsWith('UNTIL=') && !part.startsWith('COUNT='));
}

/**
 * Nel modello agenda `end` e' la fonte autorevole per la fine della serie. COUNT/UNTIL
 * vengono quindi normalizzati quando una serie viene separata, evitando che la nuova meta'
 * conservi il limite calcolato a partire dal vecchio DTSTART.
 */
export function recurrenceWithUntil(recurrence: string, until: Date): string {
    return [...recurrenceParts(recurrence), `UNTIL=${utcRuleDate(until)}`].join(';');
}

/** Restituisce l'occorrenza precedente e la prima non esclusa da riassegnare. */
export function recurrenceBoundary(
    event: Record<string, any>,
    exceptionDates: Date[],
    cutoff: Date
): { nextStart: Date; previousStart: Date | null } | null {
    const start = parseDate(event.start);
    const end = parseDate(event.end);
    const recurrence = String(event.recurrence ?? '').trim();
    if (!start || !end || !recurrence || end < cutoff) return null;

    const parts = recurrenceParts(recurrence);
    if (!parts.some((part) => part.startsWith('FREQ='))) {
        throw new Error(`Regola di ricorrenza non valida per l'appuntamento ${event.id}`);
    }

    const floatingStart = toAgendaFloatingDate(start);
    const floatingEnd = toAgendaFloatingDate(end);
    const floatingCutoff = toAgendaFloatingDate(cutoff);
    const lines = [
        `DTSTART:${utcRuleDate(floatingStart)}`,
        `RRULE:${parts.join(';')};UNTIL=${utcRuleDate(floatingEnd)}`,
        ...exceptionDates.map((date) => `EXDATE:${utcRuleDate(toAgendaFloatingDate(date))}`)
    ];

    try {
        const ruleSet = rrulestr(lines.join('\n'), { forceset: true });
        let nextFloating = ruleSet.after(floatingCutoff, true);
        let nextStart = nextFloating ? fromAgendaFloatingDate(nextFloating) : null;
        while (nextFloating && nextStart && nextStart < cutoff) {
            nextFloating = ruleSet.after(nextFloating, false);
            nextStart = nextFloating ? fromAgendaFloatingDate(nextFloating) : null;
        }
        if (!nextStart || nextStart > end) return null;

        let previousFloating = ruleSet.before(floatingCutoff, false);
        let previousStart = previousFloating ? fromAgendaFloatingDate(previousFloating) : null;
        while (previousFloating && previousStart && previousStart >= cutoff) {
            previousFloating = ruleSet.before(previousFloating, false);
            previousStart = previousFloating ? fromAgendaFloatingDate(previousFloating) : null;
        }
        return {
            nextStart,
            previousStart
        };
    } catch (error) {
        throw new Error(`Regola di ricorrenza non valida per l'appuntamento ${event.id}`, {
            cause: error
        });
    }
}

function isLegacyTimeOff(event: Record<string, any>): boolean {
    const title = typeof event.title === 'string' ? event.title : event.title?.title;
    const patient = event.patient;
    const hasPatient = !!patient && (typeof patient !== 'object' || Object.keys(patient).length > 0);
    return !hasPatient && (title === 'Ferie' || title === 'Permesso');
}

async function loadFutureAssignments(
    schema: string,
    userId: string,
    cutoff: Date,
    transaction?: Transaction,
    lock = false
): Promise<FutureAssignment[]> {
    const cutoffIso = cutoff.toISOString();
    const events = await AgendaEvent.schema(schema).findAll({
        where: {
            calendarId: userId,
            [Op.or]: [
                { start: { [Op.gte]: cutoffIso } },
                { recurrence: { [Op.not]: null }, end: { [Op.gte]: cutoffIso } }
            ]
        },
        transaction,
        ...(transaction && lock ? { lock: transaction.LOCK.UPDATE } : {})
    });

    const recurringIds = events
        .filter((event) => !!String(event.get('recurrence') ?? '').trim())
        .map((event) => event.id);
    const exceptionRows = recurringIds.length > 0
        ? await AgendaEventException.schema(schema).findAll({
            where: { eventId: { [Op.in]: recurringIds } },
            transaction,
            ...(transaction && lock ? { lock: transaction.LOCK.UPDATE } : {})
        })
        : [];
    const exceptionsByEvent = new Map<string, AgendaEventException[]>();
    exceptionRows.forEach((exception) => {
        if (!exception.eventId) return;
        const current = exceptionsByEvent.get(exception.eventId) ?? [];
        current.push(exception);
        exceptionsByEvent.set(exception.eventId, current);
    });

    const assignments: FutureAssignment[] = [];
    for (const event of events) {
        const plain = event.get({ plain: true }) as Record<string, any>;
        if (String(plain.status ?? '').toUpperCase() === 'CANCELLED' || isLegacyTimeOff(plain)) {
            continue;
        }

        const recurrence = String(plain.recurrence ?? '').trim();
        if (!recurrence) {
            const start = parseDate(plain.start);
            if (start && start >= cutoff) {
                assignments.push({ event, nextStart: start, previousStart: null, exceptions: [] });
            }
            continue;
        }

        const exceptions = exceptionsByEvent.get(event.id) ?? [];
        const exceptionDates = exceptions
            .map((exception) => parseDate(exception.exdate))
            .filter((date): date is Date => !!date);
        const boundary = recurrenceBoundary(plain, exceptionDates, cutoff);
        if (boundary) {
            assignments.push({ event, ...boundary, exceptions });
        }
    }

    return assignments;
}

async function eligibleReplacementOperators(
    tenantId: string,
    sourceUserId: string,
    assignments: FutureAssignment[],
    transaction?: Transaction
): Promise<ReplacementOperator[]> {
    const memberships = await TenantUser.findAll({
        where: {
            tenantId,
            userId: { [Op.ne]: sourceUserId },
            deactivatedAt: { [Op.is]: null }
        },
        attributes: ['userId'],
        transaction
    });
    const candidateIds = memberships.map((membership) => membership.userId);
    if (candidateIds.length === 0) return [];

    const users = await User.findAll({
        where: {
            id: { [Op.in]: candidateIds },
            isActive: true,
            deactivatedAt: { [Op.is]: null }
        },
        attributes: ['id', 'name', 'surname', 'email'],
        transaction
    });
    const structureIds = Array.from(new Set(
        assignments
            .map(({ event }) => event.structureId)
            .filter((id): id is string => !!id)
    ));
    const structureMemberships = structureIds.length > 0
        ? await StructureUser.findAll({
            where: {
                userId: { [Op.in]: users.map((user) => user.id) },
                structureId: { [Op.in]: structureIds }
            },
            attributes: ['userId', 'structureId'],
            transaction
        })
        : [];
    const structuresByUser = new Map<string, Set<string>>();
    structureMemberships.forEach((membership) => {
        const current = structuresByUser.get(membership.userId) ?? new Set<string>();
        current.add(membership.structureId);
        structuresByUser.set(membership.userId, current);
    });

    return users
        .filter((user) => {
            const assignedStructures = structuresByUser.get(user.id) ?? new Set<string>();
            return structureIds.every((structureId) => assignedStructures.has(structureId));
        })
        .map((user) => {
            const fullName = [user.name, user.surname].filter(Boolean).join(' ').trim();
            return {
                id: user.id,
                fullName: fullName || 'Operatore senza nominativo',
                email: user.email
            };
        })
        .sort((left, right) => left.fullName.localeCompare(right.fullName, 'it'));
}

function summarize(
    assignments: FutureAssignment[],
    replacementOperators: ReplacementOperator[]
): OperatorDeactivationImpact {
    const futureRecurringSeries = assignments.filter(({ event }) => !!event.recurrence).length;
    const futureSingleAppointments = assignments.length - futureRecurringSeries;
    return {
        hasFutureAppointments: assignments.length > 0,
        futureSingleAppointments,
        futureRecurringSeries,
        replacementOperators
    };
}

export async function getOperatorDeactivationImpact(
    tenantId: string,
    schema: string,
    userId: string,
    cutoff = new Date()
): Promise<OperatorDeactivationImpact> {
    const assignments = await loadFutureAssignments(schema, userId, cutoff);
    const replacementOperators = assignments.length > 0
        ? await eligibleReplacementOperators(tenantId, userId, assignments)
        : [];
    return summarize(assignments, replacementOperators);
}

export async function reassignFutureAppointments(
    tenantId: string,
    schema: string,
    sourceUserId: string,
    replacementUserId: string | null | undefined,
    transaction: Transaction,
    cutoff = new Date()
): Promise<ReassignmentResult> {
    const assignments = await loadFutureAssignments(
        schema,
        sourceUserId,
        cutoff,
        transaction,
        true
    );
    if (assignments.length === 0) {
        return { reassignedSingleAppointments: 0, reassignedRecurringSeries: 0 };
    }

    const eligible = await eligibleReplacementOperators(
        tenantId,
        sourceUserId,
        assignments,
        transaction
    );
    const impact = summarize(assignments, eligible);
    if (!replacementUserId) {
        throw new FutureAppointmentsRequireReplacementError(impact);
    }
    if (!eligible.some((operator) => operator.id === replacementUserId)) {
        throw new InvalidReplacementOperatorError(
            'Seleziona un operatore attivo e assegnato a tutte le sedi degli appuntamenti futuri'
        );
    }

    let reassignedSingleAppointments = 0;
    let reassignedRecurringSeries = 0;
    for (const assignment of assignments) {
        const { event, nextStart, previousStart, exceptions } = assignment;
        if (!event.recurrence) {
            await event.update({ calendarId: replacementUserId }, { transaction });
            reassignedSingleAppointments++;
            continue;
        }

        // Se la serie non ha ancora prodotto alcuna occorrenza, non esiste storico da
        // preservare: basta cambiare il proprietario del record esistente.
        if (!previousStart) {
            await event.update({ calendarId: replacementUserId }, { transaction });
            reassignedRecurringSeries++;
            continue;
        }

        const original = event.get({ plain: true }) as Record<string, any>;
        const originalEnd = parseDate(original.end);
        if (!originalEnd) {
            throw new Error(`Fine serie non valida per l'appuntamento ${event.id}`);
        }

        // Un secondo prima della prima occorrenza trasferita: le RRULE hanno precisione
        // al secondo e cosi' la stessa seduta non puo' comparire in entrambe le meta'.
        const oldEnd = new Date(nextStart.getTime() - 1000);
        await event.update({
            end: oldEnd.toISOString(),
            recurrence: recurrenceWithUntil(event.recurrence, oldEnd)
        }, { transaction });

        const newSeries: Record<string, any> = {
            ...original,
            calendarId: replacementUserId,
            recurringEventId: null,
            isFirstInstance: null,
            start: nextStart.toISOString(),
            end: originalEnd.toISOString(),
            recurrence: recurrenceWithUntil(event.recurrence, originalEnd),
            // I dati di incasso/presenza appartengono alle occorrenze gia' svolte e non
            // devono essere duplicati sulla parte futura appena creata.
            invoiceId: null,
            appointmentPaymentStatus: 'unpaid',
            appointmentPaidAmount: null,
            appointmentPaidAt: null,
            appointmentPaymentMethod: null,
            appointmentPaymentNote: null,
            appointmentPaymentRecordedBy: null,
            missedArrivalReportedAt: null,
            missedArrivalReportedBy: null,
            missedArrivalResolvedAt: null,
            missedArrivalResolvedBy: null,
            missedArrivalResolution: null,
            noShowBillingDecision: null
        };
        delete newSeries.id;
        delete newSeries.createdAt;
        delete newSeries.updatedAt;

        const created = await AgendaEvent.schema(schema).create(newSeries, { transaction });
        const futureExceptionIds = exceptions
            .filter((exception) => {
                const exdate = parseDate(exception.exdate);
                return !!exdate && exdate >= nextStart;
            })
            .map((exception) => exception.id);
        if (futureExceptionIds.length > 0) {
            await AgendaEventException.schema(schema).update(
                { eventId: created.id },
                { where: { id: { [Op.in]: futureExceptionIds } }, transaction }
            );
        }
        reassignedRecurringSeries++;
    }

    return { reassignedSingleAppointments, reassignedRecurringSeries };
}

async function operatorIsAvailableForEvent(
    tenantId: string,
    operatorId: string,
    structureId: string | null,
    transaction: Transaction
): Promise<boolean> {
    const [membership, identity, structureAssignment] = await Promise.all([
        TenantUser.findOne({
            where: { tenantId, userId: operatorId, deactivatedAt: { [Op.is]: null } },
            transaction
        }),
        User.findOne({
            where: {
                id: operatorId,
                isActive: true,
                deactivatedAt: { [Op.is]: null }
            },
            attributes: ['id'],
            transaction
        }),
        structureId
            ? StructureUser.findOne({
                where: { userId: operatorId, structureId },
                attributes: ['userId'],
                transaction
            })
            : Promise.resolve(true)
    ]);

    return !!membership && !!identity && !!structureAssignment;
}

async function operatorIsUnavailable(
    tenantId: string,
    operatorId: string | null,
    transaction: Transaction
): Promise<boolean> {
    if (!operatorId) return true;
    const [membership, identity] = await Promise.all([
        TenantUser.findOne({
            where: { tenantId, userId: operatorId },
            attributes: ['deactivatedAt'],
            transaction
        }),
        User.findByPk(operatorId, {
            attributes: ['id', 'isActive', 'deactivatedAt'],
            transaction
        })
    ]);

    return !membership || !!membership.deactivatedAt || !identity
        || !identity.isActive || !!identity.deactivatedAt;
}

function resetOccurrenceManagedFields(event: Record<string, any>): void {
    event.invoiceId = null;
    event.appointmentPaymentStatus = 'unpaid';
    event.appointmentPaidAmount = null;
    event.appointmentPaidAt = null;
    event.appointmentPaymentMethod = null;
    event.appointmentPaymentNote = null;
    event.appointmentPaymentRecordedBy = null;
    event.missedArrivalReportedAt = null;
    event.missedArrivalReportedBy = null;
    event.missedArrivalResolvedAt = null;
    event.missedArrivalResolvedBy = null;
    event.missedArrivalResolution = null;
    event.noShowBillingDecision = null;
}

/**
 * Risolve gli appuntamenti lasciati sul calendario di un operatore disattivato.
 *
 * Per una serie ricorrente la selezione rappresenta una singola occorrenza: viene
 * aggiunta un'eccezione alla serie originale e creata una seduta autonoma per il nuovo
 * operatore. In questo modo occorrenze diverse possono essere assegnate a persone diverse.
 */
export async function reassignDeferredOperatorAppointments(
    tenantId: string,
    schema: string,
    assignments: DeferredOperatorAssignment[],
    accessWhere: Record<string | symbol, unknown>,
    transaction: Transaction,
    now = new Date()
): Promise<DeferredOperatorReassignmentResult> {
    let reassignedAppointments = 0;
    let reassignedRecurringOccurrences = 0;

    for (const assignment of assignments) {
        const event = await AgendaEvent.schema(schema).findOne({
            where: { id: assignment.eventId, ...accessWhere },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!event) {
            throw new InvalidDeferredOperatorReassignmentError(
                'Uno degli appuntamenti selezionati non esiste o non e\' accessibile'
            );
        }

        const plain = event.get({ plain: true }) as Record<string, any>;
        if (String(plain.status ?? '').toUpperCase() === 'CANCELLED' || isLegacyTimeOff(plain)) {
            throw new InvalidDeferredOperatorReassignmentError(
                'Ferie, permessi e appuntamenti cancellati non possono essere riassegnati'
            );
        }
        if (!await operatorIsUnavailable(tenantId, event.calendarId, transaction)) {
            throw new InvalidDeferredOperatorReassignmentError(
                'Uno degli appuntamenti selezionati non presenta piu\' un operatore da riassegnare'
            );
        }
        if (!await operatorIsAvailableForEvent(
            tenantId,
            assignment.replacementUserId,
            event.structureId,
            transaction
        )) {
            throw new InvalidDeferredOperatorReassignmentError(
                'Il nuovo operatore non e\' attivo o non e\' assegnato alla sede dell\'appuntamento'
            );
        }

        if (!event.recurrence) {
            const start = parseDate(event.start);
            if (!start || start < now) {
                throw new InvalidDeferredOperatorReassignmentError(
                    'Possono essere riassegnati soltanto appuntamenti futuri'
                );
            }
            await event.update({ calendarId: assignment.replacementUserId }, { transaction });
            reassignedAppointments++;
            continue;
        }

        const occurrenceStart = parseDate(assignment.occurrenceStart);
        if (!occurrenceStart || occurrenceStart < now) {
            throw new InvalidDeferredOperatorReassignmentError(
                'Per le serie ricorrenti seleziona una singola occorrenza futura valida'
            );
        }
        const exceptions = await AgendaEventException.schema(schema).findAll({
            where: { eventId: event.id },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        const exceptionDates = exceptions
            .map((exception) => parseDate(exception.exdate))
            .filter((date): date is Date => !!date);
        const boundary = recurrenceBoundary(plain, exceptionDates, occurrenceStart);
        if (!boundary || Math.abs(boundary.nextStart.getTime() - occurrenceStart.getTime()) >= 1000) {
            throw new InvalidDeferredOperatorReassignmentError(
                'L\'occorrenza ricorrente selezionata non e\' piu\' disponibile'
            );
        }

        const durationMinutes = Number(event.duration);
        if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
            throw new InvalidDeferredOperatorReassignmentError(
                'La durata della serie ricorrente non e\' valida'
            );
        }

        const standalone: Record<string, any> = {
            ...plain,
            calendarId: assignment.replacementUserId,
            recurringEventId: null,
            isFirstInstance: null,
            start: occurrenceStart.toISOString(),
            end: new Date(occurrenceStart.getTime() + durationMinutes * 60_000).toISOString(),
            recurrence: null,
            duration: null
        };
        delete standalone.id;
        delete standalone.createdAt;
        delete standalone.updatedAt;
        resetOccurrenceManagedFields(standalone);

        await AgendaEvent.schema(schema).create(standalone, { transaction });
        await AgendaEventException.schema(schema).create({
            eventId: event.id,
            exdate: occurrenceStart.toISOString()
        }, { transaction });
        reassignedAppointments++;
        reassignedRecurringOccurrences++;
    }

    return { reassignedAppointments, reassignedRecurringOccurrences };
}
