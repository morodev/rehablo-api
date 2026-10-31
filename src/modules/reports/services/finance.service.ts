import { Request } from 'express';
import { Op } from 'sequelize';
import { patientScopeWhere } from '../../../middleware/rbac.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import {packageCoversAppointment} from '../../agenda/services/packageAssignment.service.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import { getInvoiceAgendaLinksByEventIds } from '../../invoice/services/invoiceAgendaEvent.service.js';
import { summarizeInvoicePayments } from '../../invoice/services/payment.service.js';
import { appointmentPricesByEvent, isAppointmentPaymentHistoryKnown, summarizeAppointmentPayments } from '../../invoice/services/appointmentPayment.service.js';
import { AnalyticsQuery, AnalyticsQueryError, bucketKey, localDateKey, loadOccurrences } from './analytics.service.js';
import { CarePackage, PatientCredit, TreasuryMovement } from '../../administration/models/index.js';
import { PatientCreditMovement } from '../../administration/models/patientCreditMovement.model.js';
import { clinicalCashFacts, ClinicalCashFact, CashDiagnosticIssue, dateOnly, FinancialWarning, validIssuedDocument } from './financialFacts.service.js';
import { reportStructureWhere, ReportScope } from './reportScope.service.js';
import {loadPackageCoverage, ReportPackageCoverage, unknownPackageCoverage} from './packageCoverageReporting.service.js';
import {isFinancialCarePackage} from '../../administration/services/carePackage.service.js';

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
const dateKey = dateOnly;
const inPeriod = (date: unknown, query: AnalyticsQuery): boolean => !!date && dateKey(date) >= query.from && dateKey(date) <= query.to;

export function parseFinanceFilters(req: Request): FinanceFilters {
    if (['paymentStatus', 'documentStatus', 'status', 'eventTypeIds', 'agendaEventIds', 'patientId']
        .some(key => req.query[key] != null && typeof req.query[key] !== 'string')) throw new AnalyticsQueryError('Filtro finanziario non valido');
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
    /** Optional therapy-only contract projection; never contributes payment rows to cash facts. */
    packageCoverage?: Map<string, ReportPackageCoverage>;
    packages?: Array<Record<string, any>>;
    events: Array<Record<string, any>>;
    invoices: Array<Record<string, any>>;
    payments: Array<Record<string, any>>;
    /** Documents whose complete set of linked therapies satisfies the context filter. */
    attributableInvoiceIds: Set<string>;
    /** Safe whole-document attribution requires every linked therapy inside the selected sites. */
    scopeCompleteInvoiceIds?: Set<string>;
    excludedMixedInvoiceCount: number;
    /** Exact all-history IDs behind the mixed-documents warning; no related-site details. */
    excludedMixedInvoiceIds?: Set<string>;
    cashFacts?: ClinicalCashFact[];
    cashIssues?: CashDiagnosticIssue[];
    warnings?: FinancialWarning[];
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

export async function loadFinanceData(req: Request, query: FinanceQuery, scope: ReportScope | undefined = (req as any).reportScope): Promise<FinanceData> {
    const schema = req.tenantSchema!;
    const eventWhere: Record<string | symbol, any> = scope ? reportStructureWhere(scope) : { ...patientScopeWhere(req, schema, 'patientId') };
    const invoiceWhere: Record<string | symbol, any> = scope ? reportStructureWhere(scope) : { ...patientScopeWhere(req, schema, 'patientID') };
    if (!scope && query.structureId) { eventWhere.structureId = query.structureId; invoiceWhere.structureId = query.structureId; }
    if (req.query?.patientId) {
        if (typeof req.query.patientId !== 'string') throw new AnalyticsQueryError('Paziente non valido');
        const patientId = String(req.query.patientId);
        if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(patientId)) throw new AnalyticsQueryError('Paziente non valido');
        eventWhere[Op.and] = [eventWhere[Op.and] ?? {}, { patientId }];
        invoiceWhere[Op.and] = [invoiceWhere[Op.and] ?? {}, { patientID: patientId }];
    }
    const packageWhere = {...eventWhere, [Op.and]: [eventWhere[Op.and] ?? {},
        {[Op.or]: [{templateId: {[Op.ne]: null}}, {quoteId: {[Op.ne]: null}}]}]};
    if (query.operatorId) eventWhere.calendarId = query.operatorId;
    if (query.eventTypeId) eventWhere.eventTypeId = query.eventTypeId;
    if (query.eventTypeIds?.length) eventWhere.eventTypeId = { [Op.in]: query.eventTypeIds };
    const [eventModels, invoiceModels, packageModels] = await Promise.all([
        AgendaEvent.schema(schema).findAll({ where: eventWhere }),
        Invoice.schema(schema).findAll({ where: invoiceWhere,
            attributes: ['id', 'patientID', 'structureId', 'documentNumber', 'documentYear', 'agendaEventId', 'carePackageId', 'emissionDate', 'invoiceTotal', 'invoiceNet', 'sellingPrice', 'discSellingPrice', 'status', 'documentType', 'paymentTerms'] }),
        CarePackage.schema(schema).findAll({ where: packageWhere })
    ]);
    const events = eventModels.map(plain);
    const invoices = invoiceModels.map(plain);
    const packages = packageModels.map(plain).filter(isFinancialCarePackage);
    const packageIds = packages.map(pkg => pkg.id);
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
        attributes: ['id', 'calendarId', 'eventTypeId', 'invoiceId', 'structureId']
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
    const scopeCompleteInvoiceIds = new Set(invoices.filter(invoice => !scope || [...(idsByInvoice.get(invoice.id) ?? [])]
        .every(id => { const linked = eventById.get(id); return !!linked && scope.selectedStructureIds.includes(linked.structureId); }))
        .map(invoice => invoice.id));
    const hasContext = !!(query.operatorId || query.eventTypeId || query.eventTypeIds?.length);
    const attributableInvoiceIds = new Set(invoices.filter((invoice) => (!hasContext || scopeCompleteInvoiceIds.has(invoice.id)) && invoiceMatchesContext(
        [...(idsByInvoice.get(invoice.id) ?? [])].map((id) => eventById.get(id) ?? {}), query
    )).map((invoice) => invoice.id));
    events.forEach((event) => {
        event.invoiceId = event.invoiceId ?? invoiceIdByEvent.get(event.id) ?? null;
        event.expectedAmount = prices.get(event.id)?.amount ?? null;
        event.priceEstimated = prices.get(event.id)?.estimated ?? false;
    });
    const paymentModels = invoiceIds.length || eventIds.length || packageIds.length ? await InvoicePayment.schema(schema).findAll({
        where: { [Op.or]: [{ invoiceId: { [Op.in]: invoiceIds } }, { agendaEventId: { [Op.in]: eventIds } }, { carePackageId: { [Op.in]: packageIds } }] }
    }) : [];
    const selectedEventIds = new Set(eventIds);
    const payments = paymentModels.map(plain);
    const cash = await loadClinicalCash(schema, payments);
    const excludedMixedInvoiceIds = new Set(invoices.filter(invoice => !attributableInvoiceIds.has(invoice.id) && invoice.status !== 'void'
        && [...(idsByInvoice.get(invoice.id) ?? [])].some(id => selectedEventIds.has(id))).map(invoice => invoice.id));
    return { events, invoices, packages, payments, cashFacts: cash.facts, cashIssues: cash.issues, warnings: cash.warnings, attributableInvoiceIds, scopeCompleteInvoiceIds,
        excludedMixedInvoiceCount: excludedMixedInvoiceIds.size, excludedMixedInvoiceIds };
}

async function loadClinicalCash(schema: string, payments: Array<Record<string, any>>) {
    const ids = payments.filter(row => !['PACKAGE', 'CREDIT', 'OPENING_BALANCE'].includes(row.source)).map(row => row.id);
    if (!ids.length) return clinicalCashFacts(payments);
    const credits = (await PatientCredit.schema(schema).findAll({ where: { sourceType: 'VOID_CREDIT', sourceId: { [Op.in]: ids } } })).map(plain);
    const refunds = credits.length ? (await PatientCreditMovement.schema(schema).findAll({
        where: { creditId: { [Op.in]: credits.map(row => row.id) }, type: {[Op.in]: ['REFUND', 'REVERSE_REFUND']} }
    })).map(plain) : [];
    const movements = (await TreasuryMovement.schema(schema).findAll({ where: { [Op.or]: [
        { sourceType: { [Op.in]: ['INVOICE_PAYMENT', 'INVOICE_PAYMENT_CORRECTION', 'INVOICE_PAYMENT_DATE_VOID', 'INVOICE_PAYMENT_VOID'] }, sourceId: { [Op.in]: ids } },
        ...(refunds.length ? [{ id: { [Op.in]: refunds.map(row => row.treasuryMovementId).filter(Boolean) } }] : [])
    ] } })).map(plain);
    return clinicalCashFacts(payments, movements, credits, refunds);
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
    const invoiceIdByEvent = new Map<string, string>();
    data.invoices.forEach(invoice => { if (invoice.agendaEventId && String(invoice.status).toLowerCase() !== 'void') invoiceIdByEvent.set(invoice.agendaEventId, invoice.id); });
    data.events.forEach(event => { if (event.invoiceId) invoiceIdByEvent.set(event.id, event.invoiceId); });
    return { payments, byEvent, byInvoice, invoiceById, summaries, invoiceIdByEvent };
}

function eventFinance(event: Record<string, any>, index: ReturnType<typeof financialIndex>, coverageByEvent?: Map<string, ReportPackageCoverage>) {
    const coverage = coverageByEvent?.get(event.id) ?? (packageCoversAppointment(event) && !['CANCELLED', 'NO_SHOW'].includes(String(event.status).toUpperCase())
        ? unknownPackageCoverage(event.carePackageId, event.packageReservationStatus) : null);
    if (coverage) return {
        ...coverage,
        expectedAmount: 0, priceEstimated: false, paidAmount: 0, balance: 0,
        paymentStatus: 'paid', invoicePaymentStatus: null, paymentScope: 'package',
        packageCovered: true, invoiceId: null as string | null,
        eligible: false, payments: [] as Array<Record<string, any>>
    };
    const history = index.byEvent.get(event.id) ?? [];
    const payments = history.filter((payment) => payment.status === 'POSTED');
    const legacy = history.length === 0 && ['paid', 'partial'].includes(event.appointmentPaymentStatus)
        && money(event.appointmentPaidAmount) > 0 ? [{status: 'POSTED', amount: event.appointmentPaidAmount,
            method: event.appointmentPaymentMethod, paidAt: event.appointmentPaidAt}] : [];
    const paid = summarizeAppointmentPayments(null, history.length ? history : legacy).paidAmount;
    const expected = event.expectedAmount == null ? null : money(event.expectedAmount);
    const invoiceId = event.invoiceId ?? index.invoiceIdByEvent.get(event.id);
    const invoice = invoiceId ? index.invoiceById.get(invoiceId) : undefined;
    const summary = invoice ? index.summaries.get(invoice.id) : undefined;
    const eligible = !event.recurrence && !event.recurringEventId && !!event.patientId && ['CONFIRMED', 'COMPLETED'].includes(String(event.status).toUpperCase()) && !!event.start && new Date(event.start).getTime() <= Date.now();
    const known = isAppointmentPaymentHistoryKnown(event, history);
    const directlyPaid = expected != null && !event.priceEstimated && paid >= expected && known;
    const paymentScope = invoiceId && !directlyPaid ? 'invoice' : 'appointment';
    const paymentStatus = paymentScope === 'invoice' || !eligible || !known || expected == null || event.priceEstimated
        ? 'unknown' : paid <= 0 && expected > 0 ? 'unpaid' : paid < expected ? 'partial' : 'paid';
    return { expectedAmount: expected, priceEstimated: !!event.priceEstimated, paidAmount: paymentScope === 'invoice' ? null : paid,
        packageCovered: false, carePackageId: null, invoiceId: invoiceId ?? null,
        packageReservationStatus: null, packageSessionValue: null, packageSummary: null, packageValueUnavailableReason: undefined,
        issueKind: invoiceId && !invoice ? 'UNRESOLVED_INVOICE' : String(event.status).toUpperCase() === 'NO_SHOW' ? 'NO_SHOW'
            : !known ? 'UNKNOWN_PREVIOUS_PAYMENT' : expected === null || event.priceEstimated ? 'MISSING_PRICE' : null,
        balance: paymentStatus === 'unknown' ? null : money(Math.max((expected ?? 0) - paid, 0)),
        paymentStatus, invoicePaymentStatus: summary?.paymentStatus ?? null, paymentScope,
        paymentMethods: [...new Set((paymentScope === 'invoice' ? (index.byInvoice.get(invoiceId) ?? []).filter((p) => p.status === 'POSTED') : history.length ? payments : legacy).map((p) => methodKey(p.method)))],
        eligible, payments };
}

function matchesEvent(event: Record<string, any>, financial: ReturnType<typeof eventFinance>, query: FinanceFilters): boolean {
    if (financial.paymentScope === 'package') {
        const summary = financial.packageSummary;
        const status = summary?.paymentStatus ?? 'unknown';
        const document = summary?.invoiceStatus ?? 'unknown';
        return (query.paymentStatus === 'all' || query.paymentStatus === status)
            && (query.documentStatus === 'all' || query.documentStatus === 'invoiced' && document === 'issued'
                || query.documentStatus === 'unbilled' && ['none', 'void'].includes(document))
            && (!query.paymentMethod || financial.paymentMethods.includes(query.paymentMethod))
            && (!query.statuses?.length || query.statuses.includes(String(event.status).toUpperCase()));
    }
    const status = financial.paymentScope === 'invoice' && financial.invoicePaymentStatus && financial.invoicePaymentStatus !== 'void'
        ? financial.invoicePaymentStatus : financial.paymentStatus;
    return (query.paymentStatus === 'all' || (query.paymentStatus === 'unknown' ? financial.paymentStatus === 'unknown' : status === query.paymentStatus)) &&
        (query.documentStatus === 'all' || (!financial.packageCovered && event.appointmentPriceAdjustment !== 'COMPLIMENTARY'
            && (query.documentStatus === 'invoiced') === !!financial.invoiceId)) &&
        (!query.paymentMethod || financial.paymentMethods.includes(query.paymentMethod)) &&
        (!query.statuses?.length || query.statuses.includes(String(event.status).toUpperCase()));
}

/** Cash follows paidAt; issued revenue follows emissionDate; balances are current snapshots. */
export function financialSelection(data: FinanceData, query: FinanceQuery) {
    const index = financialIndex(data);
    const eventById = new Map(data.events.map((event) => [event.id, event]));
    const financialByEvent = new Map(data.events.map((event) => [event.id, eventFinance(event, index, data.packageCoverage)]));
    const events = data.events.filter((event) => matchesEvent(event, financialByEvent.get(event.id)!, query));
    const eventIds = new Set(events.map((event) => event.id));
    const invoices = data.invoices.filter((invoice) => {
        const summary = index.summaries.get(invoice.id)!;
        return validIssuedDocument(invoice) && data.attributableInvoiceIds.has(invoice.id) && query.documentStatus !== 'unbilled' &&
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
    // The sale has no defensible attribution to a therapist: future sessions may use different calendars.
    const packages: Array<Record<string, any>> = query.operatorId || query.eventTypeId || query.eventTypeIds?.length ? [] : (data.packages ?? []).map(pkg => {
        const invoice = data.invoices.find(row => row.id === pkg.invoiceId && validIssuedDocument(row));
        const paidAmount = money(index.payments.filter(row => row.carePackageId === pkg.id && row.status === 'POSTED')
            .reduce((sum, row) => sum + Number(row.amount), 0));
        const balance = invoice ? index.summaries.get(invoice.id)!.balance : money(Math.max(Number(pkg.totalPrice) - paidAmount, 0));
        const paymentStatus = balance <= 0 ? 'paid' : paidAmount > 0 ? 'partial' : 'unpaid';
        return {...pkg, billed: !!invoice, paidAmount, balance, paymentStatus};
    }).filter(pkg => (query.paymentStatus === 'all' || query.paymentStatus === pkg.paymentStatus)
        && (query.documentStatus === 'all' || (query.documentStatus === 'invoiced') === pkg.billed));
    const packageIds = new Set(packages.map(pkg => pkg.id));
    const payments = (data.cashFacts ?? clinicalCashFacts(index.payments).facts).filter((payment) =>
        (!query.paymentMethod || methodKey(payment.method) === query.paymentMethod) &&
        (payment.source === 'PACKAGE_PURCHASE' && payment.carePackageId ? packageIds.has(payment.carePackageId)
            : payment.source === 'APPOINTMENT' && payment.agendaEventId ? eventIds.has(payment.agendaEventId) : invoiceIds.has(payment.invoiceId)));
    const periodPayments = payments.filter((payment) => inPeriod(payment.paidAt, query));
    const issued = invoices.filter((invoice) => inPeriod(invoice.emissionDate, query));
    return { index, eventById, financialByEvent, events, invoices, packages, payments, periodPayments, issued };
}

export function aggregateFinance(data: FinanceData, query: FinanceQuery) {
    const { index, eventById, financialByEvent, events, invoices, packages, payments, periodPayments, issued } = financialSelection(data, query);
    const sign = (invoice: Record<string, any>) => invoice.documentType === 'nota_di_credito' ? -1 : 1;
    const today = localDateKey(new Date());
    const totals = {
        billedTotal: money(issued.reduce((sum, invoice) => sum + sign(invoice) * Number(invoice.invoiceTotal || 0), 0)),
        billedNet: money(issued.reduce((sum, invoice) => sum + sign(invoice) * Number(invoice.invoiceNet || 0), 0)),
        discounts: money(issued.reduce((sum, invoice) => sum + sign(invoice) * Math.max(Number(invoice.sellingPrice || 0) - Number(invoice.discSellingPrice || 0), 0), 0)),
        collected: money(periodPayments.reduce((sum, payment) => sum + Number(payment.amount), 0)),
        collectedGross: money(periodPayments.filter(row => row.kind === 'receipt').reduce((sum, row) => sum + Number(row.amount), 0)),
        collectionReversals: money(-periodPayments.filter(row => row.kind === 'reversal').reduce((sum, row) => sum + Number(row.amount), 0)),
        collectionRefunds: money(-periodPayments.filter(row => row.kind === 'refund').reduce((sum, row) => sum + Number(row.amount), 0)),
        collectedFromAppointments: money(periodPayments.filter((p) => p.source === 'APPOINTMENT').reduce((sum, p) => sum + Number(p.amount), 0)),
        collectedFromInvoices: money(periodPayments.filter((p) => !['APPOINTMENT', 'PACKAGE_PURCHASE'].includes(p.source)).reduce((sum, p) => sum + Number(p.amount), 0)),
        collectedFromPackages: money(periodPayments.filter((p) => p.source === 'PACKAGE_PURCHASE').reduce((sum, p) => sum + Number(p.amount), 0)),
        collectedUnbilled: money(payments.filter((p) => !p.invoiceId && !eventById.get(p.agendaEventId)?.invoiceId).reduce((sum, p) => sum + Number(p.amount), 0)),
        outstanding: 0, invoiceOutstanding: 0, appointmentOutstanding: 0,
        packageOutstanding: money(packages.filter(pkg => !pkg.billed).reduce((sum, pkg) => sum + pkg.balance, 0)), overdue: 0, undatedLegacyPaid: 0,
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
        if (index.invoiceIdByEvent.has(event.id) || packageCoversAppointment(event) || event.appointmentPriceAdjustment === 'COMPLIMENTARY') return;
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
    totals.outstanding = totals.invoiceOutstanding + totals.appointmentOutstanding + totals.packageOutstanding;
    Object.keys(totals).forEach((key) => { (totals as any)[key] = money((totals as any)[key]); });
    const series = new Map<string, { bucket: string; billedTotal: number; billedNet: number; collected: number; collectedFromAppointments: number; collectedFromInvoices: number; collectedFromPackages: number }>();
    const bucketFor = (date: unknown) => {
        const bucket = bucketKey(new Date(`${dateKey(date)}T12:00:00Z`), query.granularity);
        if (!series.has(bucket)) series.set(bucket, { bucket, billedTotal: 0, billedNet: 0, collected: 0, collectedFromAppointments: 0, collectedFromInvoices: 0, collectedFromPackages: 0 });
        return series.get(bucket)!;
    };
    for (let day = new Date(`${query.from}T12:00:00Z`); day <= new Date(`${query.to}T12:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) bucketFor(day);
    issued.forEach((invoice) => { const bucket = bucketFor(invoice.emissionDate); bucket.billedTotal += sign(invoice) * Number(invoice.invoiceTotal || 0); bucket.billedNet += sign(invoice) * Number(invoice.invoiceNet || 0); });
    periodPayments.forEach((payment) => { const bucket = bucketFor(payment.paidAt); bucket.collected += Number(payment.amount); bucket[payment.source === 'PACKAGE_PURCHASE' ? 'collectedFromPackages' : payment.source === 'APPOINTMENT' ? 'collectedFromAppointments' : 'collectedFromInvoices'] += Number(payment.amount); });
    return { period: query, totals, warnings: data.warnings ?? [], balanceAsOf: today, attributionPolicy: 'whole_document_when_all_linked_therapies_match',
        series: [...series.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)).map((row) => ({ ...row,
            billedTotal: money(row.billedTotal), billedNet: money(row.billedNet), collected: money(row.collected), collectedFromAppointments: money(row.collectedFromAppointments), collectedFromInvoices: money(row.collectedFromInvoices), collectedFromPackages: money(row.collectedFromPackages) })) };
}

export function aggregateTherapyPayments(data: FinanceData, query: FinanceQuery, occurrences: Array<Record<string, any>>, page = 1, size = 25) {
    const index = financialIndex(data);
    const eventById = new Map(data.events.map((event) => [event.id, event]));
    const availableMethods = new Set<string>();
    const rows = occurrences.flatMap((occurrence) => {
        if (query.agendaEventIds && !query.agendaEventIds.includes(occurrence.id)) return [];
        const event = eventById.get(occurrence.sourceEventId ?? occurrence.id);
        if (!event) return [];
        const financial = eventFinance(event, index, data.packageCoverage);
        financial.paymentMethods.forEach((method) => availableMethods.add(method));
        if (!matchesEvent(event, financial, query)) return [];
        const { payments, eligible, ...fields } = financial;
        return [{ id: occurrence.id, start: occurrence.start, patientName: occurrence.patientName,
            title: occurrence.title, status: occurrence.status, operatorId: occurrence.calendarId,
            eventTypeId: occurrence.eventTypeId,
            appointmentPriceAdjustment: event.appointmentPriceAdjustment ?? null, ...fields }];
    }).sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime() || a.id.localeCompare(b.id));
    const selectedEventIds = new Set(rows.map((row) => row.id));
    const selectedInvoiceIds = new Set(rows.map((row) => row.invoiceId).filter((id) => id && data.attributableInvoiceIds.has(id)));
    const matchingPayments = (data.cashFacts ?? clinicalCashFacts(index.payments).facts).filter((p) => (!query.paymentMethod || methodKey(p.method) === query.paymentMethod));
    const covered = rows.filter(row => row.paymentScope === 'package');
    const coveredValue = (status?: 'RESERVED' | 'CONSUMED') => money(covered.filter(row => !status || row.packageReservationStatus === status)
        .reduce((sum, row) => sum + (row.packageSessionValue ?? 0), 0));
    const totals = {
        count: rows.length,
        packageCount: covered.length,
        packageReservedCount: covered.filter(row => row.packageReservationStatus === 'RESERVED').length,
        packageConsumedCount: covered.filter(row => row.packageReservationStatus === 'CONSUMED').length,
        packageValue: coveredValue(), packageReservedValue: coveredValue('RESERVED'), packageConsumedValue: coveredValue('CONSUMED'),
        packageUnknownValueCount: covered.filter(row => row.packageSessionValue === null).length,
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
    const selectedSourceIds = new Set(occurrences.filter(occurrence => !query.agendaEventIds || query.agendaEventIds.includes(occurrence.id))
        .map(occurrence => occurrence.sourceEventId ?? occurrence.id));
    data.packageCoverage = await loadPackageCoverage(req, data.events.filter(event => selectedSourceIds.has(event.id)), data.payments);
    return aggregateTherapyPayments(data, query, occurrences, page, size);
}
