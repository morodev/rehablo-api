export type AppointmentPriceAdjustment = 'DISCOUNT' | 'COMPLIMENTARY' | null;

export class AppointmentAdjustmentError extends Error {}

const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** Customer amounts include VAT. A concession changes the price, never the cash ledger. */
export function resolveAppointmentAdjustment(
    originalAmount: number | null,
    adjustment: unknown,
    discountAmount: unknown,
    paidAmount: number,
    vatRate: number | null
): { adjustment: AppointmentPriceAdjustment; amount: number | null; netAmount: number | null } {
    if (![null, 'DISCOUNT', 'COMPLIMENTARY'].includes(adjustment as any)) {
        throw new AppointmentAdjustmentError('Seleziona prezzo pieno, sconto oppure omaggio');
    }
    if (adjustment === 'DISCOUNT' && originalAmount === null) {
        throw new AppointmentAdjustmentError('Definisci il prezzo della seduta prima di applicare uno sconto');
    }
    let amount = originalAmount;
    if (adjustment === 'DISCOUNT') {
        if (typeof discountAmount !== 'number' || !Number.isFinite(discountAmount)
            || money(discountAmount) <= 0 || money(discountAmount) >= amount!) {
            throw new AppointmentAdjustmentError('Lo sconto deve essere maggiore di zero e inferiore al prezzo. Per azzerarlo scegli Omaggio');
        }
        amount = money(amount! - money(discountAmount));
    } else if (adjustment === 'COMPLIMENTARY') {
        amount = 0;
    }
    if (amount !== null && paidAmount > amount + 0.009) {
        throw new AppointmentAdjustmentError('Il nuovo totale è inferiore agli incassi registrati. Correggi prima i movimenti');
    }
    return { adjustment: adjustment as AppointmentPriceAdjustment, amount,
        netAmount: vatRate === null || amount === null ? null : money(amount / (1 + vatRate / 100)) };
}
