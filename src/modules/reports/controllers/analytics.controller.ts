import { Request, Response } from 'express';
import { Op } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { patientScopeWhere } from '../../../middleware/rbac.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import Patient from '../../patients/models/patient.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoiceProduct from '../../invoice/models/invoiceProduct.model.js';
import InvoiceService from '../../invoice/models/invoiceService.model.js';
import { getPaymentSummaries } from '../../invoice/services/payment.service.js';
import {
    getInvoiceAgendaLinksByInvoiceIds
} from '../../invoice/services/invoiceAgendaEvent.service.js';
import {
    aggregateActivity,
    AnalyticsQuery,
    AnalyticsQueryError,
    comparisonRange,
    localDateKey,
    loadOccurrences,
    parseAnalyticsQuery,
    percentageChange
} from '../services/analytics.service.js';

import { aggregateFinance, loadFinanceData, parseFinanceFilters, therapyPaymentsPayload } from '../services/finance.service.js';

const money = (value: unknown): number => Math.round((Number(value) || 0) * 100) / 100;

function queryOr400(req: Request, res: Response): AnalyticsQuery | null {
    try {
        const query = parseAnalyticsQuery(req);
        parseFinanceFilters(req);
        return query;
    } catch (error) {
        if (error instanceof AnalyticsQueryError) {
            sendErrorResponse(res, 400, error.message);
            return null;
        }
        throw error;
    }
}

function invoiceWhere(req: Request, query: AnalyticsQuery, extra: Record<string | symbol, any> = {}) {
    const where: Record<string | symbol, any> = {
        ...extra,
        ...patientScopeWhere(req, req.tenantSchema!, 'patientID')
    };
    if (query.structureId) where.structureId = query.structureId;
    return where;
}

async function invoiceAttributionWhere(req: Request, query: AnalyticsQuery) {
    if (!query.operatorId && !query.eventTypeId) return {};
    const data = await loadFinanceData(req, { ...query, ...parseFinanceFilters(req) });
    return { id: { [Op.in]: [...data.attributableInvoiceIds] } };
}


async function activityPayload(schema: string, query: AnalyticsQuery) {
    const occurrences = await loadOccurrences(schema, query);
    const current = await aggregateActivity(schema, query, occurrences);
    const previousQuery = comparisonRange(query);
    if (!previousQuery) return { ...current, comparison: null };
    const previous = await aggregateActivity(schema, previousQuery);
    return {
        ...current,
        comparison: {
            period: previousQuery,
            totals: previous.totals,
            change: {
                total: percentageChange(current.totals.total, previous.totals.total),
                completed: percentageChange(current.totals.completed, previous.totals.completed),
                cancelled: percentageChange(current.totals.cancelled, previous.totals.cancelled),
                noShow: percentageChange(current.totals.noShow, previous.totals.noShow),
                noShowInvoiced: percentageChange(current.totals.noShowInvoiced, previous.totals.noShowInvoiced),
                deliveredMinutes: percentageChange(current.totals.deliveredMinutes, previous.totals.deliveredMinutes)
            }
        }
    };
}

export const getActivity = asyncHandler(async (req: Request, res: Response) => {
    const query = queryOr400(req, res);
    if (!query) return;
    const data = await activityPayload(req.tenantSchema!, query);
    return sendSuccessResponse(res, 200, data, 'Statistiche delle terapie caricate');
});

export const getSummary = asyncHandler(async (req: Request, res: Response) => {
    const query = queryOr400(req, res);
    if (!query) return;
    const [activity, patients] = await Promise.all([
        activityPayload(req.tenantSchema!, query),
        patientPayload(req, query)
    ]);
    return sendSuccessResponse(res, 200, { period: query, activity, patients }, 'Riepilogo statistiche caricato');
});

async function patientPayload(req: Request, query: AnalyticsQuery) {
    const schema = req.tenantSchema!;
    const where: Record<string | symbol, any> = { archivedAt: null };
    if (query.structureId) where.structureId = query.structureId;
    if (req.access?.scope === 'own') where.userId = req.access.userId;

    const patients = await Patient.schema(schema).findAll({
        where,
        attributes: ['id', 'createdAt'] as any
    });
    const occurrences = await loadOccurrences(schema, query);
    const activeIds = new Set(
        occurrences.filter((row) => row.status === 'COMPLETED' && row.patientId).map((row) => row.patientId!)
    );

    // Detached completed occurrences are the authoritative clinical history. A completed master
    // series is also considered from its first occurrence for legacy compatibility.
    const completedWhere: Record<string | symbol, any> = {
        status: 'COMPLETED',
        start: { [Op.lte]: new Date(Date.parse(`${query.to}T23:59:59.999Z`) + 3 * 3_600_000).toISOString() },
        patientId: { [Op.ne]: null }
    };
    if (query.structureId) completedWhere.structureId = query.structureId;
    if (query.operatorId) completedWhere.calendarId = query.operatorId;
    const completedHistory = await AgendaEvent.schema(schema).findAll({
        where: completedWhere,
        attributes: ['patientId', 'start']
    });
    const firstByPatient = new Map<string, string>();
    completedHistory.forEach((event) => {
        const patientId = event.patientId;
        const start = event.start ? localDateKey(new Date(event.start)) : null;
        if (patientId && start && (!firstByPatient.has(patientId) || start < firstByPatient.get(patientId)!)) {
            firstByPatient.set(patientId, start);
        }
    });

    const registeredNew = patients.filter((patient) => {
        const createdAt = patient.get('createdAt') as Date | string | undefined;
        const key = createdAt ? localDateKey(new Date(createdAt)) : '';
        return key >= query.from && key <= query.to;
    }).length;
    const newClinical = [...firstByPatient.values()].filter((date) => date >= query.from && date <= query.to).length;
    return {
        registeredTotal: patients.length,
        registeredNew,
        active: activeIds.size,
        newClinical
    };
}

export const getPatients = asyncHandler(async (req: Request, res: Response) => {
    const query = queryOr400(req, res);
    if (!query) return;
    const current = await patientPayload(req, query);
    const previousQuery = comparisonRange(query);
    const previous = previousQuery ? await patientPayload(req, previousQuery) : null;
    return sendSuccessResponse(res, 200, {
        period: query,
        totals: current,
        comparison: previous ? {
            period: previousQuery,
            totals: previous,
            change: {
                registeredNew: percentageChange(current.registeredNew, previous.registeredNew),
                active: percentageChange(current.active, previous.active),
                newClinical: percentageChange(current.newClinical, previous.newClinical)
            }
        } : null
    }, 'Statistiche pazienti caricate');
});


export const getTherapyPayments = asyncHandler(async (req: Request, res: Response) => {
    const query = queryOr400(req, res);
    if (!query) return;
    const financialQuery = { ...query, ...parseFinanceFilters(req) };
    const page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
    const size = Math.min(Math.max(parseInt(String(req.query.size ?? '25'), 10) || 25, 1), 100);
    return sendSuccessResponse(res, 200, await therapyPaymentsPayload(req, financialQuery, page, size), 'Incassi terapie caricati');
});

export const getFinance = asyncHandler(async (req: Request, res: Response) => {
    const query = queryOr400(req, res);
    if (!query) return;
    const financialQuery = { ...query, ...parseFinanceFilters(req) };
    const data = await loadFinanceData(req, financialQuery);
    const current = aggregateFinance(data, financialQuery);
    const previousQuery = comparisonRange(financialQuery);
    const previous = previousQuery ? aggregateFinance(data, { ...financialQuery, ...previousQuery }) : null;
    return sendSuccessResponse(res, 200, {
        ...current,
        comparison: previous ? {
            period: previousQuery,
            totals: previous.totals,
            change: {
                billedTotal: percentageChange(current.totals.billedTotal, previous.totals.billedTotal),
                billedNet: percentageChange(current.totals.billedNet, previous.totals.billedNet),
                collected: percentageChange(current.totals.collected, previous.totals.collected)
            }
        } : null
    }, 'Statistiche economiche caricate');
});

export const getOperators = asyncHandler(async (req: Request, res: Response) => {
    const query = queryOr400(req, res);
    if (!query) return;
    const activity = await aggregateActivity(req.tenantSchema!, query);
    const invoices = await Invoice.schema(req.tenantSchema!).findAll({
        where: invoiceWhere(req, query, {
            emissionDate: { [Op.between]: [query.from, query.to] },
            status: { [Op.ne]: 'void' }
        }),
        attributes: ['id', 'agendaEventId', 'invoiceTotal', 'documentType']
    });
    const invoiceIds = invoices.map((row) => row.id);
    const appointmentLinks = await getInvoiceAgendaLinksByInvoiceIds(req.tenantSchema!, invoiceIds);
    const eventIds = [...new Set([
        ...appointmentLinks.map((link) => link.agendaEventId),
        ...invoices.map((row) => row.agendaEventId).filter(Boolean)
    ])] as string[];
    const events = eventIds.length ? await AgendaEvent.schema(req.tenantSchema!).findAll({
        where: { id: { [Op.in]: eventIds } },
        attributes: ['id', 'calendarId', 'eventTypeId']
    }) : [];
    const eventById = new Map(events.map((event) => [event.id, event]));
    const eventIdsByInvoice = new Map<string, string[]>();
    appointmentLinks.forEach((link) => {
        const current = eventIdsByInvoice.get(link.invoiceId) ?? [];
        current.push(link.agendaEventId);
        eventIdsByInvoice.set(link.invoiceId, current);
    });
    invoices.forEach((invoice) => {
        if (!invoice.agendaEventId) return;
        const current = eventIdsByInvoice.get(invoice.id) ?? [];
        if (!current.includes(invoice.agendaEventId)) current.push(invoice.agendaEventId);
        eventIdsByInvoice.set(invoice.id, current);
    });
    const revenueByOperator = new Map<string, number>();
    let unassignedRevenue = 0;
    invoices.forEach((row) => {
        const value = (row.documentType === 'nota_di_credito' ? -1 : 1) * (Number(row.invoiceTotal) || 0);
        const linkedEvents = (eventIdsByInvoice.get(row.id) ?? [])
            .map((eventId) => eventById.get(eventId))
            .filter(Boolean);
        if (linkedEvents.length === 0) {
            if (!query.operatorId && !query.eventTypeId) unassignedRevenue += value;
            return;
        }

        // Whole document attribution is possible only if every linked therapy belongs
        // to the same operator and satisfies the type filter. Mixed documents stay unassigned.
        const operatorIds = [...new Set(linkedEvents.map((event) => event!.calendarId ?? null))];
        if (operatorIds.length !== 1 || (query.eventTypeId && linkedEvents.some((event) => event!.eventTypeId !== query.eventTypeId))) {
            if (!query.operatorId && !query.eventTypeId) unassignedRevenue += value;
            return;
        }
        const operatorId = operatorIds[0];
        if (query.operatorId && operatorId !== query.operatorId) return;
        if (!operatorId) unassignedRevenue += value;
        else revenueByOperator.set(operatorId, (revenueByOperator.get(operatorId) ?? 0) + value);
    });
    return sendSuccessResponse(res, 200, {
        period: query,
        operators: activity.operators.map((operator) => ({
            ...operator,
            attributedRevenue: money(revenueByOperator.get(operator.operatorId) ?? 0)
        })),
        unassignedRevenue: money(unassignedRevenue),
        attributionPolicy: 'whole_document_when_all_linked_therapies_match'
    }, 'Statistiche operatori caricate');
});

export const getCatalog = asyncHandler(async (req: Request, res: Response) => {
    const query = queryOr400(req, res);
    if (!query) return;
    const schema = req.tenantSchema!;
    const activity = await aggregateActivity(schema, query);
    const attributionWhere = await invoiceAttributionWhere(req, query);
    const invoiceRows = await Invoice.schema(schema).findAll({
        where: invoiceWhere(req, query, {
            ...attributionWhere,
            emissionDate: { [Op.between]: [query.from, query.to] },
            status: { [Op.ne]: 'void' }
        }),
        attributes: ['id', 'sellingPrice', 'discSellingPrice', 'documentType']
    });
    const invoices = invoiceRows.map((row) => row.get({ plain: true }) as Record<string, any>);
    const ids = invoices.map((invoice) => invoice.id);
    const [products, services] = ids.length ? await Promise.all([
        InvoiceProduct.schema(schema).findAll({ where: { InvoiceId: { [Op.in]: ids } } }),
        InvoiceService.schema(schema).findAll({ where: { InvoiceId: { [Op.in]: ids } } })
    ]) : [[], []];
    const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
    const billed = new Map<string, { kind: 'PRODUCT' | 'SERVICE'; itemId: string; name: string; quantity: number; netRevenue: number }>();
    const addLine = (line: Record<string, any>, kind: 'PRODUCT' | 'SERVICE') => {
        const invoice = invoiceById.get(line.InvoiceId);
        if (!invoice) return;
        const itemId = kind === 'PRODUCT' ? line.ProductId : line.ServiceId;
        const name = (kind === 'PRODUCT' ? line.productName : line.serviceName) || 'Senza nome';
        const key = `${kind}:${itemId}`;
        const value = billed.get(key) ?? { kind, itemId, name, quantity: 0, netRevenue: 0 };
        const gross = Number(line.totalPrice) || 0;
        const ratio = Number(invoice.sellingPrice) > 0 ? (Number(invoice.discSellingPrice) || 0) / Number(invoice.sellingPrice) : 1;
        const sign = invoice.documentType === 'nota_di_credito' ? -1 : 1;
        value.quantity += sign * (Number(line.quantity) || 0);
        value.netRevenue += sign * gross * ratio;
        billed.set(key, value);
    };
    products.forEach((row) => addLine(row.get({ plain: true }), 'PRODUCT'));
    services.forEach((row) => addLine(row.get({ plain: true }), 'SERVICE'));

    return sendSuccessResponse(res, 200, {
        period: query,
        delivered: activity.eventTypes,
        billed: [...billed.values()].map((row) => ({ ...row, netRevenue: money(row.netRevenue) }))
            .sort((a, b) => b.netRevenue - a.netRevenue)
    }, 'Statistiche prodotti e servizi caricate');
});

export const getReceivables = asyncHandler(async (req: Request, res: Response) => {
    const query = queryOr400(req, res);
    if (!query) return;
    const page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
    const size = Math.min(Math.max(parseInt(String(req.query.size ?? '10'), 10) || 10, 1), 100);
    const bucket = String(req.query.bucket ?? 'all');
    const validBuckets = ['all', 'overdue', 'today', 'next7', 'no_due'];
    if (!validBuckets.includes(bucket)) return sendErrorResponse(res, 400, 'Filtro scadenza non valido');

    const attributionWhere = await invoiceAttributionWhere(req, query);
    const rows = await Invoice.schema(req.tenantSchema!).findAll({
        where: invoiceWhere(req, query, {
            ...attributionWhere,
            status: { [Op.ne]: 'void' },
            documentType: { [Op.ne]: 'nota_di_credito' }
        }),
        attributes: ['id', 'patientID', 'documentNumber', 'documentYear', 'documentType', 'emissionDate', 'paymentTerms', 'invoiceTotal', 'invoiceNet', 'status']
    });
    const invoices = rows.map((row) => row.get({ plain: true }) as Record<string, any>);
    const summaries = await getPaymentSummaries(req.tenantSchema!, invoices);
    const patientIds = [...new Set(invoices.map((invoice) => invoice.patientID).filter(Boolean))];
    const patients = patientIds.length ? await Patient.schema(req.tenantSchema!).findAll({
        where: { id: { [Op.in]: patientIds } },
        attributes: ['id', 'name', 'surname']
    }) : [];
    const patientNames = new Map(patients.map((patient) => [patient.id, [patient.name, patient.surname].filter(Boolean).join(' ')]));
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
    const next7 = new Date(Date.parse(`${today}T12:00:00.000Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    const open = invoices.flatMap((invoice) => {
        const summary = summaries.get(invoice.id)!;
        if (summary.balance <= 0) return [];
        const dueDate = invoice.paymentTerms ? String(invoice.paymentTerms).slice(0, 10) : null;
        const dueBucket = !dueDate ? 'no_due' : dueDate < today ? 'overdue' : dueDate === today ? 'today' : dueDate <= next7 ? 'next7' : 'future';
        const daysOverdue = dueDate && dueDate < today
            ? Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${dueDate}T12:00:00Z`)) / 86_400_000)
            : 0;
        return [{
            ...invoice,
            patientName: patientNames.get(invoice.patientID) ?? 'Paziente non disponibile',
            ...summary,
            dueDate,
            dueBucket,
            daysOverdue
        }];
    });
    const filtered = bucket === 'all' ? open : open.filter((invoice) => invoice.dueBucket === bucket);
    filtered.sort((a, b) => (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31'));
    const sumBucket = (name: string) => money(open.filter((row) => row.dueBucket === name).reduce((sum, row) => sum + row.balance, 0));
    const countBucket = (name: string) => open.filter((row) => row.dueBucket === name).length;
    return sendSuccessResponse(res, 200, {
        totals: {
            outstanding: money(open.reduce((sum, row) => sum + row.balance, 0)),
            overdue: sumBucket('overdue'), overdueCount: countBucket('overdue'),
            dueToday: sumBucket('today'), dueTodayCount: countBucket('today'),
            dueNext7: sumBucket('next7'), dueNext7Count: countBucket('next7'),
            noDueDate: sumBucket('no_due'), noDueDateCount: countBucket('no_due')
        },
        pagination: { length: filtered.length, page, size, lastPage: Math.max(Math.ceil(filtered.length / size), 1) },
        invoices: filtered.slice((page - 1) * size, page * size)
    }, 'Scadenze fatture caricate');
});

export default {
    getSummary,
    getActivity,
    getFinance,
    getTherapyPayments,
    getOperators,
    getCatalog,
    getPatients,
    getReceivables
};
