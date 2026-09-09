/**
 * Funzioni pure del link di consegna della fattura.
 *
 * Stanno separate dal controller perché sono la parte che decide COSA il paziente vede e A CHI si
 * manda: due scelte che vanno bloccate da test, non verificate a mano aprendo un link.
 */

/** Dati minimi dell'emittente che devono comparire sul documento. */
export interface PublicInvoiceIssuer {
    businessName: string | null;
    vatNumber: string | null;
    taxCode: string | null;
    address: string | null;
    city: string | null;
    province: string | null;
    zipCode: string | null;
    email: string | null;
    phone: string | null;
    pec: string | null;
    taxRegime: string | null;
}

export interface PublicInvoicePayload {
    id: string;
    documentType: string | null;
    documentNumber: number | null;
    documentYear: number | null;
    emissionDate: string | null;
    paymentTerms: string | null;
    paymentMethod: string | null;
    sellingPrice: number | null;
    discSellingPrice: number | null;
    invoiceVAT: number | null;
    invoiceTotal: number | null;
    invoiceNet: number | null;
    isStamp: boolean;
    stampAmount: number | null;
    stampChargedToPatient: boolean;
    paymentStatus: string | null;
    fiscalNotes: string[];
    issuer: PublicInvoiceIssuer | null;
    products: unknown[];
    services: unknown[];
    recipient: { name: string; address: string | null; fiscalCode: string | null } | null;
}

function asNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function asString(value: unknown): string | null {
    const text = `${value ?? ''}`.trim();
    return text ? text : null;
}

/**
 * Riduce la fattura a ciò che appartiene al documento consegnato.
 *
 * È una whitelist e non una blacklist di proposito: la fattura interna porta con sé pagamenti
 * registrati, stato Sistema TS, collegamenti agli appuntamenti e riferimenti interni. Con una
 * blacklist ogni campo aggiunto in futuro finirebbe automaticamente in mano al paziente; così
 * invece un campo nuovo resta invisibile finché qualcuno non decide esplicitamente di esporlo.
 */
export function buildPublicInvoicePayload(
    invoice: Record<string, any>,
    patient?: Record<string, any> | null
): PublicInvoicePayload {
    const issuer = invoice.issuer as Record<string, any> | null | undefined;

    return {
        id: String(invoice.id),
        documentType: asString(invoice.documentType),
        documentNumber: asNumber(invoice.documentNumber),
        documentYear: asNumber(invoice.documentYear),
        emissionDate: asString(invoice.emissionDate),
        paymentTerms: asString(invoice.paymentTerms),
        paymentMethod: asString(invoice.paymentMethod),
        sellingPrice: asNumber(invoice.sellingPrice),
        discSellingPrice: asNumber(invoice.discSellingPrice),
        invoiceVAT: asNumber(invoice.invoiceVAT),
        invoiceTotal: asNumber(invoice.invoiceTotal),
        invoiceNet: asNumber(invoice.invoiceNet),
        isStamp: !!invoice.isStamp,
        stampAmount: asNumber(invoice.stampAmount),
        stampChargedToPatient: !!invoice.stampChargedToPatient,
        // Serve solo a marcare come "annullato" un documento stornato: senza, il paziente
        // potrebbe presentare al commercialista una fattura che non è più valida.
        paymentStatus: asString(invoice.paymentStatus ?? invoice.status),
        fiscalNotes: Array.isArray(invoice.fiscalNotes) ? invoice.fiscalNotes.map(String) : [],
        issuer: issuer
            ? {
                businessName: asString(issuer.businessName),
                vatNumber: asString(issuer.vatNumber),
                taxCode: asString(issuer.taxCode),
                address: asString(issuer.address),
                city: asString(issuer.city),
                province: asString(issuer.province),
                zipCode: asString(issuer.zipCode),
                email: asString(issuer.email),
                phone: asString(issuer.phone),
                pec: asString(issuer.pec),
                taxRegime: asString(issuer.taxRegime)
            }
            : null,
        products: (invoice.products ?? []).map((line: Record<string, any>) => ({
            productName: asString(line.productName),
            quantity: asNumber(line.quantity) ?? 1,
            productPrice: asNumber(line.productPrice) ?? 0,
            totalPrice: asNumber(line.totalPrice) ?? 0,
            productVat: asString(line.productVat)
        })),
        services: (invoice.services ?? []).map((line: Record<string, any>) => ({
            serviceName: asString(line.serviceName),
            quantity: asNumber(line.quantity) ?? 1,
            servicePrice: asNumber(line.servicePrice) ?? 0,
            originalServicePrice: asNumber(line.originalServicePrice),
            totalPrice: asNumber(line.totalPrice) ?? 0,
            serviceVat: asString(line.serviceVat)
        })),
        recipient: patient
            ? {
                name: [patient.name, patient.surname].filter(Boolean).join(' ').trim(),
                address: asString(patient.address),
                fiscalCode: asString(patient.fiscalCode)
            }
            : null
    };
}

/** Forma degli indirizzi memorizzati in `patient.emails`. */
export interface PatientEmailEntry extends Record<string, unknown> {
    email: string;
    label?: string;
}

export function normalizeEmail(value: unknown): string {
    return `${value ?? ''}`.trim().toLowerCase();
}

/**
 * Accettiamo solo indirizzi sintatticamente plausibili. Non è una validazione RFC completa (che
 * non esiste in una regex): serve a fermare gli errori di battitura prima di consumare un invio.
 */
export function isPlausibleEmail(value: unknown): boolean {
    const email = normalizeEmail(value);
    return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) && email.length <= 254;
}

/** Primo indirizzo utilizzabile dell'anagrafica, o `null` se il paziente non ne ha. */
export function primaryPatientEmail(emails: unknown): string | null {
    if (!Array.isArray(emails)) return null;
    for (const entry of emails) {
        const candidate = (entry as PatientEmailEntry | null)?.email;
        if (isPlausibleEmail(candidate)) {
            return `${candidate}`.trim();
        }
    }
    return null;
}

/**
 * Aggiunge l'indirizzo all'anagrafica senza perdere quelli esistenti e senza duplicarlo.
 * Ritorna `null` quando non c'è nulla da salvare, così il chiamante evita una scrittura inutile.
 */
export function withPatientEmail(
    emails: unknown,
    email: string,
    label = 'Fatturazione'
): PatientEmailEntry[] | null {
    const existing: PatientEmailEntry[] = Array.isArray(emails)
        ? (emails as PatientEmailEntry[]).filter(entry => !!entry && typeof entry === 'object')
        : [];

    const normalized = normalizeEmail(email);
    if (existing.some(entry => normalizeEmail(entry.email) === normalized)) {
        return null;
    }

    return [...existing, { email: `${email}`.trim(), label }];
}
