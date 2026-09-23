import { InvoiceRecipientSnapshot } from '../models/invoice.model.js';

/**
 * Congela i dati del CESSIONARIO/COMMITTENTE sul documento all'emissione.
 *
 * Il destinatario naturale è il paziente (che nel modello attuale coincide con il cliente
 * fatturato). Se in futuro viene collegato un `BillingParty` distinto (azienda, assicurazione,
 * familiare pagatore), lo si passa qui e prevale: il documento deve riportare chi è realmente
 * intestatario, non necessariamente il paziente assistito.
 *
 * Perché uno snapshot e non un riferimento vivo: la stessa ragione di `issuer` e delle righe
 * `productName`/`productVat`. Un documento già emesso (o già trasmesso a SDI/Sistema TS) deve
 * continuare a riportare i dati validi alla data di emissione, anche se l'anagrafica cambia dopo.
 */

export interface PatientLike {
    name?: string | null;
    surname?: string | null;
    fiscalCode?: string | null;
    address?: string | null;
    emails?: unknown;
}

export interface BillingPartyLike {
    type?: string | null;
    businessName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    taxCode?: string | null;
    vatNumber?: string | null;
    address?: string | null;
    city?: string | null;
    province?: string | null;
    postalCode?: string | null;
    country?: string | null;
    sdiCode?: string | null;
    pec?: string | null;
    email?: string | null;
}

const asString = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;

/** Primo indirizzo email valorizzato in una lista dalla forma libera dell'anagrafica paziente. */
function firstEmail(emails: unknown): string | null {
    if (!Array.isArray(emails)) return null;
    for (const entry of emails) {
        if (typeof entry === 'string') {
            const value = asString(entry);
            if (value) return value;
        } else if (entry && typeof entry === 'object') {
            const record = entry as Record<string, unknown>;
            const value = asString(record.email) ?? asString(record.value) ?? asString(record.address);
            if (value) return value;
        }
    }
    return null;
}

function fromBillingParty(party: BillingPartyLike): InvoiceRecipientSnapshot {
    const hasVat = Boolean(asString(party.vatNumber));
    const isBusiness = String(party.type ?? '').toUpperCase() === 'BUSINESS'
        || hasVat || (!!asString(party.businessName) && !asString(party.firstName));
    return {
        kind: isBusiness ? 'BUSINESS' : 'PERSON',
        businessName: asString(party.businessName),
        firstName: asString(party.firstName),
        lastName: asString(party.lastName),
        taxCode: asString(party.taxCode),
        vatNumber: asString(party.vatNumber),
        address: asString(party.address),
        city: asString(party.city),
        province: asString(party.province),
        zipCode: asString(party.postalCode),
        country: asString(party.country) ?? 'IT',
        sdiCode: asString(party.sdiCode),
        pec: asString(party.pec),
        email: asString(party.email),
    };
}

/**
 * Costruisce lo snapshot del destinatario. Con un `billingParty` esplicito prevale l'intestatario;
 * altrimenti il destinatario è il paziente (persona fisica). Restituisce `null` solo se non ci sono
 * dati sufficienti (nessun paziente e nessun intestatario).
 */
export function buildRecipientSnapshot(
    patient: PatientLike | null | undefined,
    billingParty?: BillingPartyLike | null
): InvoiceRecipientSnapshot | null {
    if (billingParty) return fromBillingParty(billingParty);
    if (!patient) return null;
    return {
        kind: 'PERSON',
        businessName: null,
        firstName: asString(patient.name),
        lastName: asString(patient.surname),
        taxCode: asString(patient.fiscalCode),
        vatNumber: null,
        // L'anagrafica paziente conserva un indirizzo su riga singola: città/provincia/CAP restano
        // null finché non vengono scomposti (necessari per la FatturaPA, non per il Sistema TS).
        address: asString(patient.address),
        city: null,
        province: null,
        zipCode: null,
        country: 'IT',
        sdiCode: null,
        pec: null,
        email: firstEmail(patient.emails),
    };
}
