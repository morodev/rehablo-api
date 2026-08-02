import { Request, Response } from 'express';
import { Op } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendSuccessResponse } from '../../../utils/response.js';
import { patientScopeWhere } from '../../../middleware/rbac.js';
import Invoice from '../models/invoice.model.js';

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
const PAID_STATUS = 'paid';

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
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    // Un'unica lettura: le fatture del periodo con i soli campi che servono ai totali.
    const invoices = await InvoiceScoped.findAll({
        where: {
            emissionDate: { [Op.gte]: rangeStart.toISOString() },
            ...patientScopeWhere(req, schema, 'patientID')
        },
        attributes: ['id', 'emissionDate', 'status', 'invoiceTotal']
    });

    // Lo scaduto va guardato su tutto lo storico, non solo sul periodo del grafico.
    const unpaidInvoices = await InvoiceScoped.findAll({
        where: {
            status: { [Op.notIn]: [VOID_STATUS, PAID_STATUS] },
            ...patientScopeWhere(req, schema, 'patientID')
        },
        attributes: ['id', 'invoiceTotal']
    });

    const buckets = new Map<string, MonthlyBucket>();
    for (let i = 0; i < months; i++) {
        const date = new Date(rangeStart.getFullYear(), rangeStart.getMonth() + i, 1);
        buckets.set(monthKey(date), { month: monthKey(date), billed: 0, collected: 0 });
    }

    let todayBilled = 0;
    let todayCollected = 0;

    invoices.forEach((invoice) => {
        const status = (invoice.get('status') as string | null) ?? '';
        if (status === VOID_STATUS) {
            return;
        }

        const total = Number(invoice.get('invoiceTotal')) || 0;

        // `emissionDate` può arrivare come Date o come stringa a seconda del driver.
        const rawDate = invoice.get('emissionDate') as Date | string | null;
        const emitted = rawDate ? new Date(rawDate) : null;
        if (!emitted || Number.isNaN(emitted.getTime())) {
            return;
        }

        const bucket = buckets.get(monthKey(emitted));
        if (bucket) {
            bucket.billed += total;
            if (status === PAID_STATUS) {
                bucket.collected += total;
            }
        }

        if (emitted >= todayStart && emitted < todayEnd) {
            todayBilled += total;
            if (status === PAID_STATUS) {
                todayCollected += total;
            }
        }
    });

    const outstanding = unpaidInvoices.reduce(
        (sum, invoice) => sum + (Number(invoice.get('invoiceTotal')) || 0),
        0
    );

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
                toCollect: Math.round((todayBilled - todayCollected) * 100) / 100
            },
            monthly,
            outstanding: Math.round(outstanding * 100) / 100
        },
        'Riepilogo economico caricato'
    );
});

export default { getOverview };


