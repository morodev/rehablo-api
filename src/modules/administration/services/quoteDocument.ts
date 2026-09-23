import { createHash } from 'node:crypto';

export interface QuoteDocumentSnapshot {
    version: 1;
    quoteId: string;
    number: number;
    year: number;
    displayNumber: string;
    issuedAt: string;
    expiresAt: string | null;
    currency: string;
    issuer: { businessName: string | null; vatNumber: string | null; taxCode: string | null; address: string | null; city: string | null; province: string | null; zipCode: string | null; email: string | null; phone: string | null };
    patient: { name: string | null; surname: string | null; fiscalCode: string | null };
    lines: Array<{ itemType: string; description: string; quantity: number; unitPrice: number; total: number; vatRate: number | null; vatNature: string | null }>;
    subtotal: number;
    taxTotal: number;
    total: number;
    notes: string;
}

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;

/** A whitelist: clinical notes and internal identifiers never enter a delivered document. */
export function quoteDocument(quote: Record<string, any>, patient: Record<string, any>, issuer: Record<string, any>): QuoteDocumentSnapshot {
    return {
        version: 1, quoteId: String(quote.id), number: Number(quote.number), year: Number(quote.year),
        displayNumber: `PRV-${quote.year}/${String(quote.number).padStart(4, '0')}`,
        issuedAt: String(quote.issuedAt), expiresAt: text(quote.expiresAt), currency: text(quote.currency) ?? 'EUR',
        issuer: {
            businessName: text(issuer.businessName), vatNumber: text(issuer.VATNumber ?? issuer.vatNumber),
            taxCode: text(issuer.taxCode), address: text(issuer.address), city: text(issuer.city),
            province: text(issuer.province), zipCode: text(issuer.zipCode), email: text(issuer.email), phone: text(issuer.phone)
        },
        patient: { name: text(patient.name), surname: text(patient.surname), fiscalCode: text(patient.fiscalCode) },
        lines: (Array.isArray(quote.lines) ? quote.lines : []).map((line: Record<string, any>) => ({
            itemType: String(line.itemType), description: String(line.description), quantity: Number(line.quantity),
            unitPrice: Number(line.unitPrice), total: Number(line.total),
            vatRate: line.vatRate == null ? null : Number(line.vatRate), vatNature: text(line.vatNature)
        })),
        subtotal: Number(quote.subtotal), taxTotal: Number(quote.taxTotal), total: Number(quote.total), notes: String(quote.notes ?? '')
    };
}

export function documentHash(document: QuoteDocumentSnapshot): string {
    return createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

export function quoteDateError(issuedAt: unknown, expiresAt: unknown): string | null {
    const valid = (value: unknown): value is string => typeof value === 'string'
        && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && Number.isFinite(Date.parse(value + 'T12:00:00Z'))
        && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
    if (!valid(issuedAt)) return 'Inserisci una data del preventivo valida';
    if (!valid(expiresAt)) return 'Inserisci una data di scadenza valida';
    return expiresAt < issuedAt ? 'La scadenza non può precedere la data del preventivo' : null;
}
