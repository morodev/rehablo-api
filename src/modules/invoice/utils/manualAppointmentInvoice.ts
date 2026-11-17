import type {AppointmentPrice} from '../services/appointmentPayment.service.js';
import type {FiscalProfile} from './fiscalRegime.js';
import {applyAppointmentPriceSnapshot} from './appointmentInvoicePrice.js';
import {contributionPolicy} from './socialSecurity.js';

export interface ManualAppointmentService {
    description: string;
    /** Agreed service amount, including any applicable VAT and contribution, before document stamp duty. */
    amount: number;
}

export function parseManualAppointmentService(body: Record<string, any>): {
    value: ManualAppointmentService | null; error?: string;
} {
    if (body.manualService === undefined) return {value: null};
    if (!body.agendaEventId || body.appointments !== undefined || body.carePackageId != null
        || [body.products, body.services].some(lines => lines !== undefined && (!Array.isArray(lines) || lines.length > 0))) {
        return {value: null, error: 'La prestazione manuale richiede un singolo appuntamento e non può essere combinata con altre righe o pacchetti'};
    }
    const manual = body.manualService;
    if (!manual || typeof manual !== 'object' || Array.isArray(manual)
        || typeof manual.description !== 'string' || !manual.description.trim() || manual.description.trim().length > 255) {
        return {value: null, error: 'Inserisci una descrizione della prestazione da 1 a 255 caratteri'};
    }
    if (typeof manual.amount !== 'number' || !Number.isFinite(manual.amount) || manual.amount <= 0
        || manual.amount > 99999999.99 || Math.abs(manual.amount * 100 - Math.round(manual.amount * 100)) > 0.000001) {
        return {value: null, error: 'Inserisci un importo maggiore di zero, con al massimo due decimali'};
    }
    return {value: {description: manual.description.trim(), amount: Math.round(manual.amount * 100) / 100}};
}

/** Preserve the existing fiscal agreement, replacing only its customer amount and description. */
export function manualAppointmentInvoiceLine(
    manual: ManualAppointmentService,
    profile: FiscalProfile,
    price?: AppointmentPrice
) {
    const policy = price?.socialSecurity ?? (price?.source === 'SNAPSHOT'
        ? contributionPolicy('NONE')
        : contributionPolicy(profile.socialSecurityFund, profile.socialSecurityPricingMode, profile.socialSecurityRate));
    const fiscal = applyAppointmentPriceSnapshot({
        source: 'SNAPSHOT', amount: manual.amount, netAmount: null,
        vatRate: price?.vatRate ?? null, socialSecurity: policy
    }, {unitPrice: manual.amount, vat: profile.defaultVatNature}, profile.appliesVat);
    return {
        id: null, quantity: 1, name: manual.description,
        ...fiscal,
        // A regime that excludes VAT always takes precedence over historical VAT.
        vat: profile.forcedVatNature ?? fiscal.vat,
        percentageDiscount: null, discountAmount: null
    };
}
