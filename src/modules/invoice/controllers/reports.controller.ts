import { Request, Response } from 'express';
import { Op } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendSuccessResponse } from '../../../utils/response.js';
import { patientScopeWhere } from '../../../middleware/rbac.js';
import Invoice from '../models/invoice.model.js';
import InvoicePayment from '../models/invoicePayment.model.js';
import Tenant from '../../auth/models/tenant.model.js';
import { getMissingIssuerFields } from '../utils/issuer.js';
import { resolveFiscalProfile } from '../utils/fiscalRegime.js';
import { getPaymentSummaries } from '../services/payment.service.js';

/**
 * Aggregazioni economiche per la dashboard di direzione.
 *
 * Perché un endpoint dedicato invece di calcolare lato client: `GET /invoice` è paginato
 * (default 10 elementi) e restituisce anche tutte le righe di ogni documento. Ricostruire
 * il fatturato di sei mesi sfogliando le pagine significherebbe decine di richieste e totali
 * sbagliati appena qualcuno cambia pagina.
 *
 * Le fatture stornate (`status = 'void'`) sono escluse da ogni totale: non concorrono né al
 * fatturato né all'incassato.
 */

interface MonthlyBucket {
    /** Chiave `YYYY-MM`. */
    month: string;
    billed: number;
    collected: number;
}

const VOID_STATUS = 'void';

function monthKey(date: Date): string {
    return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}`;
}

/**
 * GET /reports/overview?months=6
 *
 * Restituisce:
 * - `today`:   fatturato, incassato e da incassare dei documenti emessi OGGI
 * - `monthly`: serie degli ultimi N mesi (default 6), dal più vecchio al più recente
 * - `outstanding`: totale non ancora incassato, senza limiti di periodo
 */
export const getOverview = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const InvoiceScoped = Invoice.schema(schema);

    const months = Math.min(Math.max(parseInt((req.query.months as string) ?? '6', 10) || 6, 1), 24);

    const now = new Date();
    const rangeStart = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
    const rangeStartKey = rangeStart.toISOString().slice(0, 7) + '-01';
    const todayKey = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });

    // Un'unica lettura: le fatture del periodo con i soli campi che servono ai totali.
    const invoices = await InvoiceScoped.findAll({
        where: {
            emissionDate: { [Op.gte]: rangeStartKey },
            ...patientScopeWhere(req, schema, 'patientID')
        },
        attributes: ['id', 'emissionDate', 'status', 'invoiceTotal', 'documentType']
    });

    // Il saldo aperto va guardato su tutto lo storico, non solo sul periodo del grafico.
    const allInvoices = await InvoiceScoped.findAll({
        where: {
            status: { [Op.ne]: VOID_STATUS },
            ...patientScopeWhere(req, schema, 'patientID')
        },
        attributes: ['id', 'invoiceTotal', 'status', 'documentType']
    });
    const allPlain = allInvoices.map((invoice) => invoice.get({ plain: true }) as Record<string, any>);
    const paymentSummaries = await getPaymentSummaries(schema, allPlain);
    const invoiceIds = allPlain.map((invoice) => invoice.id);
    const payments = invoiceIds.length ? await InvoicePayment.schema(schema).findAll({
        where: {
            invoiceId: { [Op.in]: invoiceIds },
            status: 'POSTED',
            paidAt: { [Op.gte]: rangeStartKey }
        },
        attributes: ['amount', 'paidAt']
    }) : [];

    const buckets = new Map<string, MonthlyBucket>();
    for (let i = 0; i < months; i++) {
        const date = new Date(rangeStart.getFullYear(), rangeStart.getMonth() + i, 1);
        buckets.set(monthKey(date), { month: monthKey(date), billed: 0, collected: 0 });
    }

    let todayBilled = 0;
    let todayCollected = 0;
    let todayOutstanding = 0;

    invoices.forEach((invoice) => {
        const status = (invoice.get('status') as string | null) ?? '';
        if (status === VOID_STATUS) {
            return;
        }

        const sign = invoice.get('documentType') === 'nota_di_credito' ? -1 : 1;
        const total = sign * (Number(invoice.get('invoiceTotal')) || 0);

        // `emissionDate` può arrivare come Date o come stringa a seconda del driver.
        const rawDate = invoice.get('emissionDate') as Date | string | null;
        const emitted = rawDate ? new Date(rawDate) : null;
        if (!emitted || Number.isNaN(emitted.getTime())) {
            return;
        }

        const bucket = buckets.get(monthKey(emitted));
        if (bucket) {
            bucket.billed += total;
        }

        if (String(rawDate).slice(0, 10) === todayKey) {
            todayBilled += total;
            if (sign > 0) {
                todayOutstanding += paymentSummaries.get(invoice.get('id') as string)?.balance ?? 0;
            }
        }
    });

    payments.forEach((payment) => {
        const rawDate = payment.get('paidAt') as Date | string | null;
        if (!rawDate) return;
        const key = String(rawDate).slice(0, 7);
        const amount = Number(payment.get('amount')) || 0;
        const bucket = buckets.get(key);
        if (bucket) bucket.collected += amount;
        if (String(rawDate).slice(0, 10) === todayKey) todayCollected += amount;
    });

    const outstanding = allPlain.reduce((sum, invoice) => {
        if (invoice.documentType === 'nota_di_credito') return sum;
        return sum + (paymentSummaries.get(invoice.id)?.balance ?? 0);
    }, 0);

    const monthly = [...buckets.values()].map((bucket) => ({
        month: bucket.month,
        billed: Math.round(bucket.billed * 100) / 100,
        collected: Math.round(bucket.collected * 100) / 100
    }));

    return sendSuccessResponse(
        res,
        200,
        {
            today: {
                billed: Math.round(todayBilled * 100) / 100,
                collected: Math.round(todayCollected * 100) / 100,
                // Residuo dei documenti emessi oggi. Non si sottrae l'incassato odierno dal
                // fatturato odierno: un pagamento di oggi può riferirsi a una fattura più vecchia.
                toCollect: Math.round(todayOutstanding * 100) / 100
            },
            monthly,
            outstanding: Math.round(outstanding * 100) / 100
        },
        'Riepilogo economico caricato'
    );
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


