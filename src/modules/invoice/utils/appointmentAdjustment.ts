export type AppointmentPriceAdjustment = 'DISCOUNT' | 'COMPLIMENTARY' | null;

export class AppointmentAdjustmentError extends Error {
    constructor(message: string, public readonly status = 400) {super(message);}
}

export interface AppointmentPricingInput {
    adjustment: AppointmentPriceAdjustment;
    discountAmount?: number | null;
    note?: string | null;
    baseAmount?: number;
    confirmHistory?: boolean;
}

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

/** Defining a price and confirming old receipts are independent decisions. */
export function resolveAppointmentPricing(originalAmount: number | null,
    input: {adjustment: unknown; discountAmount?: unknown; baseAmount?: unknown; confirmHistory?: unknown},
    paidAmount: number, vatRate: number | null, historyKnown: boolean) {
    if (input.confirmHistory !== undefined && typeof input.confirmHistory !== 'boolean') {
        throw new AppointmentAdjustmentError('La conferma dello storico non è valida');
    }
    if (input.baseAmount !== undefined) {
        if (originalAmount !== null) throw new AppointmentAdjustmentError('Il prezzo è già definito. Ricarica la seduta prima di proseguire.', 409);
        const amount = input.baseAmount;
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0.01 || amount > 99999999.99
            || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
            throw new AppointmentAdjustmentError('Inserisci un prezzo maggiore di zero, con al massimo due decimali. Per azzerarlo scegli Omaggio');
        }
        originalAmount = money(amount);
    }
    return {...resolveAppointmentAdjustment(originalAmount, input.adjustment, input.discountAmount, paidAmount, vatRate),
        originalAmount, historyKnown: historyKnown || input.confirmHistory === true};
}
