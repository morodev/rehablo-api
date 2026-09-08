import { Request } from 'express';
import { Op } from 'sequelize';
import { patientScopeWhere } from '../../../middleware/rbac.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import { getInvoiceAgendaLinksByEventIds } from '../../invoice/services/invoiceAgendaEvent.service.js';
import { summarizeInvoicePayments } from '../../invoice/services/payment.service.js';
import { appointmentPricesByEvent } from '../../invoice/services/appointmentPayment.service.js';
import { AnalyticsQuery, AnalyticsQueryError, bucketKey, localDateKey, loadOccurrences } from './analytics.service.js';

export interface FinanceFilters {
    paymentStatus: 'all' | 'paid' | 'partial' | 'unpaid' | 'unknown';
    documentStatus: 'all' | 'invoiced' | 'unbilled';
    paymentMethod: string | null;
    statuses?: string[];
    eventTypeIds?: string[];
    agendaEventIds?: string[];
}
export type FinanceQuery = AnalyticsQuery & FinanceFilters;
export const money = (value: unknown): number => Math.round((Number(value) || 0) * 100) / 100;
export const methodKey = (method: unknown): string => {
    const value = String(method ?? '').trim();
    // Older quick payments stored the UI origin in the method column. It is not a tender.
    return !value || value.toLowerCase() === 'dashboard' ? '__unspecified__' : value;
};
const plain = (row: any): Record<string, any> => typeof row.get === 'function' ? row.get({ plain: true }) : row;
const dateKey = (date: unknown): string => date instanceof Date ? localDateKey(date) : String(date ?? '').slice(0, 10);
const inPeriod = (date: unknown, query: AnalyticsQuery): boolean => !!date && dateKey(date) >= query.from && dateKey(date) <= query.to;

export function parseFinanceFilters(req: Request): FinanceFilters {
    const paymentStatus = String(req.query.paymentStatus ?? 'all') as FinanceFilters['paymentStatus'];
    const documentStatus = String(req.query.documentStatus ?? 'all') as FinanceFilters['documentStatus'];
    if (!['all', 'paid', 'partial', 'unpaid', 'unknown'].includes(paymentStatus)) throw new AnalyticsQueryError('Filtro pagamento non valido');
    if (!['all', 'invoiced', 'unbilled'].includes(documentStatus)) throw new AnalyticsQueryError('Filtro documento non valido');
    if (req.query.paymentMethod != null && (typeof req.query.paymentMethod !== 'string' || req.query.paymentMethod.length > 255)) {
        throw new AnalyticsQueryError('Metodo pagamento non valido');
    }
    const statuses = req.query.status ? String(req.query.status).split(',').filter(Boolean) : undefined;
    if (statuses?.some((status) => !['CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'PENDING'].includes(status))) throw new AnalyticsQueryError('Stato seduta non valido');
    const eventTypeIds = req.query.eventTypeIds ? String(req.query.eventTypeIds).split(',').filter(Boolean) : undefined;
    if (eventTypeIds?.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) throw new AnalyticsQueryError('Prestazione non valida');
    if (req.query.agendaEventIds != null && typeof req.query.agendaEventIds !== 'string') throw new AnalyticsQueryError('Appuntamenti non validi');
    const agendaEventIds = req.query.agendaEventIds != null ? String(req.query.agendaEventIds).split(',').filter(Boolean) : undefined;
    return { paymentStatus, documentStatus, paymentMethod: req.query.paymentMethod ? String(req.query.paymentMethod).trim() : null, statuses, eventTypeIds, agendaEventIds };
}

export interface FinanceData {
    events: Array<Record<string, any>>;
    invoices: Array<Record<string, any>>;
    payments: Array<Record<string, any>>;
    /** Documents whose complete set of linked therapies satisfies the context filter. */
    attributableInvoiceIds: Set<string>;
    excludedMixedInvoiceCount: number;
}

/** No proportional allocation: a mixed document cannot be assigned to one operator/type. */
export function invoiceMatchesContext(events: Array<Record<string, any>>, query: AnalyticsQuery & Partial<FinanceFilters>): boolean {
    if (!query.operatorId && !query.eventTypeId && !query.eventTypeIds?.length) return true;
    return events.length > 0 && events.every((event) =>
        (!query.operatorId || event.calendarId === query.operatorId) &&
        (!query.eventTypeId || event.eventTypeId === query.eventTypeId) &&
        (!query.eventTypeIds?.length || query.eventTypeIds.includes(event.eventTypeId))
    );
}

export async function loadFinanceData(req: Request, query: FinanceQuery): Promise<FinanceData> {
    const schema = req.tenantSchema!;
    const eventWhere: Record<string | symbol, any> = { ...patientScopeWhere(req, schema, 'patientId') };
    const invoiceWhere: Record<string | symbol, any> = { ...patientScopeWhere(req, schema, 'patientID') };
    if (query.structureId) { eventWhere.structureId = query.structureId; invoiceWhere.structureId = query.structureId; }
    if (query.operatorId) eventWhere.calendarId = query.operatorId;
    if (query.eventTypeId) eventWhere.eventTypeId = query.eventTypeId;
    if (query.eventTypeIds?.length) eventWhere.eventTypeId = { [Op.in]: query.eventTypeIds };
    const [eventModels, invoiceModels] = await Promise.all([
        AgendaEvent.schema(schema).findAll({ where: eventWhere }),
        Invoice.schema(schema).findAll({ where: invoiceWhere,
            attributes: ['id', 'agendaEventId', 'emissionDate', 'invoiceTotal', 'invoiceNet', 'sellingPrice', 'discSellingPrice', 'status', 'documentType', 'paymentTerms'] })
    ]);
    const events = eventModels.map(plain);
    const invoices = invoiceModels.map(plain);
    const eventIds = events.map((event) => event.id);
    const invoiceIds = invoices.map((invoice) => invoice.id);
    const [eventLinks, invoiceLinkModels, prices] = await Promise.all([
        getInvoiceAgendaLinksByEventIds(schema, eventIds),
        // Fiscal cancellation releases active links but retains the audit links. They still
        // identify the context of USER cash received on that document before cancellation.
        invoiceIds.length ? InvoiceAgendaEvent.schema(schema).findAll({ where: { invoiceId: { [Op.in]: invoiceIds } } }) : [],
        appointmentPricesByEvent(schema, events)
    ]);
    const invoiceLinks = invoiceLinkModels.map(plain);
    const invoiceIdByEvent = new Map(eventLinks.map((link) => [link.agendaEventId, link.invoiceId]));
    invoices.forEach((invoice) => { if (invoice.agendaEventId && invoice.status !== 'void') invoiceIdByEvent.set(invoice.agendaEventId, invoice.id); });
    const linkedEventIds = [...new Set([
        ...invoiceLinks.map((link) => link.agendaEventId),
        ...invoices.map((invoice) => invoice.agendaEventId).filter(Boolean)
    ])];
    // Fetch all children of accessible documents before applying context filters. Otherwise a
    // mixed invoice could falsely look like a document belonging entirely to one operator.
    const linkedModels = invoiceIds.length ? await AgendaEvent.schema(schema).findAll({
        where: { [Op.or]: [{ id: { [Op.in]: linkedEventIds } }, { invoiceId: { [Op.in]: invoiceIds } }] },
        attributes: ['id', 'calendarId', 'eventTypeId', 'invoiceId']
    }) : [];
    const linkedEvents = linkedModels.map(plain);
    const eventById = new Map(linkedEvents.map((event) => [event.id, event]));
    const idsByInvoice = new Map<string, Set<string>>();
    const addLink = (invoiceId: string, eventId: string) => {
        const ids = idsByInvoice.get(invoiceId) ?? new Set<string>(); ids.add(eventId); idsByInvoice.set(invoiceId, ids);
    };
    invoiceLinks.forEach((link) => addLink(link.invoiceId, link.agendaEventId));
    invoices.forEach((invoice) => { if (invoice.agendaEventId) addLink(invoice.id, invoice.agendaEventId); });
    linkedEvents.forEach((event) => { if (event.invoiceId) addLink(event.invoiceId, event.id); });
    const attributableInvoiceIds = new Set(invoices.filter((invoice) => invoiceMatchesContext(
        [...(idsByInvoice.get(invoice.id) ?? [])].map((id) => eventById.get(id) ?? {}), query
    )).map((invoice) => invoice.id));
    events.forEach((event) => {
        event.invoiceId = event.invoiceId ?? invoiceIdByEvent.get(event.id) ?? null;
        event.expectedAmount = prices.get(event.id)?.amount ?? null;
        event.priceEstimated = prices.get(event.id)?.estimated ?? false;
    });
    const paymentModels = invoiceIds.length || eventIds.length ? await InvoicePayment.schema(schema).findAll({
        where: { [Op.or]: [{ invoiceId: { [Op.in]: invoiceIds } }, { agendaEventId: { [Op.in]: eventIds } }] }
    }) : [];
    const selectedEventIds = new Set(eventIds);
    return { events, invoices, payments: paymentModels.map(plain), attributableInvoiceIds,
        excludedMixedInvoiceCount: invoices.filter((invoice) => !attributableInvoiceIds.has(invoice.id) && invoice.status !== 'void' &&
            [...(idsByInvoice.get(invoice.id) ?? [])].some((id) => selectedEventIds.has(id))).length };
}

function financialIndex(data: FinanceData) {
    // IDs remain stable when pre-invoice payments are linked to a document.
    const payments = [...new Map(data.payments.map((payment) => [payment.id, payment])).values()];
    const byEvent = new Map<string, Array<Record<string, any>>>();
    const byInvoice = new Map<string, Array<Record<string, any>>>();
    payments.forEach((payment) => {
        for (const [map, id] of [[byEvent, payment.agendaEventId], [byInvoice, payment.invoiceId]] as const) {
            if (!id) continue;
            const current = map.get(id) ?? []; current.push(payment); map.set(id, current);
        }
    });
    const invoiceById = new Map(data.invoices.map((invoice) => [invoice.id, invoice]));
    const summaries = new Map(data.invoices.map((invoice) => [invoice.id, summarizeInvoicePayments(invoice, byInvoice.get(invoice.id) ?? [])]));
    return { payments, byEvent, byInvoice, invoiceById, summaries };
}

function eventFinance(event: Record<string, any>, index: ReturnType<typeof financialIndex>) {
    const payments = (index.byEvent.get(event.id) ?? []).filter((payment) => payment.status === 'POSTED');
    const paid = money(payments.reduce((sum, payment) => sum + Number(payment.amount), 0));
    const expected = event.expectedAmount == null ? null : money(event.expectedAmount);
    const invoice = event.invoiceId ? index.invoiceById.get(event.invoiceId) : undefined;
    const summary = invoice ? index.summaries.get(invoice.id) : undefined;
    const eligible = !event.recurrence && !!event.patientId && !['CANCELLED', 'NO_SHOW'].includes(String(event.status).toUpperCase()) && !!event.start && new Date(event.start).getTime() <= Date.now();
    const known = !!event.appointmentPaymentHistoryKnown || (index.byEvent.get(event.id)?.length ?? 0) > 0;
    const directlyPaid = expected != null && paid >= expected && known;
    const paymentScope = event.invoiceId && !directlyPaid ? 'invoice' : 'appointment';
    const paymentStatus = paymentScope === 'invoice' || !eligible || !known || expected == null
        ? 'unknown' : paid <= 0 && expected > 0 ? 'unpaid' : paid < expected ? 'partial' : 'paid';
    return { expectedAmount: expected, priceEstimated: !!event.priceEstimated, paidAmount: paymentScope === 'invoice' ? null : paid,
        balance: paymentStatus === 'unknown' ? null : money(Math.max((expected ?? 0) - paid, 0)),
        paymentStatus, invoicePaymentStatus: summary?.paymentStatus ?? null, paymentScope,
        paymentMethods: [...new Set((paymentScope === 'invoice' ? (index.byInvoice.get(event.invoiceId) ?? []).filter((p) => p.status === 'POSTED') : payments).map((p) => methodKey(p.method)))],
        eligible, payments };
}

function matchesEvent(event: Record<string, any>, financial: ReturnType<typeof eventFinance>, query: FinanceFilters): boolean {
    const status = financial.paymentScope === 'invoice' && financial.invoicePaymentStatus && financial.invoicePaymentStatus !== 'void'
        ? financial.invoicePaymentStatus : financial.paymentStatus;
    return (query.paymentStatus === 'all' || (query.paymentStatus === 'unknown' ? financial.paymentStatus === 'unknown' : status === query.paymentStatus)) &&
        (query.documentStatus === 'all' || (event.appointmentPriceAdjustment !== 'COMPLIMENTARY'
            && (query.documentStatus === 'invoiced') === !!event.invoiceId)) &&
        (!query.paymentMethod || financial.paymentMethods.includes(query.paymentMethod)) &&
        (!query.statuses?.length || query.statuses.includes(String(event.status).toUpperCase()));
}

/** Cash follows paidAt; issued revenue follows emissionDate; balances are current snapshots. */
export function aggregateFinance(data: FinanceData, query: FinanceQuery) {
    const index = financialIndex(data);
    const eventById = new Map(data.events.map((event) => [event.id, event]));
    const financialByEvent = new Map(data.events.map((event) => [event.id, eventFinance(event, index)]));
    const events = data.events.filter((event) => matchesEvent(event, financialByEvent.get(event.id)!, query));
    const eventIds = new Set(events.map((event) => event.id));
    const invoices = data.invoices.filter((invoice) => {
        const summary = index.summaries.get(invoice.id)!;
        return invoice.status !== 'void' && data.attributableInvoiceIds.has(invoice.id) && query.documentStatus !== 'unbilled' &&
            (query.paymentStatus === 'all' || summary.paymentStatus === query.paymentStatus) &&
            (!query.paymentMethod || (index.byInvoice.get(invoice.id) ?? []).some((p) => p.status === 'POSTED' && methodKey(p.method) === query.paymentMethod));
    });
    const invoiceIds = new Set(invoices.map((invoice) => invoice.id));
    // A fiscal correction does not refund money. USER receipts on void documents remain
    // cash movements until explicitly voided; they never contribute issued revenue/balances.
    if (query.documentStatus !== 'unbilled' && query.paymentStatus === 'all') {
        data.invoices.filter((invoice) => invoice.status === 'void' && data.attributableInvoiceIds.has(invoice.id))
            .forEach((invoice) => invoiceIds.add(invoice.id));
    }
    const payments = index.payments.filter((payment) => payment.status === 'POSTED' &&
        (!query.paymentMethod || methodKey(payment.method) === query.paymentMethod) &&
        (payment.source === 'APPOINTMENT' && payment.agendaEventId ? eventIds.has(payment.agendaEventId) : invoiceIds.has(payment.invoiceId)));
    const periodPayments = payments.filter((payment) => inPeriod(payment.paidAt, query));
    const issued = invoices.filter((invoice) => inPeriod(invoice.emissionDate, query));
    const sign = (invoice: Record<string, any>) => invoice.documentType === 'nota_di_credito' ? -1 : 1;
    const today = localDateKey(new Date());
    const totals = {
        billedTotal: money(issued.reduce((sum, invoice) => sum + sign(invoice) * Number(invoice.invoiceTotal || 0), 0)),
        billedNet: money(issued.reduce((sum, invoice) => sum + sign(invoice) * Number(invoice.invoiceNet || 0), 0)),
        discounts: money(issued.reduce((sum, invoice) => sum + sign(invoice) * Math.max(Number(invoice.sellingPrice || 0) - Number(invoice.discSellingPrice || 0), 0), 0)),
        collected: money(periodPayments.reduce((sum, payment) => sum + Number(payment.amount), 0)),
        collectedFromAppointments: money(periodPayments.filter((p) => p.source === 'APPOINTMENT').reduce((sum, p) => sum + Number(p.amount), 0)),
        collectedFromInvoices: money(periodPayments.filter((p) => p.source !== 'APPOINTMENT').reduce((sum, p) => sum + Number(p.amount), 0)),
        collectedUnbilled: money(payments.filter((p) => !p.invoiceId && !eventById.get(p.agendaEventId)?.invoiceId).reduce((sum, p) => sum + Number(p.amount), 0)),
        outstanding: 0, invoiceOutstanding: 0, appointmentOutstanding: 0, overdue: 0, undatedLegacyPaid: 0,
        unbilledCompleted: 0, unbilledEstimatedValue: 0, unknownAppointmentCount: 0,
        issuedOutstanding: 0, excludedMixedInvoiceCount: data.excludedMixedInvoiceCount
    };
    invoices.forEach((invoice) => {
        if (invoice.documentType === 'nota_di_credito') return;
        const summary = index.summaries.get(invoice.id)!;
        totals.invoiceOutstanding += summary.balance;
        if (inPeriod(invoice.emissionDate, query)) totals.issuedOutstanding += summary.balance;
        if (invoice.paymentTerms && dateKey(invoice.paymentTerms) < today) totals.overdue += summary.balance;
    });
    totals.undatedLegacyPaid = payments.filter((payment) => !payment.paidAt).reduce((sum, payment) => sum + Number(payment.amount), 0);
    // Unmigrated legacy invoice flags still have a known balance but no defensible cash date.
    invoices.forEach((invoice) => {
        if (!(index.byInvoice.get(invoice.id)?.length)) {
            const summary = index.summaries.get(invoice.id)!;
            if (summary.hasUndatedLegacyPayments) totals.undatedLegacyPaid += summary.paidAmount;
        }
    });
    events.forEach((event) => {
        if (event.invoiceId || event.appointmentPriceAdjustment === 'COMPLIMENTARY') return;
        const financial = financialByEvent.get(event.id)!;
        if (financial.eligible) {
            totals.appointmentOutstanding += financial.balance ?? 0;
            if (financial.paymentStatus === 'unknown') totals.unknownAppointmentCount++;
        }
        if (event.status === 'COMPLETED' && inPeriod(event.start ? localDateKey(new Date(event.start)) : null, query)) {
            totals.unbilledCompleted++;
            totals.unbilledEstimatedValue += financial.expectedAmount ?? 0;
        }
    });
    totals.outstanding = totals.invoiceOutstanding + totals.appointmentOutstanding;
    Object.keys(totals).forEach((key) => { (totals as any)[key] = money((totals as any)[key]); });
    const series = new Map<string, { bucket: string; billedTotal: number; billedNet: number; collected: number; collectedFromAppointments: number; collectedFromInvoices: number }>();
    const bucketFor = (date: unknown) => {
        const bucket = bucketKey(new Date(`${dateKey(date)}T12:00:00Z`), query.granularity);
        if (!series.has(bucket)) series.set(bucket, { bucket, billedTotal: 0, billedNet: 0, collected: 0, collectedFromAppointments: 0, collectedFromInvoices: 0 });
        return series.get(bucket)!;
    };
    issued.forEach((invoice) => { const bucket = bucketFor(invoice.emissionDate); bucket.billedTotal += sign(invoice) * Number(invoice.invoiceTotal || 0); bucket.billedNet += sign(invoice) * Number(invoice.invoiceNet || 0); });
    periodPayments.forEach((payment) => { const bucket = bucketFor(payment.paidAt); bucket.collected += Number(payment.amount); bucket[payment.source === 'APPOINTMENT' ? 'collectedFromAppointments' : 'collectedFromInvoices'] += Number(payment.amount); });
    return { period: query, totals, balanceAsOf: today, attributionPolicy: 'whole_document_when_all_linked_therapies_match',
        series: [...series.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)).map((row) => ({ ...row,
            billedTotal: money(row.billedTotal), billedNet: money(row.billedNet), collected: money(row.collected), collectedFromAppointments: money(row.collectedFromAppointments), collectedFromInvoices: money(row.collectedFromInvoices) })) };
}

export function aggregateTherapyPayments(data: FinanceData, query: FinanceQuery, occurrences: Array<Record<string, any>>, page = 1, size = 25) {
    const index = financialIndex(data);
    const eventById = new Map(data.events.map((event) => [event.id, event]));
    const availableMethods = new Set<string>();
    const rows = occurrences.flatMap((occurrence) => {
        if (query.agendaEventIds && !query.agendaEventIds.includes(occurrence.id)) return [];
        const event = eventById.get(occurrence.sourceEventId ?? occurrence.id);
        if (!event) return [];
        const financial = eventFinance(event, index);
        financial.paymentMethods.forEach((method) => availableMethods.add(method));
        if (!matchesEvent(event, financial, query)) return [];
        const { payments, eligible, ...fields } = financial;
        return [{ id: occurrence.id, start: occurrence.start, patientName: occurrence.patientName,
            title: occurrence.title, status: occurrence.status, operatorId: occurrence.calendarId,
            eventTypeId: occurrence.eventTypeId, invoiceId: event.invoiceId ?? null,
            appointmentPriceAdjustment: event.appointmentPriceAdjustment ?? null, ...fields }];
    }).sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime() || a.id.localeCompare(b.id));
    const selectedEventIds = new Set(rows.map((row) => row.id));
    const selectedInvoiceIds = new Set(rows.map((row) => row.invoiceId).filter((id) => id && data.attributableInvoiceIds.has(id)));
    const matchingPayments = index.payments.filter((p) => p.status === 'POSTED' && (!query.paymentMethod || methodKey(p.method) === query.paymentMethod));
    const totals = {
        count: rows.length,
        expectedAmount: money(rows.reduce((sum, row) => sum + (row.expectedAmount ?? 0), 0)),
        estimatedPriceCount: rows.filter((row) => row.priceEstimated && row.expectedAmount !== null).length,
        unknownPriceCount: rows.filter((row) => row.expectedAmount === null).length,
        collected: money(matchingPayments.filter((p) => selectedEventIds.has(p.agendaEventId)).reduce((sum, p) => sum + Number(p.amount), 0)),
        outstanding: money(rows.filter((row) => !row.invoiceId).reduce((sum, row) => sum + (row.balance ?? 0), 0)),
        unknownCount: rows.filter((row) => row.paymentStatus === 'unknown' && row.paymentScope === 'appointment').length,
        invoiceManagedCount: rows.filter((row) => row.paymentScope === 'invoice').length,
        invoiceCount: selectedInvoiceIds.size,
        invoiceCollected: money(matchingPayments.filter((p) => p.source !== 'APPOINTMENT' && selectedInvoiceIds.has(p.invoiceId)).reduce((sum, p) => sum + Number(p.amount), 0)),
        invoiceOutstanding: money([...selectedInvoiceIds].reduce((sum, id) => sum + (index.summaries.get(id)?.balance ?? 0), 0))
    };
    return { period: query, totals, pagination: { length: rows.length, page, size, lastPage: Math.max(Math.ceil(rows.length / size), 1) },
        details: rows.slice((page - 1) * size, page * size), paymentMethods: [...availableMethods].sort(),
        balanceAsOf: localDateKey(new Date()), attributionPolicy: 'whole_document_when_all_linked_therapies_match' };
}

export async function therapyPaymentsPayload(req: Request, query: FinanceQuery, page: number, size: number) {
    const [data, occurrences] = await Promise.all([loadFinanceData(req, query), loadOccurrences(req.tenantSchema!, query)]);
    return aggregateTherapyPayments(data, query, occurrences, page, size);
}
