import { Op } from 'sequelize';
import AgendaEvent from '../models/agendaEvent.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import { appointmentPricesByEvent, paymentMoney } from '../../invoice/services/appointmentPayment.service.js';
import { getInvoiceAgendaLinksByEventIds } from '../../invoice/services/invoiceAgendaEvent.service.js';
import { getPaymentSummaries, InvoicePaymentSummary } from '../../invoice/services/payment.service.js';

export type PatientPaymentPositionStatus = 'REGULAR' | 'DUE' | 'VERIFY';

export interface PatientPaymentPositionItem {
    kind: 'APPOINTMENT' | 'INVOICE';
    id: string;
    agendaEventId: string | null;
    invoiceId: string | null;
    date: string | null;
    title: string;
    balance: number | null;
    paymentStatus: 'unpaid' | 'partial' | 'unknown';
}

export interface PatientPaymentPosition {
    status: PatientPaymentPositionStatus;
    openItemCount: number;
    appointmentCount: number;
    invoiceCount: number;
    unknownCount: number;
    outstandingAmount: number;
    items: PatientPaymentPositionItem[];
}

interface PatientPaymentPositionSources {
    historicalEvents: Array<Record<string, any>>;
    prices: Map<string, { amount: number | null }>;
    payments: Array<Record<string, any>>;
    invoices: Array<Record<string, any>>;
    invoiceSummaries: Map<string, InvoicePaymentSummary>;
    invoiceIdByEventId: Map<string, string>;
    now?: number;
}

const EMPTY_POSITION: PatientPaymentPosition = {
    status: 'REGULAR', openItemCount: 0, appointmentCount: 0, invoiceCount: 0,
    unknownCount: 0, outstandingAmount: 0, items: []
};

function patientIdOf(event: Record<string, any>): string | null {
    const snapshot = event.patient && typeof event.patient === 'object' ? event.patient : null;
    return event.patientId ?? snapshot?.id ?? null;
}

function timestamp(value: unknown): number | null {
    const parsed = Date.parse(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : null;
}

function dateKey(value: unknown): string | null {
    const parsed = timestamp(value);
    return parsed === null ? null : new Date(parsed).toISOString().slice(0, 10);
}

function appointmentEndTime(event: Record<string, any>, startTime: number): number {
    const explicitEnd = timestamp(event.end);
    if (explicitEnd !== null) return explicitEnd;
    const duration = Number(event.duration);
    return Number.isFinite(duration) && duration > 0 ? startTime + duration * 60_000 : startTime;
}

function invoiceTitle(invoice: Record<string, any>): string {
    return invoice.documentNumber
        ? `Fattura ${invoice.documentNumber}${invoice.documentYear ? `/${invoice.documentYear}` : ''}`
        : 'Fattura';
}

/** Pure aggregation kept separate from database loading so debt rules remain directly testable. */
export function buildPatientPaymentPositions(
    referenceEvents: Array<Record<string, any>>,
    sources: PatientPaymentPositionSources
): Map<string, PatientPaymentPosition> {
    const now = sources.now ?? Date.now();
    const paymentsByEvent = new Map<string, Array<Record<string, any>>>();
    sources.payments.forEach(payment => {
        if (!payment.agendaEventId) return;
        const rows = paymentsByEvent.get(payment.agendaEventId) ?? [];
        rows.push(payment);
        paymentsByEvent.set(payment.agendaEventId, rows);
    });
    const invoiceById = new Map(sources.invoices.map(invoice => [invoice.id, invoice]));

    return new Map(referenceEvents.map(reference => {
        const patientId = patientIdOf(reference);
        const referenceTime = timestamp(reference.start);
        if (!reference.id || !patientId || referenceTime === null) return [reference.id, { ...EMPTY_POSITION }];

        const dueItems: PatientPaymentPositionItem[] = [];
        const unknownItems: PatientPaymentPositionItem[] = [];
        const invoiceIds = new Set<string>();
        const referenceInvoiceId = reference.invoiceId ?? sources.invoiceIdByEventId.get(reference.id) ?? null;

        sources.historicalEvents.forEach(event => {
            const eventTime = timestamp(event.start);
            if (!event.id || patientIdOf(event) !== patientId || event.id === reference.id || eventTime === null
                || eventTime >= referenceTime || eventTime > now || event.recurrence) return;
            const status = String(event.status ?? '').toUpperCase();
            if (!['CONFIRMED', 'COMPLETED', 'NO_SHOW'].includes(status)) return;
            if (status === 'CONFIRMED' && appointmentEndTime(event, eventTime) > now) return;
            if (event.appointmentPriceAdjustment === 'COMPLIMENTARY'
                || (status === 'NO_SHOW' && String(event.noShowBillingDecision ?? '').toUpperCase() === 'WAIVED')) return;

            const invoiceId = event.invoiceId ?? sources.invoiceIdByEventId.get(event.id) ?? null;
            if (invoiceId) {
                if (invoiceId !== referenceInvoiceId) invoiceIds.add(invoiceId);
                return;
            }

            const eventPayments = paymentsByEvent.get(event.id) ?? [];
            const known = Boolean(event.appointmentPaymentHistoryKnown) || eventPayments.length > 0;
            const expected = sources.prices.get(event.id)?.amount ?? null;
            const posted = eventPayments.filter(payment => payment.status === 'POSTED');
            const paid = posted.length > 0
                ? paymentMoney(posted.reduce((sum, payment) => sum + Number(payment.amount), 0))
                : paymentMoney(event.appointmentPaidAmount);
            const item = {
                kind: 'APPOINTMENT' as const, id: event.id, agendaEventId: event.id, invoiceId: null,
                date: dateKey(event.start), title: event.title || 'Seduta', balance: null,
                paymentStatus: 'unknown' as const
            };
            if (status === 'NO_SHOW' || !known || expected === null) {
                unknownItems.push(item);
                return;
            }
            const balance = paymentMoney(Math.max(expected - paid, 0));
            if (balance > 0.009) dueItems.push({ ...item, balance, paymentStatus: paid > 0 ? 'partial' : 'unpaid' });
        });

        invoiceIds.forEach(invoiceId => {
            const invoice = invoiceById.get(invoiceId);
            const summary = sources.invoiceSummaries.get(invoiceId);
            if (!invoice || !summary || summary.paymentStatus === 'void' || summary.balance <= 0.009) return;
            dueItems.push({
                kind: 'INVOICE', id: invoiceId, agendaEventId: null, invoiceId,
                date: dateKey(invoice.emissionDate), title: invoiceTitle(invoice), balance: summary.balance,
                paymentStatus: summary.paymentStatus === 'partial' ? 'partial' : 'unpaid'
            });
        });

        const allItems = [...dueItems, ...unknownItems]
            .sort((left, right) => String(left.date ?? '').localeCompare(String(right.date ?? '')) || left.id.localeCompare(right.id));
        const outstandingAmount = paymentMoney(dueItems.reduce((sum, item) => sum + Number(item.balance), 0));
        const invoiceCount = dueItems.filter(item => item.kind === 'INVOICE').length;
        const appointmentCount = dueItems.length - invoiceCount;
        const position: PatientPaymentPosition = {
            status: dueItems.length ? 'DUE' : unknownItems.length ? 'VERIFY' : 'REGULAR',
            openItemCount: dueItems.length,
            appointmentCount,
            invoiceCount,
            unknownCount: unknownItems.length,
            outstandingAmount,
            items: allItems.slice(0, 5)
        };
        return [reference.id, position];
    }));
}

/** Loads all prior financial sources in batches; callers provide the already-authorized agenda scope. */
export async function patientPaymentPositionsByReferenceEvents(
    schema: string,
    referenceEvents: Array<Record<string, any>>,
    agendaScope: Record<string | symbol, any>
): Promise<Map<string, PatientPaymentPosition>> {
    const references = referenceEvents.filter(event => event.id && patientIdOf(event) && timestamp(event.start) !== null);
    if (!references.length) return new Map();
    const patientIds = [...new Set(references.map(patientIdOf).filter(Boolean))] as string[];
    const maxReferenceTime = Math.max(...references.map(event => timestamp(event.start)!));
    const patientConditions: Array<Record<string | symbol, any>> = [
        { patientId: { [Op.in]: patientIds } },
        ...patientIds.map(id => ({ patient: { id } as any }))
    ];
    const eventModels = await AgendaEvent.schema(schema).findAll({
        where: { [Op.and]: [
            { [Op.or]: patientConditions },
            { start: { [Op.lt]: new Date(maxReferenceTime).toISOString() } },
            { [Op.or]: [{ recurrence: null }, { recurrence: '' }] },
            { status: { [Op.in]: ['CONFIRMED', 'COMPLETED', 'NO_SHOW', 'confirmed', 'completed', 'no_show'] } },
            agendaScope
        ] }
    });
    const historicalEvents = eventModels.map(event => event.get({ plain: true }) as Record<string, any>);
    const allEventIds = [...new Set([...historicalEvents, ...references].map(event => event.id).filter(Boolean))] as string[];
    const [links, prices, eventPaymentModels] = await Promise.all([
        getInvoiceAgendaLinksByEventIds(schema, allEventIds),
        appointmentPricesByEvent(schema, historicalEvents),
        historicalEvents.length ? InvoicePayment.schema(schema).findAll({
            where: { agendaEventId: { [Op.in]: historicalEvents.map(event => event.id) } },
            attributes: ['agendaEventId', 'amount', 'status']
        }) : Promise.resolve([])
    ]);
    const invoiceIdByEventId = new Map(links.map(link => [link.agendaEventId, link.invoiceId]));
    historicalEvents.forEach(event => {
        if (event.invoiceId) invoiceIdByEventId.set(event.id, event.invoiceId);
    });
    references.forEach(event => {
        if (event.invoiceId) invoiceIdByEventId.set(event.id, event.invoiceId);
    });
    const invoiceIds = [...new Set(invoiceIdByEventId.values())];
    const invoiceModels = invoiceIds.length ? await Invoice.schema(schema).findAll({
        where: { id: { [Op.in]: invoiceIds } },
        attributes: ['id', 'emissionDate', 'invoiceTotal', 'invoiceNet', 'status', 'documentType', 'documentNumber', 'documentYear']
    }) : [];
    const invoices = invoiceModels.map(invoice => invoice.get({ plain: true }) as Record<string, any>);
    const invoiceSummaries = await getPaymentSummaries(schema, invoices);
    return buildPatientPaymentPositions(references, {
        historicalEvents, prices,
        payments: eventPaymentModels.map(payment => payment.get({ plain: true }) as Record<string, any>),
        invoices, invoiceSummaries, invoiceIdByEventId
    });
}
