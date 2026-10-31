import {QuotePackageFinancialLine} from '../../administration/services/quotePackageFinance.js';
import {ContributionPolicy, contributionPolicy} from './socialSecurity.js';

export interface QuotePackageInvoiceLine {
    id: string | null;
    quantity: number;
    unitPrice: number;
    vat: string | null;
    name: string;
    percentageDiscount: null;
    discountAmount: null;
    socialSecurity?: ContributionPolicy;
}

/** Uses the agreed package lines, never current catalogue names, prices or discounts. */
export function quotePackageInvoiceLines(lines: QuotePackageFinancialLine[], appliesVat: boolean): {
    products: QuotePackageInvoiceLine[]; services: QuotePackageInvoiceLine[];
} {
    const result: ReturnType<typeof quotePackageInvoiceLines> = {products: [], services: []};
    for (const line of lines) {
        const vat = line.vatRate > 0 ? String(line.vatRate) : line.vatNature ?? 'N4';
        const fractional = !Number.isSafeInteger(line.quantity);
        const quantity = fractional ? 1 : line.quantity;
        const common = {id: line.itemId, name: fractional ? `${line.description} (${line.quantity})` : line.description,
            vat, percentageDiscount: null, discountAmount: null};
        const target = line.itemType === 'SERVICE' ? result.services : result.products;
        // The accepted customer total already includes any agreed contribution and VAT.
        // As for catalogue packages, invoicing keeps that total even if the issuer's regime changed.
        const netCents = Math.round(line.total * 100 / (1 + (appliesVat ? line.vatRate : 0) / 100));
        const unitCents = Math.floor(netCents / quantity), remainder = netCents - unitCents * quantity;
        const policy = line.socialSecurity ?? contributionPolicy('NONE');
        const socialSecurity: ContributionPolicy = {...policy, mode: policy.mode === 'NONE' ? 'NONE' : 'INCLUDED'};
        // A package line must retain its total. Separate remainder lines would each round VAT
        // again (e.g. two units at EUR 50 gross / 22% become EUR 100.01). Keep the agreed units
        // in the description when their unit net cannot be represented with currency precision.
        target.push({...common, quantity: remainder ? 1 : quantity,
            name: remainder ? `${line.description} (${line.quantity}${line.itemType === 'SERVICE' ? ' sedute' : ''})` : common.name,
            unitPrice: (remainder ? netCents : unitCents) / 100,
            ...(line.itemType === 'SERVICE' ? {socialSecurity} : {})});
    }
    return result;
}
