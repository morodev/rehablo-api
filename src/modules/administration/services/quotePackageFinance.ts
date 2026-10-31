import {ContributionPolicy, contributionPolicy, evaluateContributionInvoice} from '../../invoice/utils/socialSecurity.js';

export interface QuotePackageFinancialLine {
    itemType: 'SERVICE' | 'PRODUCT' | 'CUSTOM';
    itemId: string | null;
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
    vatRate: number;
    vatNature: string | null;
    appliesVat?: boolean;
    socialSecurity?: ContributionPolicy;
}

const uuid = /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const amount = (value: unknown): number | null => value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0 ? null : Number(value);
const cents = (value: number): number => Math.round((value + Number.EPSILON) * 100);

/** Only persisted, internally consistent agreements enable money operations on quote packages. */
export function quotePackageFinancialSnapshot(pack: Record<string, any>): {totalPrice: number; lines: QuotePackageFinancialLine[]} | null {
    if (!uuid.test(String(pack.quoteId ?? ''))) return null;
    const totalPrice = amount(pack.totalPrice);
    if (totalPrice === null || Math.abs(totalPrice * 100 - cents(totalPrice)) > 0.00001) return null;
    const quote = pack.purchaseSnapshot?.quote;
    if (quote && (quote.id !== pack.quoteId || amount(quote.total) === null || cents(Number(quote.total)) !== cents(totalPrice))) return null;
    const source = quote?.lines ?? pack.lines;
    if (!Array.isArray(source) || !source.length) return null;
    const lines: QuotePackageFinancialLine[] = [];
    for (const raw of source) {
        if (!raw || !['SERVICE', 'PRODUCT', 'CUSTOM'].includes(raw.itemType)) return null;
        const quantity = Number(raw.quantity), unitPrice = amount(raw.unitPrice), total = amount(raw.total);
        const description = typeof raw.description === 'string' ? raw.description.trim() : '';
        const itemId = raw.itemId == null || raw.itemId === '' ? null : String(raw.itemId);
        const vatRate = raw.vatRate == null || raw.vatRate === '' ? 0 : Number(raw.vatRate);
        if (!Number.isFinite(quantity) || quantity <= 0 || (raw.itemType === 'SERVICE' && !Number.isSafeInteger(quantity))
            || unitPrice === null || total === null || !description
            || (itemId !== null && !uuid.test(itemId)) || ![0, 4, 5, 10, 22].includes(vatRate)) return null;
        let socialSecurity: ContributionPolicy | undefined;
        if (raw.socialSecurity != null) {
            try { socialSecurity = contributionPolicy(raw.socialSecurity.fund, raw.socialSecurity.mode, raw.socialSecurity.rate); }
            catch { return null; }
        }
        const expectedTotal = socialSecurity ? evaluateContributionInvoice({policy: socialSecurity, appliesVat: raw.appliesVat !== false,
            lines: [{type: raw.itemType, sellingPrice: unitPrice, quantity, productVat: vatRate || raw.vatNature || 'N4'}]}).invoiceTotal
            : quantity * unitPrice;
        if (cents(expectedTotal) !== cents(total)) return null;
        lines.push({itemType: raw.itemType, itemId, description, quantity, unitPrice, total, vatRate,
            vatNature: typeof raw.vatNature === 'string' && raw.vatNature.trim() ? raw.vatNature.trim() : null,
            ...(socialSecurity ? {socialSecurity, appliesVat: raw.appliesVat !== false} : {})});
    }
    if (cents(lines.reduce((sum, line) => sum + line.total, 0)) !== cents(totalPrice)) return null;
    return {totalPrice, lines};
}
