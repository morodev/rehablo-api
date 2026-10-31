import {Op, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import {appointmentPricesByEvent, isAppointmentPaymentHistoryKnown, paymentMoney, summarizeAppointmentPayments} from '../../invoice/services/appointmentPayment.service.js';
import {summarizeInvoicePayments} from '../../invoice/services/payment.service.js';
import {CarePackage} from '../../administration/models/index.js';
import {isFinancialCarePackage} from '../../administration/services/carePackage.service.js';

export type PatientSettlementKind = 'APPOINTMENT' | 'INVOICE' | 'PACKAGE';
export interface PatientSettlementContext {
    patientId: string;
    structureId: string;
    referenceAgendaEventId?: string;
    referenceInvoiceId?: string;
    referenceOccurrenceStart?: string;
}
export interface PatientSettlementAllocation {
    kind: Exclude<PatientSettlementKind, 'PACKAGE'>;
    targetId: string;
    amount: number;
}
export interface PatientSettlementObligation {
    key: string;
    kind: PatientSettlementKind;
    targetId: string;
    title: string;
    date: string | null;
    orderDate: string;
    balance: number | null;
    expectedAmount: number | null;
    paidAmount: number;
    isCurrent: boolean;
    invoiceNumber: string | null;
    linkedEventIds: string[];
    eligible: boolean;
    unavailableReason: string | null;
    coverageSources: string[];
    methods: Array<string | null>;
    hasUndatedPayments: boolean;
    historyKnown?: boolean;
    record: Record<string, any>;
}
export interface PatientSettlementVerification {
    agendaEventId: string;
    date: string | null;
    title: string;
    reason: 'UNVERIFIED_HISTORY' | 'NO_SHOW';
    record: Record<string, any>;
}
export type PatientSettlementIssueKind = 'MISSING_PRICE' | 'UNKNOWN_PREVIOUS_PAYMENT' | 'UNRESOLVED_INVOICE' | 'NO_SHOW';
export interface PatientSettlementIssue {
    agendaEventId: string;
    date: string | null;
    title: string;
    kind: PatientSettlementIssueKind;
    expectedAmount: number | null;
    suggestedAmount?: number | null;
    paidAmount: number;
    isCurrent: boolean;
    record: Record<string, any>;
}
export interface RawPatientSettlementPosition {
    obligations: PatientSettlementObligation[];
    queue: PatientSettlementObligation[];
    verification: PatientSettlementVerification[];
    issues?: PatientSettlementIssue[];
    current: PatientSettlementObligation | null;
    referenceEvent: Record<string, any> | null;
    referenceInvoice: Record<string, any> | null;
}
export interface PatientSettlementSources {
    packages?: Array<Record<string, any>>;
    events: Array<Record<string, any>>;
    invoices: Array<Record<string, any>>;
    links: Array<{invoiceId: string; agendaEventId: string}>;
    payments: Array<Record<string, any>>;
    prices: Map<string, {amount: number | null; estimated?: boolean}>;
    now?: number;
}

export class PatientSettlementError extends Error {
    readonly status: number;
    constructor(public readonly statusCode: number, message: string) {
        super(message);
        this.status = statusCode;
    }
}
export function settlementFail(statusCode: number, message: string): never {
    throw new PatientSettlementError(statusCode, message);
}
export const settlementPatientId = (event: Record<string, any>): string | null => event.patientId ?? event.patient?.id ?? null;
const time = (value: unknown): number | null => {
    const parsed = Date.parse(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : null;
};
const localDate = (value: unknown): string | null => {
    const parsed = time(value);
    return parsed === null ? null : new Date(parsed).toLocaleDateString('en-CA', {timeZone: 'Europe/Rome'});
};
const key = (kind: PatientSettlementKind, targetId: string): string => `${kind}:${targetId}`;

/** All financial writers acquire this before any event, invoice, credit or movement lock. */
export async function lockPatientSettlement(schema: string, patientId: string, transaction: Transaction): Promise<void> {
    if (!/^rehablo_[a-z0-9]+$/i.test(schema) || !/^[a-f\d-]{36}$/i.test(patientId)) {
        settlementFail(400, 'Contesto del paziente non valido');
    }
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', {
        transaction, replacements: {lockKey: `${schema}:patient-settlement:${patientId}`}
    });
}

/** Canonical policy is independent from the actor's visibility: hidden prior debts still block. */
export function buildPatientSettlementPosition(
    context: PatientSettlementContext,
    sources: PatientSettlementSources
): RawPatientSettlementPosition {
    const now = sources.now ?? Date.now();
    const events = sources.events.filter(event => settlementPatientId(event) === context.patientId
        && (event.structureId === context.structureId
            || (event.id === context.referenceAgendaEventId && event.structureId == null)))
        .map(event => event.id === context.referenceAgendaEventId && event.recurrence && context.referenceOccurrenceStart
            ? {...event, start: context.referenceOccurrenceStart} : event);
    const eventById = new Map(events.map(event => [event.id, event]));
    const relatedInvoiceIds = new Set<string>(events.filter(event => event.invoiceId).map(event => event.invoiceId));
    sources.links.forEach(link => {if (eventById.has(link.agendaEventId)) relatedInvoiceIds.add(link.invoiceId);});
    const invoices = sources.invoices.filter(invoice => invoice.patientID === context.patientId
        && (invoice.structureId === context.structureId
            || (invoice.structureId == null && (invoice.id === context.referenceInvoiceId
                || relatedInvoiceIds.has(invoice.id) || eventById.has(invoice.agendaEventId)))));
    const invoiceById = new Map(invoices.map(invoice => [invoice.id, invoice]));
    const activeInvoices = new Map(invoices.filter(invoice => String(invoice.status ?? '').toLowerCase() !== 'void'
        && String(invoice.status ?? '').toLowerCase() !== 'draft' && invoice.documentType !== 'nota_di_credito'
        && Number(invoice.documentNumber) > 0).map(invoice => [invoice.id, invoice]));
    const invoiceByEvent = new Map<string, string>();
    const eventsByInvoice = new Map<string, Set<string>>();
    const attach = (invoiceId: string, eventId: string) => {
        if (!activeInvoices.has(invoiceId) || !eventById.has(eventId)) return;
        invoiceByEvent.set(eventId, invoiceId);
        const linked = eventsByInvoice.get(invoiceId) ?? new Set<string>();
        linked.add(eventId); eventsByInvoice.set(invoiceId, linked);
    };
    sources.links.forEach(link => attach(link.invoiceId, link.agendaEventId));
    events.forEach(event => { if (event.invoiceId) attach(event.invoiceId, event.id); });
    invoices.forEach(invoice => { if (invoice.agendaEventId) attach(invoice.id, invoice.agendaEventId); });
    const referenceEvent = eventById.get(context.referenceAgendaEventId ?? '') ?? null;
    const currentInvoiceId = context.referenceInvoiceId
        ?? (referenceEvent ? invoiceByEvent.get(referenceEvent.id) : null) ?? null;
    const referenceInvoice = invoiceById.get(currentInvoiceId ?? '') ?? null;
    const obligations: PatientSettlementObligation[] = [];
    const verification: PatientSettlementVerification[] = [];
    const issues: PatientSettlementIssue[] = [];
    const packages = (sources.packages ?? []).filter(pack => isFinancialCarePackage(pack) && pack.patientId === context.patientId && pack.structureId === context.structureId);

    events.forEach(event => {
        const isCurrent = event.id === context.referenceAgendaEventId && !currentInvoiceId;
        if (event.carePackageId && ['RESERVED', 'CONSUMED'].includes(String(event.packageReservationStatus))) {
            if (isCurrent) obligations.push({key: key('APPOINTMENT', event.id), kind: 'APPOINTMENT', targetId: event.id,
                title: event.title || 'Seduta', date: localDate(event.start), orderDate: event.start,
                balance: 0, expectedAmount: 0, paidAmount: 0, isCurrent, invoiceNumber: null, linkedEventIds: [],
                eligible: false, unavailableReason: 'Seduta inclusa nel pacchetto: il saldo è gestito sull’acquisto.',
                coverageSources: ['PACKAGE'], methods: [], hasUndatedPayments: false, record: event});
            return;
        }
        if (invoiceByEvent.has(event.id)) return;
        // An unresolved fiscal link must never become a second appointment cash target.
        if (event.invoiceId || sources.links.some(link => link.agendaEventId === event.id)) {
            verification.push({agendaEventId: event.id, date: localDate(event.start), title: event.title || 'Seduta',
                reason: 'UNVERIFIED_HISTORY', record: event});
            issues.push({agendaEventId: event.id, date: localDate(event.start), title: event.title || 'Seduta',
                kind: 'UNRESOLVED_INVOICE', expectedAmount: null, paidAmount: 0, isCurrent: event.id === context.referenceAgendaEventId, record: event});
            return;
        }
        const start = time(event.start);
        if (start === null) return;
        const history = sources.payments.filter(payment => payment.agendaEventId === event.id);
        const legacyPaid = history.length === 0 && ['paid', 'partial'].includes(event.appointmentPaymentStatus)
            ? paymentMoney(event.appointmentPaidAmount) : 0;
        const known = isAppointmentPaymentHistoryKnown(event, history);
        const price = sources.prices.get(event.id);
        const expected = price?.estimated ? null : price?.amount ?? null;
        const summary = summarizeAppointmentPayments(expected, history.length ? history
            : legacyPaid > 0 ? [{status: 'POSTED', amount: legacyPaid, paidAt: event.appointmentPaidAt}] : []);
        const status = String(event.status ?? '').toUpperCase();
        const end = time(event.end) ?? start + (Number(event.duration) || 0) * 60_000;
        let reason: string | null = null;
        if (event.recurrence || event.recurringEventId) reason = 'Separa questa occorrenza dalla serie per gestirne gli incassi.';
        else if (start > now) reason = 'La seduta futura sarà incassabile dal suo orario di inizio.';
        else if (status === 'CANCELLED') reason = 'Gli incassi non sono disponibili per l’appuntamento cancellato.';
        else if (status === 'NO_SHOW') reason = 'Per il no-show utilizza la decisione economica e l’eventuale fatturazione.';
        else if (!['CONFIRMED', 'COMPLETED'].includes(status)) reason = 'Gli incassi non sono disponibili per questo appuntamento.';
        else if (event.appointmentPriceAdjustment === 'COMPLIMENTARY') reason = 'La seduta è omaggio: nessun incasso dovuto.';
        else if (!known) reason = 'Non è disponibile il pagamento precedente: completa la situazione nella registrazione dell’incasso.';
        else if (!isCurrent && status === 'CONFIRMED' && end > now) reason = 'La seduta precedente è ancora in corso.';
        const eligible = reason === null;
        const priorRelevant = start <= now && !event.recurrence && !event.recurringEventId
            && ['CONFIRMED', 'COMPLETED', 'NO_SHOW'].includes(status)
            && !(status === 'CONFIRMED' && end > now && !isCurrent)
            && event.appointmentPriceAdjustment !== 'COMPLIMENTARY'
            && !(status === 'NO_SHOW' && event.noShowBillingDecision === 'WAIVED');
        if (priorRelevant && (status === 'NO_SHOW' || !known)) verification.push({
            agendaEventId: event.id, date: localDate(event.start), title: event.title || 'Seduta',
            reason: status === 'NO_SHOW' ? 'NO_SHOW' : 'UNVERIFIED_HISTORY', record: event
        });
        if (priorRelevant || (isCurrent && start <= now && ['CONFIRMED', 'COMPLETED'].includes(status)
            && event.appointmentPriceAdjustment !== 'COMPLIMENTARY')) {
            const kind: PatientSettlementIssueKind | null = status === 'NO_SHOW' ? 'NO_SHOW'
                : !known ? 'UNKNOWN_PREVIOUS_PAYMENT' : expected === null ? 'MISSING_PRICE' : null;
            if (kind) issues.push({agendaEventId: event.id, date: localDate(event.start), title: event.title || 'Seduta',
                kind, expectedAmount: expected, suggestedAmount: price?.estimated ? price.amount : undefined,
                paidAmount: summary.paidAmount, isCurrent: event.id === context.referenceAgendaEventId, record: event});
        }
        if (!isCurrent && (!eligible || (summary.balance !== null && summary.balance <= 0.009))) return;
        obligations.push({key: key('APPOINTMENT', event.id), kind: 'APPOINTMENT', targetId: event.id,
            title: event.title || 'Seduta', date: localDate(event.start), orderDate: new Date(start).toISOString(),
            balance: known ? summary.balance : null, expectedAmount: expected, paidAmount: summary.paidAmount,
            isCurrent, invoiceNumber: null, linkedEventIds: [], eligible, unavailableReason: reason, historyKnown: known,
            coverageSources: [...new Set(history.filter(payment => payment.status === 'POSTED').map(payment => String(payment.source ?? 'APPOINTMENT')))],
            methods: history.length ? summary.methods : legacyPaid > 0 ? [event.appointmentPaymentMethod ?? null] : [],
            hasUndatedPayments: summary.hasUndatedPayments, record: event});
    });

    invoices.forEach(invoice => {
        const isCurrent = invoice.id === currentInvoiceId;
        const summary = summarizeInvoicePayments(invoice, sources.payments.filter(payment => payment.invoiceId === invoice.id));
        const linkedEventIds = [...(eventsByInvoice.get(invoice.id) ?? [])].sort();
        const anchors = linkedEventIds.map(id => time(eventById.get(id)?.start)).filter(value => value !== null) as number[];
        const emission = time(invoice.emissionDate);
        const packagePurchase = packages.find(pack => pack.invoiceId === invoice.id);
        const anchor = packagePurchase ? time(packagePurchase.purchasedAt ?? packagePurchase.createdAt) : anchors.length ? Math.min(...anchors) : emission;
        if (anchor === null) return;
        const eligible = activeInvoices.has(invoice.id) && emission !== null && emission <= now;
        if (!isCurrent && (!eligible || summary.balance <= 0.009)) return;
        const invoiceNumber = invoice.documentNumber ? `${invoice.documentNumber}${invoice.documentYear ? `/${invoice.documentYear}` : ''}` : null;
        obligations.push({key: key('INVOICE', invoice.id), kind: 'INVOICE', targetId: invoice.id,
            title: invoiceNumber ? `Fattura ${invoiceNumber}` : 'Fattura', date: localDate(invoice.emissionDate),
            orderDate: new Date(anchor).toISOString(), balance: summary.balance,
            expectedAmount: paymentMoney(invoice.invoiceNet ?? invoice.invoiceTotal), paidAmount: summary.paidAmount,
            isCurrent, invoiceNumber, linkedEventIds, eligible,
            unavailableReason: eligible ? null : 'Il documento non è disponibile per un nuovo incasso.',
            coverageSources: [...new Set(sources.payments.filter(payment => payment.invoiceId === invoice.id && payment.status === 'POSTED')
                .map(payment => String(payment.source ?? 'USER')))],
            methods: [...new Set(sources.payments.filter(payment => payment.invoiceId === invoice.id && payment.status === 'POSTED')
                .map(payment => payment.method || null))], hasUndatedPayments: summary.hasUndatedLegacyPayments
                    || sources.payments.some(payment => payment.invoiceId === invoice.id && payment.status === 'POSTED' && !payment.paidAt), record: invoice});
    });
    packages.forEach(pack => {
        if (pack.invoiceId && activeInvoices.has(pack.invoiceId)) return;
        const purchasedAt = pack.purchasedAt ?? pack.createdAt;
        const purchasedTime = time(purchasedAt);
        if (purchasedTime === null) return;
        const history = sources.payments.filter(payment => payment.carePackageId === pack.id);
        const summary = summarizeInvoicePayments({invoiceTotal: pack.totalPrice}, history);
        if (summary.balance <= 0.009) return;
        obligations.push({key: key('PACKAGE', pack.id), kind: 'PACKAGE', targetId: pack.id, title: pack.name,
            date: localDate(purchasedAt), orderDate: new Date(purchasedTime).toISOString(), balance: summary.balance,
            expectedAmount: paymentMoney(pack.totalPrice), paidAmount: summary.paidAmount, isCurrent: false,
            invoiceNumber: null, linkedEventIds: [], eligible: false,
            unavailableReason: 'Registra l’incasso dal dettaglio del pacchetto.', coverageSources: [], methods: [], hasUndatedPayments: false, record: pack});
    });
    obligations.sort((a, b) => a.orderDate.localeCompare(b.orderDate) || a.key.localeCompare(b.key));
    verification.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.agendaEventId.localeCompare(b.agendaEventId));
    return {obligations, queue: obligations.filter(row => row.eligible && (row.balance === null || row.balance > 0.009)),
        issues: issues.sort((a, b) => String(a.record.start).localeCompare(String(b.record.start)) || a.agendaEventId.localeCompare(b.agendaEventId)),
        verification, current: obligations.find(row => row.isCurrent) ?? null, referenceEvent, referenceInvoice};
}

export async function loadPatientSettlementPosition(
    schema: string,
    context: PatientSettlementContext,
    options: {transaction?: Transaction; now?: number} = {}
): Promise<RawPatientSettlementPosition> {
    const transaction = options.transaction;
    const eventModels = await AgendaEvent.schema(schema).findAll({where: {[Op.and]: [
        {[Op.or]: [{patientId: context.patientId}, {patient: {id: context.patientId} as any}]},
        {[Op.or]: [{structureId: context.structureId}, ...(context.referenceAgendaEventId
            ? [{id: context.referenceAgendaEventId, structureId: null}] : [])]}
    ]}, order: [['id', 'ASC']], transaction});
    const invoiceModels = await Invoice.schema(schema).findAll({where: {patientID: context.patientId, [Op.or]: [
        {structureId: context.structureId}, {structureId: null}
    ]}, order: [['id', 'ASC']], transaction});
    const events = eventModels.map(row => row.get({plain: true}) as Record<string, any>);
    const invoices = invoiceModels.map(row => row.get({plain: true}) as Record<string, any>);
    const packages = (await CarePackage.schema(schema).findAll({where: {patientId: context.patientId,
        structureId: context.structureId, [Op.or]: [{templateId: {[Op.ne]: null}}, {quoteId: {[Op.ne]: null}}]}, transaction}))
        .map(row => row.get({plain: true}) as Record<string, any>).filter(isFinancialCarePackage);
    const packageIds = packages.map(row => row.id);
    const eventIds = events.map(row => row.id);
    const invoiceIds = invoices.map(row => row.id);
    const links = eventIds.length || invoiceIds.length ? (await InvoiceAgendaEvent.schema(schema).findAll({where: {
        releasedAt: null, [Op.or]: [
            ...(eventIds.length ? [{agendaEventId: {[Op.in]: eventIds}}] : []),
            ...(invoiceIds.length ? [{invoiceId: {[Op.in]: invoiceIds}}] : [])
        ]}, transaction})).map(row => row.get({plain: true}) as {invoiceId: string; agendaEventId: string}) : [];
    const [prices, paymentModels] = await Promise.all([
        appointmentPricesByEvent(schema, events, transaction),
        eventIds.length || invoiceIds.length || packageIds.length ? InvoicePayment.schema(schema).findAll({where: {[Op.or]: [
            ...(packageIds.length ? [{carePackageId: {[Op.in]: packageIds}}] : []),
            ...(eventIds.length ? [{agendaEventId: {[Op.in]: eventIds}}] : []),
            ...(invoiceIds.length ? [{invoiceId: {[Op.in]: invoiceIds}}] : [])
        ]}, transaction}) : Promise.resolve([])
    ]);
    return buildPatientSettlementPosition(context, {events, invoices, links, prices, packages,
        payments: paymentModels.map(row => row.get({plain: true})), now: options.now});
}

export function validatePatientSettlementAllocations(
    queue: PatientSettlementObligation[], allocations: PatientSettlementAllocation[]
): PatientSettlementAllocation[] {
    if (!allocations.length || allocations.length > 100) settlementFail(400, 'Seleziona da una a cento righe da saldare');
    const byKey = new Map(allocations.map(row => [key(row.kind, row.targetId), row]));
    if (byKey.size !== allocations.length) settlementFail(400, 'Ogni obbligo può comparire una sola volta');
    if (allocations.some(row => !['APPOINTMENT', 'INVOICE'].includes(row.kind) || !Number.isFinite(row.amount)
        || row.amount < 0.01 || Math.abs(row.amount * 100 - Math.round(row.amount * 100)) > 0.000001)) {
        settlementFail(400, 'Attribuzione dell’incasso non valida');
    }
    const ordered = queue.filter(row => byKey.has(row.key)).map(row => byKey.get(row.key)!);
    if (ordered.length !== allocations.length) settlementFail(409, 'Uno degli obblighi selezionati non è più disponibile per il saldo');
    const appointmentCount = ordered.filter(row => row.kind === 'APPOINTMENT').length;
    ordered.forEach((allocation, index) => {
        const row = queue[index];
        if (key(allocation.kind, allocation.targetId) !== row?.key) settlementFail(409, 'Salda prima l’obbligo precedente più vecchio');
        if (row.balance === null) return;
        if (allocation.amount > row.balance + 0.009) settlementFail(409, 'L’importo supera il residuo dell’obbligo selezionato');
        if (allocation.amount < row.balance - 0.009) {
            if (index !== ordered.length - 1) settlementFail(409, 'Un residuo precedente impedisce di saldare l’obbligo successivo');
            if (allocation.kind === 'APPOINTMENT' && appointmentCount < 2) {
                settlementFail(409, 'La singola seduta deve essere saldata integralmente, anche usando credito e denaro insieme');
            }
        }
    });
    return ordered;
}

export async function assertPatientSettlementAllocations(
    schema: string, context: PatientSettlementContext, allocations: PatientSettlementAllocation[], transaction: Transaction
): Promise<PatientSettlementAllocation[]> {
    const position = await loadPatientSettlementPosition(schema, context, {transaction});
    return validatePatientSettlementAllocations(position.queue, allocations);
}
