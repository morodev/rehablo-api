/**
 * Builder del payload fiscale reale (provider-neutral): trasforma un documento immutabile nel
 * contenuto da trasmettere sul canale scelto, riusando i generatori FatturaPA (SDI) e tracciato
 * Sistema TS. Funzione pura: nessun accesso al database.
 *
 * Restituisce sempre l'esito della validazione strutturale interna: se ci sono errori, `xml` è
 * null e la submission non deve avanzare a SUBMITTED.
 */

import { buildFatturaPaXml, validateFatturaPaInput } from '../../invoice/utils/fatturaPa.js';
import { MapInvoiceParams, mapInvoiceToFatturaPa, frozenInvoiceToFatturaPaParams } from '../../invoice/utils/invoiceFatturaPa.js';
import {
    StsInvoiceMeta,
    StsPaymentSummary,
    StsProprietario,
    buildStsTracciato,
    mapInvoiceToStsDocumento,
} from '../../invoice/utils/sistemaTsTracciato.js';

export interface FiscalPayloadResult {
    channel: 'SDI' | 'STS';
    format: string;
    /** XML pronto per la trasmissione, oppure null se la validazione strutturale è fallita. */
    xml: string | null;
    errors: string[];
}

/** Costruisce il payload FatturaPA per lo SDI a partire dal documento immutabile. */
export function buildSdiPayload(params: MapInvoiceParams): FiscalPayloadResult {
    try {
        const input = mapInvoiceToFatturaPa(params);
        const errors = validateFatturaPaInput(input);
        if (errors.length > 0) return { channel: 'SDI', format: 'FatturaPA-FPR12', xml: null, errors };
        return { channel: 'SDI', format: 'FatturaPA-FPR12', xml: buildFatturaPaXml(input), errors: [] };
    } catch (error) {
        return { channel: 'SDI', format: 'FatturaPA-FPR12', xml: null, errors: [(error as Error).message] };
    }
}

/** Both HTTP download and provider transmission must use this frozen-data entry point. */
export function buildSdiPayloadFromInvoice(invoice: Record<string, any>): FiscalPayloadResult {
    try {
        return buildSdiPayload(frozenInvoiceToFatturaPaParams(invoice));
    } catch {
        return { channel: 'SDI', format: 'FatturaPA-FPR12', xml: null,
            errors: ['INVALID_FISCAL_SNAPSHOT: documento o righe congelate non validi.'] };
    }
}

export interface StsPayloadParams {
    proprietario: StsProprietario;
    invoice: StsInvoiceMeta;
    fiscalCode: string | null;
    opposizione: boolean;
    tipoSpesa: string;
    payment: StsPaymentSummary;
    annoFiscale: number;
}

/** Costruisce il payload del tracciato Sistema TS per un singolo documento di spesa. */
export function buildStsPayload(params: StsPayloadParams): FiscalPayloadResult {
    const doc = mapInvoiceToStsDocumento({
        invoice: params.invoice,
        fiscalCode: params.fiscalCode,
        opposizione: params.opposizione,
        tipoSpesa: params.tipoSpesa,
        payment: params.payment,
    });
    if (!doc) {
        return { channel: 'STS', format: 'SistemaTS', xml: null, errors: ['Nessun importo pagato da trasmettere al Sistema TS.'] };
    }
    if (params.opposizione) {
        return { channel: 'STS', format: 'SistemaTS', xml: null, errors: ['Il paziente si è opposto: nessun invio al Sistema TS.'] };
    }
    const result = buildStsTracciato(params.proprietario, [doc], params.annoFiscale);
    if (result.errors.length > 0 || result.transmitted === 0) {
        return { channel: 'STS', format: 'SistemaTS', xml: null, errors: result.errors.length ? result.errors : ['Documento non trasmissibile al Sistema TS.'] };
    }
    return { channel: 'STS', format: 'SistemaTS', xml: result.xml, errors: [] };
}
