import { InvoiceIssuerSnapshot, InvoiceRecipientSnapshot } from '../models/invoice.model.js';
import { FatturaPaInput, FatturaPaLine, TipoDocumento } from './fatturaPa.js';
import { FiscalRoutingLine } from '../../administration/services/fiscalRouting.service.js';

/**
 * Mapper puro dal documento (snapshot immutabili + righe) all'input del generatore FatturaPA.
 * Non accede al database: il chiamante fornisce gli snapshot già risolti e le righe di fattura.
 */

export interface InvoiceLineLike {
    kind: 'PRODUCT' | 'SERVICE';
    name: string | null;
    /** Aliquota numerica ("22") oppure codice natura ("N4"), come congelato sulla riga. */
    vat: string | null;
    quantity: number | null;
    unitPrice: number | null;
}

export interface InvoiceDocumentMeta {
    documentType: string | null;
    documentNumber: number | null;
    documentYear: number | null;
    emissionDate: string | null;
    isStamp?: boolean;
    stampAmount?: number | null;
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

function toFatturaLine(line: InvoiceLineLike): FatturaPaLine {
    const { vatRate, natura } = parseLineVat(line.vat);
    return {
        description: (line.name ?? '').trim() || 'Voce',
        quantity: Number(line.quantity ?? 1) || 1,
        unitPrice: Number(line.unitPrice ?? 0) || 0,
        vatRate,
        natura,
    };
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
    const senderCode = issuer.vatNumber ?? issuer.taxCode ?? '';
    const codiceDestinatario = recipient.sdiCode && recipient.sdiCode.trim() ? recipient.sdiCode.trim().toUpperCase() : '0000000';
    const stampCharged = Boolean(document.isStamp && document.stampChargedToPatient && (document.stampAmount ?? 0) > 0);

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
            regimeFiscale: issuer.taxRegime ?? 'RF01',
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
            bollo: stampCharged ? { virtuale: true, importo: Number(document.stampAmount) } : null,
        },
        lines: lines.map(toFatturaLine),
    };
}
