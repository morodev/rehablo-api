import { isPlausibleEmail, primaryPatientEmail } from '../../invoice/utils/invoiceShare.js';

export type QuoteDeliveryChannel = 'email' | 'whatsapp';

const dialCodes: Record<string, string> = { it: '39', sm: '378', va: '379', ch: '41', fr: '33', de: '49', at: '43', es: '34', gb: '44', us: '1', ie: '353', be: '32', nl: '31', pt: '351', si: '386', hr: '385', gr: '30', ro: '40', pl: '48', al: '355' };

export function quotePhone(value: unknown, country: unknown = 'it'): string | null {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const cleaned = raw.replace(/[^\d+]/g, '');
    const digits = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned.startsWith('00') ? cleaned.slice(2)
        : (dialCodes[String(country).toLowerCase()] ?? '39') + cleaned.replace(/^0+/, '');
    return /^[1-9]\d{7,14}$/.test(digits) ? '+' + digits : null;
}

export function quoteRecipient(channel: QuoteDeliveryChannel, requested: unknown, patient: Record<string, any>): string | null {
    const supplied = String(requested ?? '').trim();
    if (channel === 'email') {
        const value = supplied || primaryPatientEmail(patient.emails) || patient.contactEmail;
        return isPlausibleEmail(value) ? String(value).trim().toLowerCase() : null;
    }
    if (supplied) return quotePhone(supplied);
    for (const item of Array.isArray(patient.phoneNumbers) ? patient.phoneNumbers : []) {
        const value = quotePhone(item?.phoneNumber, item?.country);
        if (value) return value;
    }
    return quotePhone(patient.contactMobilePhone);
}

export function quoteConsentAllows(channel: QuoteDeliveryChannel, patient: Record<string, any>): boolean {
    return patient[channel === 'email' ? 'emailNotificationsConsent' : 'whatsappNotificationsConsent'] !== false;
}
