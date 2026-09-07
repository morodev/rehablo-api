interface PriceSnapshot {
    source?: unknown;
    amount: number | null;
    netAmount: number | null;
    vatRate: number | null;
}

const money = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const standardVatRates = new Set(['4', '5', '10', '22']);

/**
 * Preserve the agreed customer amount when converting an appointment to an invoice line.
 * The current issuer regime still decides whether VAT applies. A historical net amount cannot
 * be reused if that regime would change the agreed gross amount.
 */
export function applyAppointmentPriceSnapshot(
    price: PriceSnapshot | undefined,
    line: { unitPrice: number; vat: string | null },
    appliesVat: boolean
): { unitPrice: number; vat: string | null } {
    if (price?.source !== 'SNAPSHOT' || price.amount === null) return line;
    const vat = price.vatRate === null ? line.vat
        : price.vatRate > 0 ? String(price.vatRate)
            : standardVatRates.has(String(line.vat).trim()) ? 'N4' : line.vat;
    const rawVat = String(vat ?? '').trim();
    const rate = appliesVat && standardVatRates.has(rawVat) ? Number(rawVat) : 0;
    const frozenNetMatches = price.netAmount !== null
        && money(price.netAmount * (1 + rate / 100)) === money(price.amount);
    return {
        unitPrice: frozenNetMatches ? price.netAmount! : money(price.amount / (1 + rate / 100)),
        vat
    };
}
