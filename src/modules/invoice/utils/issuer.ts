import { TenantAttributes } from '../../auth/models/tenant.model.js';
import { InvoiceIssuerSnapshot } from '../models/invoice.model.js';
import { getTaxRegime } from './fiscalRegime.js';

/**
 * Dati del CEDENTE/PRESTATORE richiesti per emettere un documento fiscale valido.
 *
 * Riferimento: art. 21 comma 2 DPR 633/72, che impone in fattura "ditta, denominazione o
 * ragione sociale, residenza o domicilio" e "numero di partita IVA" del soggetto che
 * effettua la cessione o prestazione.
 *
 * Il codice fiscale è ammesso in alternativa alla partita IVA per chi ne è privo, quindi
 * viene richiesto almeno uno dei due. La provincia non è bloccante (l'indirizzo resta
 * identificabile senza) ma viene comunque salvata nello snapshot.
 */

export interface IssuerRequirement {
    field: keyof TenantAttributes | 'VATNumber|taxCode';
    label: string;
}

const REQUIRED_FIELDS: IssuerRequirement[] = [
    { field: 'businessName', label: 'Ragione sociale' },
    { field: 'VATNumber|taxCode', label: 'Partita IVA o Codice fiscale' },
    { field: 'address', label: 'Indirizzo' },
    { field: 'city', label: 'Città' },
    { field: 'zipCode', label: 'CAP' }
];

type TenantLike = Partial<Record<keyof TenantAttributes, unknown>>;

function isFilled(value: unknown): boolean {
    return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;
}

/** Elenco delle etichette dei dati mancanti. Vuoto = si può fatturare. */
export function getMissingIssuerFields(tenant: TenantLike | null | undefined): string[] {
    if (!tenant) {
        return REQUIRED_FIELDS.map((requirement) => requirement.label);
    }

    return REQUIRED_FIELDS.filter((requirement) => {
        if (requirement.field === 'VATNumber|taxCode') {
            return !isFilled(tenant.VATNumber) && !isFilled(tenant.taxCode);
        }
        return !isFilled(tenant[requirement.field as keyof TenantAttributes]);
    }).map((requirement) => requirement.label);
}

export function canIssueInvoice(tenant: TenantLike | null | undefined): boolean {
    return getMissingIssuerFields(tenant).length === 0;
}

/** Congela i dati dell'emittente da salvare sul documento. */
export function buildIssuerSnapshot(tenant: TenantLike): InvoiceIssuerSnapshot {
    const asString = (value: unknown): string | null =>
        typeof value === 'string' && value.trim() ? value.trim() : null;

    return {
        businessName: asString(tenant.businessName),
        vatNumber: asString(tenant.VATNumber),
        taxCode: asString(tenant.taxCode),
        address: asString(tenant.address),
        city: asString(tenant.city),
        province: asString(tenant.province),
        zipCode: asString(tenant.zipCode),
        pec: asString(tenant.pec),
        email: asString(tenant.email),
        phone: asString(tenant.phone),
        // Il regime è risolto (non copiato grezzo) così un valore assente o sporco diventa
        // comunque un codice valido: sulle vecchie fatture ricadrebbe altrimenti a `null`,
        // rendendo impossibile ristampare le diciture corrette.
        taxRegime: getTaxRegime(tenant.taxRegime as string | null | undefined).code
    };
}

