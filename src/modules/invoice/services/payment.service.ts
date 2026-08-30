import { Op, Transaction } from 'sequelize';
import Invoice from '../models/invoice.model.js';
import InvoicePayment from '../models/invoicePayment.model.js';

export interface InvoicePaymentSummary {
    paidAmount: number;
    balance: number;
    paymentStatus: 'unpaid' | 'partial' | 'paid' | 'void';
    hasUndatedLegacyPayments: boolean;
}

const money = (value: unknown): number => Math.round((Number(value) || 0) * 100) / 100;

export function summarizeInvoicePayments(
    invoice: { invoiceTotal?: unknown; status?: unknown },
    payments: Array<{ amount?: unknown; status?: unknown; paidAt?: unknown; source?: unknown }>
): InvoicePaymentSummary {
    if (String(invoice.status ?? '').toLowerCase() === 'void') {
        return { paidAmount: 0, balance: 0, paymentStatus: 'void', hasUndatedLegacyPayments: false };
    }

    const total = Math.max(money(invoice.invoiceTotal), 0);
    const posted = payments.filter((payment) => payment.status === 'POSTED');
    // Deployment compatibility: before the tenant migration has run, an old `paid` invoice has
    // no movement yet. Preserve its balance and expose it as an undated legacy payment.
    const legacyStatusFallback = posted.length === 0 && String(invoice.status ?? '').toLowerCase() === 'paid';
    const paidAmount = legacyStatusFallback
        ? total
        : money(posted.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0));
    const balance = money(Math.max(total - paidAmount, 0));
    const paymentStatus = paidAmount <= 0 ? 'unpaid' : balance > 0 ? 'partial' : 'paid';

    return {
        paidAmount,
        balance,
        paymentStatus,
        hasUndatedLegacyPayments: legacyStatusFallback || posted.some(
            (payment) => payment.source === 'LEGACY_IMPORT' && !payment.paidAt
        )
    };
}

export async function getPaymentSummaries(
    schema: string,
    invoices: Array<Record<string, any>>
): Promise<Map<string, InvoicePaymentSummary>> {
    const ids = invoices.map((invoice) => invoice.id).filter(Boolean);
    if (ids.length === 0) return new Map();

    const rows = await InvoicePayment.schema(schema).findAll({
        where: { invoiceId: { [Op.in]: ids } },
        attributes: ['invoiceId', 'amount', 'status', 'paidAt', 'source']
    });
    const paymentsByInvoice = new Map<string, Array<Record<string, any>>>();
    rows.forEach((row) => {
        const plain = row.get({ plain: true }) as Record<string, any>;
        const current = paymentsByInvoice.get(plain.invoiceId) ?? [];
        current.push(plain);
        paymentsByInvoice.set(plain.invoiceId, current);
    });

    return new Map(
        invoices.map((invoice) => [
            invoice.id,
            summarizeInvoicePayments(invoice, paymentsByInvoice.get(invoice.id) ?? [])
        ])
    );
}

export async function decorateInvoicesWithPayments(
    schema: string,
    invoiceRows: Array<{ get: (options?: any) => any }>
): Promise<Array<Record<string, any>>> {
    const invoices = invoiceRows.map((invoice) => invoice.get({ plain: true }) as Record<string, any>);
    const summaries = await getPaymentSummaries(schema, invoices);
    return invoices.map((invoice) => ({ ...invoice, ...summaries.get(invoice.id) }));
}

/** Recomputes the compatibility status field after every posted/voided movement. */
export async function syncInvoicePaymentStatus(
    schema: string,
    invoiceId: string,
    transaction?: Transaction
): Promise<InvoicePaymentSummary> {
    const invoice = await Invoice.schema(schema).findByPk(invoiceId, {
        attributes: ['id', 'invoiceTotal', 'status'],
        transaction,
        lock: transaction ? transaction.LOCK.UPDATE : undefined
    });
    if (!invoice) throw new Error('Invoice not found while synchronizing payment status');

    const payments = await InvoicePayment.schema(schema).findAll({
        where: { invoiceId },
        attributes: ['amount', 'status', 'paidAt', 'source'],
        transaction
    });
    const summary = summarizeInvoicePayments(
        invoice.get({ plain: true }) as unknown as Record<string, unknown>,
        payments.map((payment) => payment.get({ plain: true }) as unknown as Record<string, unknown>)
    );
    if (summary.paymentStatus !== 'void') {
        await invoice.update({ status: summary.paymentStatus }, { transaction });
    }
    return summary;
}
