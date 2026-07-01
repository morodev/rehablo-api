/**
 * Sistema Tessera Sanitaria (STS) - export dati di spesa sanitaria.
 *
 * Riferimenti normativi:
 * - D.Lgs. 21 novembre 2014, n. 175, art. 3 (obbligo di trasmissione telematica al Sistema TS
 *   dei dati delle spese sanitarie, ai fini della dichiarazione dei redditi precompilata 730/Redditi PF).
 * - D.M. 31/07/2015 e specifiche tecniche pubblicate su https://sistemats1.sanita.finanze.it
 *   (tracciato "Dati fiscali detraibili", tabelle "Tipologia di spesa" aggiornate periodicamente).
 * - Provvedimento Agenzia Entrate 22/12/2022 (proroghe/scadenze invio) e succ. aggiornamenti.
 *
 * IMPORTANTE: questo modulo produce una rappresentazione XML "best effort" del tracciato, utile
 * come base di lavoro e per test interni. Prima di un invio reale al Sistema TS è OBBLIGATORIO:
 *   1) Accreditarsi sul portale Sistema TS (https://sistemats1.sanita.finanze.it) con le
 *      credenziali della Partita IVA/Codice Fiscale del professionista/struttura.
 *   2) Scaricare ed applicare l'ultimo "tracciato record" e l'ultima tabella "Tipologia di spesa"
 *      pubblicati dal Sistema TS per l'anno fiscale di competenza (i codici possono cambiare).
 *   3) Validare l'XML generato con l'XSD ufficiale fornito dal Sistema TS prima della trasmissione
 *      (via web service o upload sul portale).
 *
 * Il fisioterapista, in quanto professione sanitaria riabilitativa riconosciuta (L. 3/2018,
 * art. 1 comma 313 e succ.) iscritta all'Albo unico TSRM-PSTRP, rientra tra i soggetti tenuti
 * all'invio se la prestazione è resa in libera professione a persone fisiche.
 */

import { InvoiceAttributes } from '../models/invoice.model.js';
import { PatientAttributes } from '../../patients/models/patient.model.js';
import { TenantAttributes } from '../../auth/models/tenant.model.js';

export interface SistemaTSRecordInput {
    invoice: Pick<
        InvoiceAttributes,
        'id' | 'documentNumber' | 'documentYear' | 'emissionDate' | 'invoiceTotal' | 'stsExpenseTypeCode'
    >;
    patient: Pick<PatientAttributes, 'name' | 'surname' | 'fiscalCode' | 'stsOppositionToDataSending'>;
    tenant: Pick<TenantAttributes, 'VATNumber' | 'taxCode' | 'businessName'>;
}

export interface SistemaTSRecord {
    partitaIvaErogatore: string;
    codiceFiscalePaziente: string;
    dataDocumento: string; // formato YYYY-MM-DD
    numeroDocumento: string;
    annoFiscale: number;
    importo: number;
    tipoSpesa: string;
    flagOpposizione: 0 | 1;
}

/** Codice di default per la tabella "Tipologia di spesa" del Sistema TS. Deve essere confermato
 *  sull'ultima tabella ufficiale pubblicata (può variare per anno di imposta). */
export const DEFAULT_STS_EXPENSE_TYPE_CODE = 'PRESTAZIONE_SANITARIA_FISIOTERAPICA';

export function buildSistemaTSRecord({ invoice, patient, tenant }: SistemaTSRecordInput): SistemaTSRecord {
    if (!patient.fiscalCode) {
        throw new Error('Impossibile generare il record Sistema TS: codice fiscale paziente mancante');
    }
    if (!tenant.VATNumber && !tenant.taxCode) {
        throw new Error('Impossibile generare il record Sistema TS: dati fiscali dello studio/professionista mancanti');
    }

    return {
        partitaIvaErogatore: tenant.VATNumber || tenant.taxCode || '',
        codiceFiscalePaziente: patient.fiscalCode.toUpperCase(),
        dataDocumento: invoice.emissionDate ? new Date(invoice.emissionDate).toISOString().slice(0, 10) : '',
        numeroDocumento: `${invoice.documentNumber ?? ''}`,
        annoFiscale: invoice.documentYear ?? new Date().getFullYear(),
        importo: Number(invoice.invoiceTotal ?? 0),
        tipoSpesa: invoice.stsExpenseTypeCode || DEFAULT_STS_EXPENSE_TYPE_CODE,
        flagOpposizione: patient.stsOppositionToDataSending ? 1 : 0
    };
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Genera un file XML aggregato con i record da trasmettere al Sistema TS.
 * I record con `flagOpposizione = 1` (paziente che si è opposto) NON devono essere inclusi:
 * vengono filtrati automaticamente qui, ma la fattura resta comunque tra i "documenti esclusi"
 * ai fini della tracciabilità interna dello studio.
 */
export function generateSistemaTSXml(records: SistemaTSRecord[], fiscalYear: number): string {
    const eligible = records.filter((r) => r.flagOpposizione === 0);

    const rows = eligible
        .map(
            (r) => `  <spesaSanitaria>
    <partitaIvaErogatore>${escapeXml(r.partitaIvaErogatore)}</partitaIvaErogatore>
    <codiceFiscalePaziente>${escapeXml(r.codiceFiscalePaziente)}</codiceFiscalePaziente>
    <dataDocumento>${escapeXml(r.dataDocumento)}</dataDocumento>
    <numeroDocumento>${escapeXml(r.numeroDocumento)}</numeroDocumento>
    <importo>${r.importo.toFixed(2)}</importo>
    <tipoSpesa>${escapeXml(r.tipoSpesa)}</tipoSpesa>
  </spesaSanitaria>`
        )
        .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Bozza di export Sistema Tessera Sanitaria, anno fiscale ${fiscalYear}. -->
<!-- ATTENZIONE: verificare tracciato/XSD ufficiale su https://sistemats1.sanita.finanze.it prima dell'invio. -->
<invioSistemaTS annoFiscale="${fiscalYear}">
${rows}
</invioSistemaTS>
`;
}

