import {undiscountedCompensation} from './socialSecurity.js';
const money = (value: unknown): number => Math.round((Number(value) || 0) * 100) / 100;

function lineTotal(line: Record<string, any>, priceField: string): number {
    const storedTotal = Number(line.totalPrice);
    if (Number.isFinite(storedTotal)) return money(storedTotal);
    return money((Number(line[priceField]) || 0) * (Number(line.quantity) || 1));
}

/**
 * Ricostruisce la scomposizione leggibile dei totali usando gli snapshot delle righe.
 * Non ricalcola né modifica i valori fiscali persistiti dei documenti già emessi.
 */
export function invoiceBreakdown(invoice: Record<string, any>) {
    const snapshot = invoice.socialSecuritySnapshot;
    if (snapshot?.version === 1 && Array.isArray(snapshot.lines)) {
        const reference = money(undiscountedCompensation(snapshot.lines).reduce((sum, amount) => sum + amount, 0));
        const discounted = money(snapshot.lines.reduce((sum: number, line: any) => sum + Number(line.base), 0));
        const original = money(invoice.sellingPrice ?? reference);
        return {adjustedSubtotal: reference, appointmentDiscountTotal: money(Math.max(original - reference, 0)),
            documentDiscountTotal: money(Math.max(reference - discounted, 0)), discountTotal: money(Math.max(original - discounted, 0)),
            rivalsAmount: money(snapshot.lines.reduce((sum: number, line: any) => sum + Number(line.contribution), 0)),
            taxWithholdingAmount: money(snapshot.withholding?.amount ?? 0),
            stampChargedAmount: invoice.isStamp && invoice.stampChargedToPatient ? money(invoice.stampAmount) : 0};
    }
    const lines = [
        ...(invoice.products ?? []).map((line: Record<string, any>) => lineTotal(line, 'productPrice')),
        ...(invoice.services ?? []).map((line: Record<string, any>) => lineTotal(line, 'servicePrice'))
    ];
    const persistedDiscountedSubtotal = invoice.discSellingPrice == null
        ? null
        : money(invoice.discSellingPrice);
    const adjustedSubtotal = lines.length
        ? money(lines.reduce((sum, value) => sum + value, 0))
        : persistedDiscountedSubtotal ?? money(invoice.sellingPrice);
    const originalSubtotal = invoice.sellingPrice == null ? adjustedSubtotal : money(invoice.sellingPrice);
    const discountedSubtotal = persistedDiscountedSubtotal ?? adjustedSubtotal;
    const appointmentDiscountTotal = money(Math.max(originalSubtotal - adjustedSubtotal, 0));
    const documentDiscountTotal = money(Math.max(adjustedSubtotal - discountedSubtotal, 0));
    const stampChargedAmount = invoice.isStamp && invoice.stampChargedToPatient
        ? money(invoice.stampAmount)
        : 0;
    const rivalsAmount = invoice.isRivals ? money(Math.max(
        money(invoice.invoiceTotal) - discountedSubtotal - money(invoice.invoiceVAT) - stampChargedAmount,
        0
    )) : 0;
    const taxWithholdingAmount = invoice.isTaxWithholding
        ? money(Math.max(money(invoice.invoiceTotal) - money(invoice.invoiceNet), 0))
        : 0;

    return {
        adjustedSubtotal,
        appointmentDiscountTotal,
        documentDiscountTotal,
        discountTotal: money(appointmentDiscountTotal + documentDiscountTotal),
        rivalsAmount,
        taxWithholdingAmount,
        stampChargedAmount
    };
}

export function decorateInvoiceWithBreakdown(invoice: Record<string, any>): Record<string, any> {
    return { ...invoice, ...invoiceBreakdown(invoice) };
}
