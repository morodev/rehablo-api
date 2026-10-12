import type { InvoiceIssuerSnapshot, InvoiceRecipientSnapshot } from '../models/invoice.model.js';
import type { FatturaPaInput, FatturaPaLine, TipoDocumento } from './fatturaPa.js';
import type { FiscalRoutingLine } from '../../administration/services/fiscalRouting.service.js';
import { FiscalExportError, reconcileInvoiceEconomics } from './invoiceEconomics.js';
import type { FrozenEconomicDocument, FrozenEconomicLine } from './invoiceEconomics.js';

/**
 * Mapper puro dal documento (snapshot immutabili + righe) all'input del generatore FatturaPA.
 * Non accede al database: il chiamante fornisce gli snapshot già risolti e le righe di fattura.
 */

export interface InvoiceLineLike extends FrozenEconomicLine {
    kind: 'PRODUCT' | 'SERVICE';
    name: string | null;
    /** Aliquota numerica ("22") oppure codice natura ("N4"), come congelato sulla riga. */
    vat: string | null;
    quantity: number | string | null;
    unitPrice: number | string | null;
}

export interface InvoiceDocumentMeta extends FrozenEconomicDocument {
    documentType: string | null;
    documentNumber: number | null;
    documentYear: number | null;
    emissionDate: string | null;
    isStamp?: boolean;
    stampAmount?: number | string | null;
    stampChargedToPatient?: boolean;
}

/** Interpreta il valore IVA congelato sulla riga: aliquota positiva oppure natura di esenzione. */
export function parseLineVat(vat: string | null): { vatRate: number; natura: string | null } {
    const value = (vat ?? '').trim();
    if (!value) return { vatRate: 0, natura: null };
    if (/^n/i.test(value)) return { vatRate: 0, natura: value.toUpperCase() };
    const numeric = Number(value.replace(',', '.').replace('%', ''));
    if (Number.isFinite(numeric) && numeric > 0) return { vatRate: numeric, natura: null };
    return { vatRate: 0, natura: null };
}

/**
 * Classificazione sanitaria di default per un fisioterapista: le prestazioni (servizi) sono
 * sanitarie, i prodotti no. È un default esplicito e sostituibile quando il catalogo avrà un
 * flag proprio; finché non esiste, non si "indovina" oltre questa regola dichiarata.
 */
export function invoiceRoutingLines(lines: InvoiceLineLike[]): FiscalRoutingLine[] {
    return lines.map(line => ({
        kind: line.kind === 'SERVICE' ? 'SERVICE' : 'PRODUCT',
        isHealthcare: line.kind === 'SERVICE',
    }));
}

function mapTipoDocumento(documentType: string | null): TipoDocumento {
    return String(documentType ?? '').toLowerCase() === 'nota_di_credito' ? 'TD04' : 'TD01';
}

export interface MapInvoiceParams {
    issuer: InvoiceIssuerSnapshot;
    recipient: InvoiceRecipientSnapshot;
    lines: InvoiceLineLike[];
    document: InvoiceDocumentMeta;
    /** Progressivo univoco del file di invio. */
    progressivo: string;
}

/** Costruisce l'input FatturaPA dal documento immutabile. */
export function mapInvoiceToFatturaPa({ issuer, recipient, lines, document, progressivo }: MapInvoiceParams): FatturaPaInput {
    if (!issuer || !recipient) throw new FiscalExportError('INCOMPLETE_FISCAL_SNAPSHOT', 'Snapshot emittente o destinatario assente: nessun ripiego sui dati correnti.');
    if (!Number.isInteger(Number(document.documentNumber)) || Number(document.documentNumber) <= 0
        || !Number.isInteger(Number(document.documentYear)) || Number(document.documentYear) < 1000
        || Number(document.documentYear) > 9999 || !document.emissionDate) {
        throw new FiscalExportError('INCOMPLETE_FISCAL_SNAPSHOT', 'Numero, anno o data del documento mancanti.');
    }
    const date = String(document.emissionDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
        || new Date(date).toISOString().slice(0, 10) !== date) {
        throw new FiscalExportError('INVALID_FISCAL_SNAPSHOT', 'Data di emissione non valida.');
    }
    if (!['fattura', 'nota_di_credito'].includes(String(document.documentType).toLowerCase())) {
        throw new FiscalExportError('UNSUPPORTED_FISCAL_METADATA', 'Tipo documento non supportato per FatturaPA.');
    }
    const economics = reconcileInvoiceEconomics(document, lines, issuer.taxRegime);
    const senderCode = issuer.vatNumber ?? issuer.taxCode ?? '';
    const codiceDestinatario = recipient.sdiCode && recipient.sdiCode.trim() ? recipient.sdiCode.trim().toUpperCase() : '0000000';

    return {
        transmission: {
            senderCountry: 'IT',
            senderCode,
            progressivo,
            codiceDestinatario,
            pecDestinatario: recipient.pec,
        },
        cedente: {
            denominazione: issuer.businessName,
            vatCountry: issuer.vatNumber ? 'IT' : null,
            vatNumber: issuer.vatNumber,
            taxCode: issuer.taxCode,
            address: issuer.address,
            zip: issuer.zipCode,
            city: issuer.city,
            province: issuer.province,
            country: 'IT',
            regimeFiscale: issuer.taxRegime!.trim().toUpperCase(),
        },
        cessionario: {
            denominazione: recipient.kind === 'BUSINESS' ? recipient.businessName : null,
            nome: recipient.kind === 'BUSINESS' ? null : recipient.firstName,
            cognome: recipient.kind === 'BUSINESS' ? null : recipient.lastName,
            vatCountry: recipient.vatNumber ? 'IT' : null,
            vatNumber: recipient.vatNumber,
            taxCode: recipient.taxCode,
            address: recipient.address,
            zip: recipient.zipCode,
            city: recipient.city,
            province: recipient.province,
            country: recipient.country ?? 'IT',
        },
        document: {
            tipoDocumento: mapTipoDocumento(document.documentType),
            data: (document.emissionDate ?? '').slice(0, 10),
            numero: `${document.documentNumber ?? ''}`.trim() || '0',
            divisa: 'EUR',
            bollo: document.isStamp ? { virtuale: true, importo: Number(document.stampAmount),
                chargedToCustomer: document.stampChargedToPatient === true } : null,
        },
        lines: economics.lines.map((line, index): FatturaPaLine => ({
            description: (lines[index].name ?? '').trim() || 'Voce', ...line
        })),
        expectedTotal: economics.totals.invoiceTotal,
    };
}

/** Complete adapter shared by download and transmission. No current tenant/patient fallbacks. */
export function frozenInvoiceToFatturaPaParams(invoice: Record<string, any>): MapInvoiceParams {
    const toLine = (line: Record<string, any>, kind: 'PRODUCT' | 'SERVICE'): InvoiceLineLike => ({
        kind, name: kind === 'PRODUCT' ? line.productName : line.serviceName,
        vat: kind === 'PRODUCT' ? line.productVat : line.serviceVat,
        unitPrice: kind === 'PRODUCT' ? line.productPrice : line.servicePrice,
        quantity: line.quantity, totalPrice: line.totalPrice,
        percentageDiscount: line.percentageDiscount, discountAmount: line.discountAmount
    });
    // Stable order for allocation residuals; never sort the caller's arrays in place.
    const sorted = (rows: Record<string, any>[]) => [...rows].sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
    const date = invoice.emissionDate instanceof Date ? invoice.emissionDate.toISOString().slice(0, 10) : invoice.emissionDate;
    return {
        issuer: invoice.issuer, recipient: invoice.recipient,
        lines: [...sorted(invoice.products ?? []).map(line => toLine(line, 'PRODUCT')),
            ...sorted(invoice.services ?? []).map(line => toLine(line, 'SERVICE'))],
        document: { ...invoice, documentType: invoice.documentType, documentNumber: invoice.documentNumber,
            documentYear: invoice.documentYear, emissionDate: date },
        progressivo: `${invoice.documentYear ?? ''}${String(invoice.documentNumber ?? '').padStart(5, '0')}`.slice(0, 10)
    };
}
