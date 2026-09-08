import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendSuccessResponse, sendErrorResponse } from '../../../utils/response.js';
import { aggregateFinance, loadFinanceData, parseFinanceFilters, FinanceQuery } from '../../reports/services/finance.service.js';
import { AnalyticsQueryError, localDateKey, parseAnalyticsQuery } from '../../reports/services/analytics.service.js';
import Tenant from '../../auth/models/tenant.model.js';
import { getMissingIssuerFields } from '../utils/issuer.js';
import { resolveFiscalProfile } from '../utils/fiscalRegime.js';

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function resolveOverviewDate(value: unknown, todayKey = localDateKey(new Date())): string {
    const candidate = value === undefined || value === null || value === '' ? todayKey : String(value);
    const parsed = new Date(`${candidate}T12:00:00.000Z`);
    if (!DATE_KEY_PATTERN.test(candidate)
        || !Number.isFinite(parsed.getTime())
        || parsed.toISOString().slice(0, 10) !== candidate
        || candidate > todayKey) {
        throw new AnalyticsQueryError('Data del riepilogo non valida');
    }
    return candidate;
}

/** Shared ledger aggregation: receipts use payment date, documents use issue date. */
export const getOverview = asyncHandler(async (req: Request, res: Response) => {
    const months = Math.min(Math.max(parseInt(String(req.query.months ?? '6'), 10) || 6, 1), 24);
    const todayKey = localDateKey(new Date());
    let reportDay: string;
    let query: FinanceQuery;
    try {
        reportDay = resolveOverviewDate(req.query.date, todayKey);
        const rangeStart = new Date(reportDay.slice(0, 7) + '-01T12:00:00Z');
        rangeStart.setUTCMonth(rangeStart.getUTCMonth() - months + 1);
        query = { ...parseAnalyticsQuery(req), ...parseFinanceFilters(req),
            from: rangeStart.toISOString().slice(0, 10), to: reportDay, granularity: 'month', compare: 'none' };
    } catch (error) {
        if (error instanceof AnalyticsQueryError) return sendErrorResponse(res, 400, error.message);
        throw error;
    }
    const data = await loadFinanceData(req, query);
    const monthlyReport = aggregateFinance(data, query);
    const dailyReport = aggregateFinance(data, { ...query, from: reportDay, to: reportDay, granularity: 'day' });
    const rangeStart = new Date(query.from + 'T12:00:00Z');
    const monthly = Array.from({ length: months }, (_, offset) => {
        const date = new Date(rangeStart); date.setUTCMonth(date.getUTCMonth() + offset);
        const month = date.toISOString().slice(0, 7);
        const bucket = monthlyReport.series.find((row) => row.bucket === month);
        return { month, billed: bucket?.billedTotal ?? 0, collected: bucket?.collected ?? 0,
            collectedFromAppointments: bucket?.collectedFromAppointments ?? 0,
            collectedFromInvoices: bucket?.collectedFromInvoices ?? 0 };
    });
    const totals = dailyReport.totals;
    return sendSuccessResponse(res, 200, {
        day: reportDay,
        today: { billed: totals.billedTotal, collected: totals.collected, toCollect: totals.issuedOutstanding,
            collectedFromAppointments: totals.collectedFromAppointments, collectedFromInvoices: totals.collectedFromInvoices },
        monthly, outstanding: totals.outstanding, invoiceOutstanding: totals.invoiceOutstanding,
        appointmentOutstanding: totals.appointmentOutstanding, collectedUnbilled: totals.collectedUnbilled,
        undatedLegacyPaid: totals.undatedLegacyPaid, unknownAppointmentCount: totals.unknownAppointmentCount,
        excludedMixedInvoiceCount: totals.excludedMixedInvoiceCount,
        balanceAsOf: dailyReport.balanceAsOf, attributionPolicy: dailyReport.attributionPolicy
    }, 'Riepilogo economico caricato');
});

/**
 * GET /reports/issuer-status
 *
 * Dice se lo studio è in regola per emettere documenti fiscali e, in caso contrario,
 * quali dati mancano. Serve alla UI per avvisare PRIMA che l'utente compili una fattura
 * intera, invece di farlo fallire al salvataggio.
 *
 * Restituisce anche il PROFILO FISCALE risolto (regime, IVA applicabile, natura imposta,
 * ritenuta ammessa, parametri del bollo): il form fattura lo usa per proporre i valori corretti
 * e disabilitare le opzioni che il regime esclude, invece di lasciare all'utente la possibilità
 * di comporre un documento che il backend rifiuterà o correggerà silenziosamente.
 */
export const getIssuerStatus = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenants[0].id;
    const tenant = await Tenant.findByPk(tenantId);
    const tenantData = tenant?.get({ plain: true }) as any;
    const missing = getMissingIssuerFields(tenantData);

    return sendSuccessResponse(
        res,
        200,
        {
            ready: missing.length === 0,
            missing,
            fiscalProfile: resolveFiscalProfile(tenantData)
        },
        'Stato dati di fatturazione'
    );
});

export default { getOverview, getIssuerStatus };

