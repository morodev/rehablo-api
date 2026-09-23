/**
 * Tracciato Sistema Tessera Sanitaria — "Documenti di spesa sanitaria" (provider-neutral).
 *
 * Evoluzione dell'export best-effort `sistemaTS.ts`: modella il DETTAGLIO per voce di spesa,
 * l'importo effettivamente PAGATO, la data di pagamento, la tracciabilità del pagamento e
 * l'opposizione del cittadino, coerentemente con i gap descritti in
 * docs/analisi-piano-gestione-amministrativa-fiscale.md §3.7.
 *
 * Riferimenti: D.Lgs. 175/2014 art. 3, D.M. 31/07/2015 e specifiche tecniche pubblicate su
 * https://sistemats1.sanita.finanze.it (tracciato "Spese Sanitarie", tabella "Tipologia di spesa"
 * aggiornata periodicamente).
 *
 * VALIDAZIONE: questo modulo esegue una validazione STRUTTURALE interna. NON sostituisce la
 * validazione contro l'XSD ufficiale vigente, che va effettuata prima di ogni trasmissione reale.
 * La funzione è PURA: nessun accesso al database.
 */

export interface StsVoceSpesa {
    /** Codice tipologia di spesa (es. 'SP' per prestazioni del fisioterapista). */
    tipoSpesa: string;
    /** Importo della voce effettivamente pagato nell'anno fiscale. */
    importo: number;
}

export interface StsDocumentoSpesa {
    /** Codice fiscale dell'assistito; ignorato in trasmissione quando c'è opposizione. */
    cfCittadino: string | null;
    /** true se il cittadino si è opposto: il documento NON viene trasmesso. */
    opposizione: boolean;
    /** Data emissione del documento (YYYY-MM-DD). */
    dataEmissione: string;
    numeroDocumento: string;
    /** Data del pagamento (YYYY-MM-DD); null se non disponibile. */
    dataPagamento: string | null;
    /** true = pagamento tracciabile (POS/bonifico/…); false = contanti/non tracciabile. */
    pagamentoTracciato: boolean;
    /** true se pagamento anticipato rispetto alla prestazione. */
    pagamentoAnticipato: boolean;
    voci: StsVoceSpesa[];
}

export interface StsProprietario {
    /** Partita IVA o codice fiscale del soggetto erogatore che effettua l'invio. */
    cfProprietario: string;
    codiceRegione?: string | null;
}

const money = (value: number): string => (Math.round(value * 100) / 100).toFixed(2);
const filled = (value: string | null | undefined): boolean => typeof value === 'string' && value.trim().length > 0;
const isDate = (value: string | null | undefined): boolean => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Validazione strutturale di un documento di spesa. Ritorna gli errori bloccanti (vuoto = ok).
 * NON è la validazione XSD ufficiale.
 */
export function validateStsDocumento(doc: StsDocumentoSpesa): string[] {
    const errors: string[] = [];
    if (!doc.opposizione && !filled(doc.cfCittadino)) {
        errors.push('Codice fiscale dell’assistito mancante (obbligatorio senza opposizione).');
    }
    if (!isDate(doc.dataEmissione)) errors.push('Data di emissione non valida (YYYY-MM-DD).');
    if (!filled(doc.numeroDocumento)) errors.push('Numero documento mancante.');
    if (doc.dataPagamento !== null && !isDate(doc.dataPagamento)) errors.push('Data di pagamento non valida (YYYY-MM-DD).');
    if (doc.voci.length === 0) errors.push('Nessuna voce di spesa nel documento.');
    doc.voci.forEach((voce, index) => {
        const n = index + 1;
        if (!filled(voce.tipoSpesa)) errors.push(`Voce ${n}: tipo di spesa mancante.`);
        if (!Number.isFinite(voce.importo) || voce.importo <= 0) errors.push(`Voce ${n}: importo non valido.`);
    });
    return errors;
}

/**
 * Costruisce un documento di spesa TS dal documento fiscale e dai dati di pagamento.
 *
 * L'importo trasmesso è quello effettivamente PAGATO nell'anno fiscale (non il totale della
 * fattura): una spesa è detraibile per l'assistito solo se pagata (cfr. §3.7). Restituisce `null`
 * quando non c'è nulla da trasmettere (nessun importo pagato).
 */
export interface StsInvoiceMeta {
    documentNumber: number | null;
    documentYear: number | null;
    emissionDate: string | null;
}
export interface StsPaymentSummary {
    /** Importo pagato pertinente all'anno fiscale. */
    paidAmount: number;
    /** Data del pagamento (YYYY-MM-DD) o null. */
    paidAt: string | null;
    /** true se il pagamento è tracciabile (POS/bonifico/…). */
    traceable: boolean;
    anticipato?: boolean;
}

export function mapInvoiceToStsDocumento(params: {
    invoice: StsInvoiceMeta;
    fiscalCode: string | null;
    opposizione: boolean;
    tipoSpesa: string;
    payment: StsPaymentSummary;
}): StsDocumentoSpesa | null {
    const importo = Math.round(params.payment.paidAmount * 100) / 100;
    if (!(importo > 0)) return null;
    return {
        cfCittadino: params.fiscalCode ? params.fiscalCode.toUpperCase() : null,
        opposizione: params.opposizione,
        dataEmissione: (params.invoice.emissionDate ?? '').slice(0, 10),
        numeroDocumento: `${params.invoice.documentNumber ?? ''}`.trim() || '0',
        dataPagamento: params.payment.paidAt ? params.payment.paidAt.slice(0, 10) : null,
        pagamentoTracciato: params.payment.traceable,
        pagamentoAnticipato: Boolean(params.payment.anticipato),
        voci: [{ tipoSpesa: params.tipoSpesa, importo }],
    };
}

/** Importo totale (pagato) di un documento. */
export function stsDocumentoTotale(doc: StsDocumentoSpesa): number {
    return Math.round(doc.voci.reduce((sum, voce) => sum + voce.importo, 0) * 100) / 100;
}

function documentoXml(doc: StsDocumentoSpesa): string {
    const voci = doc.voci.map(voce =>
        `<voceSpesa><tipoSpesa>${escapeXml(voce.tipoSpesa.trim().toUpperCase())}</tipoSpesa>`
        + `<importo>${money(voce.importo)}</importo></voceSpesa>`
    ).join('');
    return `<documentoSpesa>`
        + `<cfCittadino>${escapeXml((doc.cfCittadino ?? '').trim().toUpperCase())}</cfCittadino>`
        + `<dataEmissione>${escapeXml(doc.dataEmissione)}</dataEmissione>`
        + `<numeroDocumento>${escapeXml(doc.numeroDocumento.trim())}</numeroDocumento>`
        + (doc.dataPagamento ? `<dataPagamento>${escapeXml(doc.dataPagamento)}</dataPagamento>` : '')
        + `<pagamentoTracciato>${doc.pagamentoTracciato ? 'SI' : 'NO'}</pagamentoTracciato>`
        + `<flagPagamentoAnticipato>${doc.pagamentoAnticipato ? 1 : 0}</flagPagamentoAnticipato>`
        + voci
        + `</documentoSpesa>`;
}

export interface StsTracciatoResult {
    xml: string;
    /** Documenti trasmessi (opposizione esclusa). */
    transmitted: number;
    /** Documenti esclusi per opposizione del cittadino. */
    opposed: number;
    /** Errori di validazione per documento, indicizzati per numero documento. */
    errors: string[];
}

/**
 * Genera l'XML del tracciato. I documenti con opposizione sono esclusi dalla trasmissione (ma
 * conteggiati). I documenti non validi vengono segnalati e non inclusi.
 */
export function buildStsTracciato(
    proprietario: StsProprietario,
    documenti: StsDocumentoSpesa[],
    annoFiscale: number
): StsTracciatoResult {
    const errors: string[] = [];
    let opposed = 0;
    const rows: string[] = [];

    if (!filled(proprietario.cfProprietario)) {
        errors.push('Identificativo dell’erogatore (partita IVA/codice fiscale) mancante.');
    }

    for (const doc of documenti) {
        if (doc.opposizione) { opposed++; continue; }
        const docErrors = validateStsDocumento(doc);
        if (docErrors.length > 0) {
            errors.push(`Documento ${doc.numeroDocumento || '(senza numero)'}: ${docErrors.join(' ')}`);
            continue;
        }
        rows.push(documentoXml(doc));
    }

    const proprietarioXml = `<proprietario><cfProprietario>${escapeXml(proprietario.cfProprietario.trim().toUpperCase())}</cfProprietario>`
        + (filled(proprietario.codiceRegione) ? `<codiceRegione>${escapeXml(proprietario.codiceRegione!.trim())}</codiceRegione>` : '')
        + `</proprietario>`;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>`
        + `<!-- Bozza tracciato Sistema Tessera Sanitaria, anno fiscale ${annoFiscale}. -->`
        + `<!-- ATTENZIONE: validare contro l'XSD ufficiale vigente su https://sistemats1.sanita.finanze.it prima dell'invio. -->`
        + `<invioTelematico>`
        + proprietarioXml
        + `<documentiSpesa annoFiscale="${annoFiscale}">`
        + rows.join('')
        + `</documentiSpesa>`
        + `</invioTelematico>`;

    return { xml, transmitted: rows.length, opposed, errors };
}
