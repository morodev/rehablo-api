/**
 * Computes invoice totals (selling price, discounted price, VAT, INPS "rivalsa", net amount due).
 * Ported from the former rehablo-invoice (v2) service, which had the most complete fiscal logic
 * among the two former invoicing microservices.
 */

export interface InvoiceProductLine {
    sellingPrice: number;
    productVat: 4 | 5 | 10 | 22;
}

export interface EvalTotalsInput {
    products: InvoiceProductLine[];
    discountType?: 'percentage' | 'value';
    discountAmount?: number;
    isRivals?: boolean;
    rivals?: number;
    isCashPro?: boolean;
    isTaxWithholding?: boolean;
    taxWithholding?: number;
}

export interface EvalTotalsResult {
    invoiceTotal: number;
    sellingPrice: number;
    discSellingPrice: number;
    invoiceNet: number;
    invoiceVAT: number;
}

function getPercDiscount(discountType: string | undefined, discountAmount: number, totalSellingPrice: number): number {
    if (discountType === 'percentage') return discountAmount;
    if (discountType === 'value') return totalSellingPrice ? (discountAmount * 100) / totalSellingPrice : 0;
    return 0;
}

function applyDiscount(discount: number, sellingPrice: number): number {
    return (discount * sellingPrice) / 100;
}

function evalVat(isRivals: boolean, rivals: number, productVat: number, sellingPrice: number): number {
    if (isRivals) {
        return (productVat / 100) * (sellingPrice + (sellingPrice * rivals) / 100);
    }
    return (productVat / 100) * sellingPrice;
}

export function evalTotals(invoiceFields: EvalTotalsInput): EvalTotalsResult {
    const products = invoiceFields.products || [];
    const rivals = invoiceFields.rivals || 0;
    const isRivals = !!invoiceFields.isRivals;

    let totalSellingPrice = 0;
    products.forEach((product) => {
        totalSellingPrice += product.sellingPrice;
    });

    const discount = getPercDiscount(invoiceFields.discountType, invoiceFields.discountAmount || 0, totalSellingPrice);
    const totalDiscSellingPrice = totalSellingPrice - applyDiscount(discount, totalSellingPrice);

    let totalRivals = 0;
    const vatBuckets: Record<number, number> = { 4: 0, 5: 0, 10: 0, 22: 0 };

    products.forEach((product) => {
        totalRivals += (rivals * product.sellingPrice) / 100;
        const discountedPrice = product.sellingPrice - applyDiscount(discount, product.sellingPrice);

        if (vatBuckets[product.productVat] !== undefined) {
            vatBuckets[product.productVat] += evalVat(isRivals, rivals, product.productVat, discountedPrice);
        } else {
            console.warn(`[evalTotals] unsupported VAT rate: ${product.productVat}`);
        }
    });

    const totalProductVat = vatBuckets[4] + vatBuckets[5] + vatBuckets[10] + vatBuckets[22];
    const invoiceTotal = totalDiscSellingPrice + totalRivals + totalProductVat;

    let taxWithholdingValue = 0;
    if (invoiceFields.isTaxWithholding) {
        const taxWithholding = invoiceFields.taxWithholding || 0;
        taxWithholdingValue = invoiceFields.isCashPro
            ? (totalSellingPrice * taxWithholding) / 100
            : ((totalSellingPrice + totalRivals) * taxWithholding) / 100;
    }

    const netAmountDue = invoiceTotal - taxWithholdingValue;

    return {
        invoiceTotal,
        sellingPrice: totalSellingPrice,
        discSellingPrice: totalDiscSellingPrice,
        invoiceNet: netAmountDue,
        invoiceVAT: totalProductVat
    };
}

