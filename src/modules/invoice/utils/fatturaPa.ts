/**
 * Generatore FatturaPA (formato privati FPR12) — provider-neutral.
 *
 * Produce l'XML della fattura elettronica secondo la struttura delle specifiche tecniche
 * Agenzia delle Entrate v1.2.x (FatturaElettronica: Header + Body). È una funzione PURA:
 * riceve un input già normalizzato dal documento IMMUTABILE (snapshot emittente/destinatario,
 * righe, totali) e non accede al database.
 *
 * VALIDAZIONE: questo modulo esegue una validazione STRUTTURALE interna (campi obbligatori,
 * formati, coerenza natura/aliquota). NON sostituisce la validazione contro l'XSD ufficiale
 * `Schema_VFPR12.xsd`, che va effettuata prima di qualunque trasmissione reale allo SdI.
 *
 * L'instradamento SDI vs Sistema TS è deciso a monte da `fiscalRouting.service.ts`: qui si
 * assume che il documento vada effettivamente allo SdI.
 */

import { invoiceAmountInCents, roundInvoiceAmount } from './evalTotals.js';

export type TipoDocumento = 'TD01' | 'TD04' | 'TD05' | 'TD24';

export interface FatturaPaTransmission {
    /** Paese del trasmittente (ISO 3166-1 alpha-2), tipicamente 'IT'. */
    senderCountry: string;
    /** Identificativo del trasmittente (di norma la partita IVA/codice fiscale dell'emittente). */
    senderCode: string;
    /** Progressivo univoco del file di invio (alfanumerico). */
    progressivo: string;
    /** Codice destinatario a 7 caratteri; '0000000' per B2C o quando si usa la PEC. */
    codiceDestinatario: string;
    pecDestinatario?: string | null;
}

export interface FatturaPaParty {
    denominazione?: string | null;
    nome?: string | null;
    cognome?: string | null;
    /** Paese della partita IVA (ISO alpha-2). Se presente insieme a vatNumber genera IdFiscaleIVA. */
    vatCountry?: string | null;
    vatNumber?: string | null;
    taxCode?: string | null;
    address?: string | null;
    zip?: string | null;
    city?: string | null;
    province?: string | null;
    country?: string | null;
}

export interface FatturaPaLine {
    withholding?: boolean;
    description: string;
    quantity: number;
    /** Prezzo unitario netto (imponibile). */
    unitPrice: number;
    /** Aliquota IVA in percentuale (es. 22, 10, 0). */
    vatRate: number;
    /** Codice natura (es. 'N4' esente) — obbligatorio quando l'aliquota è 0. */
    natura?: string | null;
    /** Frozen discounted line base, reconciled before serialization. */
    netAmount?: number;
    /** Document discount allocated to this unit; not an additional discount. */
    discountUnitAmount?: number;
}

export interface FatturaPaBollo {
    /** true se sul documento è assolto il bollo virtuale. */
    virtuale: boolean;
    importo: number;
    /** Declaration of virtual stamp is independent from charging it to the customer. */
    chargedToCustomer?: boolean;
}

export interface FatturaPaInput {
    transmission: FatturaPaTransmission;
    cedente: FatturaPaParty & { regimeFiscale: string };
    cessionario: FatturaPaParty;
    document: {
        contributions?: Array<{tipoCassa: string; aliquota: number; base: number; amount: number; vatRate: number; natura: string | null; withholding: boolean}>;
        withholding?: {type: string | null; causale: string | null; rate: number; amount: number} | null;
        rounding?: number;
        tipoDocumento: TipoDocumento;
        /** Data documento in formato YYYY-MM-DD. */
        data: string;
        numero: string;
        divisa?: string;
        bollo?: FatturaPaBollo | null;
    };
    lines: FatturaPaLine[];
    /** Reconciled persisted total. A disagreement must never produce XML. */
    expectedTotal?: number;
}

const money = (value: number): string => roundInvoiceAmount(value).toFixed(2);
const rate = (value: number): string => (Math.round(value * 100) / 100).toFixed(2);
const qty = (value: number): string => (Math.round(value * 100) / 100).toFixed(2);
const preciseAmount = (value: number): string => {
    const [integer, decimals] = value.toFixed(8).split('.');
    return integer + '.' + decimals.replace(/0+$/, '').padEnd(2, '0');
};
const lineBase = (line: FatturaPaLine): number => line.netAmount ?? roundInvoiceAmount(line.quantity * line.unitPrice);

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

const filled = (value: string | null | undefined): boolean => typeof value === 'string' && value.trim().length > 0;
const isDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);
const isCountry = (value: string | null | undefined): boolean => typeof value === 'string' && /^[A-Z]{2}$/i.test(value.trim());

function anagraficaErrors(party: FatturaPaParty, role: string): string[] {
    const errors: string[] = [];
    const hasDenominazione = filled(party.denominazione);
    const hasNomeCognome = filled(party.nome) && filled(party.cognome);
    if (!hasDenominazione && !hasNomeCognome) {
        errors.push(`${role}: manca la denominazione oppure nome e cognome.`);
    }
    if (hasDenominazione && hasNomeCognome) {
        errors.push(`${role}: indicare la denominazione OPPURE nome e cognome, non entrambi.`);
    }
    return errors;
}

function sedeErrors(party: FatturaPaParty, role: string): string[] {
    const errors: string[] = [];
    if (!filled(party.address)) errors.push(`${role}: manca l'indirizzo (Sede).`);
    if (!filled(party.zip)) errors.push(`${role}: manca il CAP (Sede).`);
    if (!filled(party.city)) errors.push(`${role}: manca il Comune (Sede).`);
    if (!isCountry(party.country)) errors.push(`${role}: manca la Nazione della Sede (codice ISO a 2 lettere).`);
    return errors;
}

/**
 * Validazione strutturale interna dell'input FatturaPA. Ritorna la lista degli errori bloccanti
 * (vuota = struttura minima soddisfatta). NON è la validazione XSD ufficiale.
 */
export function validateFatturaPaInput(input: FatturaPaInput): string[] {
    const errors: string[] = [];
    const t = input.transmission;

    if (!isCountry(t.senderCountry)) errors.push('Trasmissione: IdPaese trasmittente mancante o non valido.');
    if (!filled(t.senderCode)) errors.push('Trasmissione: IdCodice trasmittente mancante.');
    if (!filled(t.progressivo)) errors.push('Trasmissione: progressivo di invio mancante.');
    const codice = (t.codiceDestinatario ?? '').trim();
    if (!/^[A-Z0-9]{7}$/i.test(codice)) {
        errors.push('Trasmissione: CodiceDestinatario deve essere di 7 caratteri (usa 0000000 per B2C).');
    } else if (codice === '0000000' && !filled(t.pecDestinatario) && !filled(input.cessionario.vatNumber)) {
        // Per il B2C ('0000000') la consegna avviene comunque tramite SdI; la PEC è richiesta solo
        // quando si vuole indirizzare la consegna a una PEC in assenza di codice destinatario.
    }

    // Cedente/prestatore.
    if (!filled(input.cedente.vatNumber) && !filled(input.cedente.taxCode)) {
        errors.push('Cedente/prestatore: manca la partita IVA o il codice fiscale.');
    }
    if (filled(input.cedente.vatNumber) && !isCountry(input.cedente.vatCountry)) {
        errors.push('Cedente/prestatore: IdPaese della partita IVA mancante o non valido.');
    }
    if (!filled(input.cedente.regimeFiscale)) errors.push('Cedente/prestatore: RegimeFiscale mancante (RF01-RF19).');
    errors.push(...anagraficaErrors(input.cedente, 'Cedente/prestatore'));
    errors.push(...sedeErrors(input.cedente, 'Cedente/prestatore'));

    // Cessionario/committente.
    if (!filled(input.cessionario.vatNumber) && !filled(input.cessionario.taxCode)) {
        errors.push('Cessionario/committente: manca la partita IVA o il codice fiscale.');
    }
    errors.push(...anagraficaErrors(input.cessionario, 'Cessionario/committente'));
    errors.push(...sedeErrors(input.cessionario, 'Cessionario/committente'));

    // Documento.
    if (!isDate(input.document.data)) errors.push('Documento: la data deve essere nel formato YYYY-MM-DD.');
    if (!filled(input.document.numero)) errors.push('Documento: numero mancante.');
    if (input.document.bollo?.virtuale && !(input.document.bollo.importo > 0)) {
        errors.push('Documento: importo del bollo mancante con bollo virtuale attivo.');
    }

    // Righe.
    if (input.lines.length === 0) errors.push('Il documento non contiene righe (DettaglioLinee).');
    input.lines.forEach((line, index) => {
        const n = index + 1;
        if (!filled(line.description)) errors.push(`Riga ${n}: descrizione mancante.`);
        if (!Number.isFinite(line.quantity) || line.quantity <= 0) errors.push(`Riga ${n}: quantità non valida.`);
        if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0) errors.push(`Riga ${n}: prezzo unitario non valido.`);
        if (!Number.isFinite(line.vatRate) || line.vatRate < 0) errors.push(`Riga ${n}: aliquota IVA non valida.`);
        if (line.vatRate === 0 && !filled(line.natura)) {
            errors.push(`Riga ${n}: con aliquota 0 è obbligatorio il codice Natura (es. N4).`);
        }
        if (line.vatRate > 0 && filled(line.natura)) {
            errors.push(`Riga ${n}: la Natura non va indicata quando l'aliquota è maggiore di zero.`);
        }
        if (line.netAmount != null) {
            const discount = line.discountUnitAmount ?? 0;
            const represented = Number.isFinite(discount)
                ? invoiceAmountInCents(line.quantity * (line.unitPrice - Number(discount.toFixed(8)))) : Number.NaN;
            if (!Number.isFinite(line.netAmount) || line.netAmount < 0 || !Number.isFinite(discount) || discount < 0
                || represented !== invoiceAmountInCents(line.netAmount)) {
                errors.push(`Riga ${n}: sconto e imponibile non riconciliati.`);
            }
        }
    });

    if (input.expectedTotal != null && (!Number.isFinite(input.expectedTotal)
        || invoiceAmountInCents(fatturaPaTotal(input)) !== invoiceAmountInCents(input.expectedTotal))) {
        errors.push('FISCAL_TOTAL_MISMATCH: totale XML diverso dal documento congelato.');
    }

    for (const contribution of input.document.contributions ?? []) {
        if (contribution.tipoCassa !== 'TC22' || contribution.aliquota !== 4 || !Number.isFinite(contribution.base)
            || contribution.base < 0 || !Number.isFinite(contribution.amount) || contribution.amount < 0
            || Math.abs(roundInvoiceAmount(contribution.base * contribution.aliquota / 100) - contribution.amount) > 0.011)
            errors.push('Rivalsa INPS non riconciliata.');
        if (contribution.vatRate === 0 && !filled(contribution.natura)) errors.push('Natura IVA della rivalsa mancante.');
    }
    const withholding = input.document.withholding;
    if (withholding && (!['RT01', 'RT02'].includes(withholding.type ?? '') || withholding.causale !== 'A'
        || !Number.isFinite(withholding.amount) || withholding.amount < 0 || !Number.isFinite(withholding.rate) || withholding.rate <= 0))
        errors.push('Dati ritenuta incompleti.');
    if (!Number.isFinite(input.document.rounding ?? 0) || Math.abs(input.document.rounding ?? 0) > input.lines.length * 0.02)
        errors.push('Arrotondamento fiscale non valido.');
    return errors;
}

interface RiepilogoRow { aliquota: number; natura: string | null; imponibile: number; imposta: number; }

function summarize(lines: FatturaPaLine[], contributions: NonNullable<FatturaPaInput['document']['contributions']> = []): RiepilogoRow[] {
    const groups = new Map<string, RiepilogoRow>();
    for (const line of lines) {
        const imponibile = lineBase(line);
        const natura = line.vatRate === 0 ? (line.natura ?? null) : null;
        const key = `${line.vatRate}|${natura ?? ''}`;
        const current = groups.get(key) ?? { aliquota: line.vatRate, natura, imponibile: 0, imposta: 0 };
        current.imponibile = roundInvoiceAmount(current.imponibile + imponibile);
        groups.set(key, current);
    }
    for (const contribution of contributions) {
        const key = contribution.vatRate + '|' + (contribution.vatRate ? '' : contribution.natura ?? '');
        const row = groups.get(key) ?? {aliquota: contribution.vatRate, natura: contribution.natura, imponibile: 0, imposta: 0};
        row.imponibile = roundInvoiceAmount(row.imponibile + contribution.amount);
        groups.set(key, row);
    }
    for (const row of groups.values()) {
        row.imposta = roundInvoiceAmount((row.aliquota / 100) * row.imponibile);
    }
    return [...groups.values()];
}

/** Totale documento: imponibili + imposte + eventuale bollo riaddebitato. */
export function fatturaPaTotal(input: FatturaPaInput): number {
    const riepilogo = summarize(input.lines, input.document.contributions);
    const base = riepilogo.reduce((sum, row) => sum + row.imponibile + row.imposta, 0);
    const bollo = input.document.bollo?.virtuale && input.document.bollo.chargedToCustomer !== false
        ? input.document.bollo.importo : 0;
    return roundInvoiceAmount(base + bollo + (input.document.rounding ?? 0));
}

function anagraficaXml(party: FatturaPaParty): string {
    if (filled(party.denominazione)) return `<Anagrafica><Denominazione>${escapeXml(party.denominazione!.trim())}</Denominazione></Anagrafica>`;
    return `<Anagrafica><Nome>${escapeXml((party.nome ?? '').trim())}</Nome><Cognome>${escapeXml((party.cognome ?? '').trim())}</Cognome></Anagrafica>`;
}

function sedeXml(party: FatturaPaParty): string {
    const parts = [
        `<Indirizzo>${escapeXml((party.address ?? '').trim())}</Indirizzo>`,
        `<CAP>${escapeXml((party.zip ?? '').trim())}</CAP>`,
        `<Comune>${escapeXml((party.city ?? '').trim())}</Comune>`,
    ];
    if (filled(party.province)) parts.push(`<Provincia>${escapeXml(party.province!.trim().toUpperCase())}</Provincia>`);
    parts.push(`<Nazione>${escapeXml((party.country ?? 'IT').trim().toUpperCase())}</Nazione>`);
    return `<Sede>${parts.join('')}</Sede>`;
}

function idFiscaleIvaXml(country: string | null | undefined, code: string | null | undefined): string {
    return `<IdFiscaleIVA><IdPaese>${escapeXml((country ?? 'IT').trim().toUpperCase())}</IdPaese><IdCodice>${escapeXml((code ?? '').trim())}</IdCodice></IdFiscaleIVA>`;
}

function idTrasmittenteXml(country: string, code: string): string {
    return `<IdTrasmittente><IdPaese>${escapeXml(country.trim().toUpperCase())}</IdPaese><IdCodice>${escapeXml(code.trim())}</IdCodice></IdTrasmittente>`;
}

/**
 * Genera l'XML FatturaPA a partire dall'input. Lancia se la validazione strutturale fallisce,
 * così un chiamante non produce mai un file incompleto per errore.
 */
export function buildFatturaPaXml(input: FatturaPaInput): string {
    const errors = validateFatturaPaInput(input);
    if (errors.length > 0) {
        throw Object.assign(new Error(`FatturaPA non generabile: ${errors.join(' ')}`), { statusCode: 422, validationErrors: errors });
    }

    const t = input.transmission;
    const divisa = input.document.divisa ?? 'EUR';
    const riepilogo = summarize(input.lines, input.document.contributions);
    const totale = fatturaPaTotal(input);

    const cedenteDati = [
        idFiscaleIvaXml(input.cedente.vatCountry, input.cedente.vatNumber),
        filled(input.cedente.taxCode) ? `<CodiceFiscale>${escapeXml(input.cedente.taxCode!.trim())}</CodiceFiscale>` : '',
        anagraficaXml(input.cedente),
        `<RegimeFiscale>${escapeXml(input.cedente.regimeFiscale.trim())}</RegimeFiscale>`,
    ].filter(Boolean).join('');

    const cessionarioDati = [
        filled(input.cessionario.vatNumber) ? idFiscaleIvaXml(input.cessionario.vatCountry, input.cessionario.vatNumber) : '',
        filled(input.cessionario.taxCode) ? `<CodiceFiscale>${escapeXml(input.cessionario.taxCode!.trim())}</CodiceFiscale>` : '',
        anagraficaXml(input.cessionario),
    ].filter(Boolean).join('');

    const dettaglioLinee = input.lines.map((line, index) => {
        const prezzoTotale = lineBase(line);
        const naturaXml = line.vatRate === 0 && filled(line.natura) ? `<Natura>${escapeXml(line.natura!.trim().toUpperCase())}</Natura>` : '';
        return `<DettaglioLinee><NumeroLinea>${index + 1}</NumeroLinea>`
            + `<Descrizione>${escapeXml(line.description.trim())}</Descrizione>`
            + `<Quantita>${qty(line.quantity)}</Quantita>`
            + `<PrezzoUnitario>${preciseAmount(line.unitPrice)}</PrezzoUnitario>`
            + (line.discountUnitAmount ? `<ScontoMaggiorazione><Tipo>SC</Tipo><Importo>${preciseAmount(line.discountUnitAmount)}</Importo></ScontoMaggiorazione>` : '')
            + `<PrezzoTotale>${money(prezzoTotale)}</PrezzoTotale>`
            + `<AliquotaIVA>${rate(line.vatRate)}</AliquotaIVA>`
            + (line.withholding ? '<Ritenuta>SI</Ritenuta>' : '')
            + naturaXml
            + `</DettaglioLinee>`;
    }).join('');

    const datiRiepilogo = riepilogo.map(row => {
        const naturaXml = row.natura ? `<Natura>${escapeXml(row.natura)}</Natura>` : '';
        return `<DatiRiepilogo><AliquotaIVA>${rate(row.aliquota)}</AliquotaIVA>`
            + naturaXml
            + `<ImponibileImporto>${money(row.imponibile)}</ImponibileImporto>`
            + `<Imposta>${money(row.imposta)}</Imposta>`
            + `</DatiRiepilogo>`;
    }).join('');

    const bolloXml = input.document.bollo?.virtuale
        ? `<DatiBollo><BolloVirtuale>SI</BolloVirtuale><ImportoBollo>${money(input.document.bollo.importo)}</ImportoBollo></DatiBollo>`
        : '';

    const withholding = input.document.withholding;
    const withholdingXml = withholding ? '<DatiRitenuta><TipoRitenuta>' + withholding.type + '</TipoRitenuta><ImportoRitenuta>' + money(withholding.amount)
        + '</ImportoRitenuta><AliquotaRitenuta>' + rate(withholding.rate) + '</AliquotaRitenuta><CausalePagamento>' + withholding.causale + '</CausalePagamento></DatiRitenuta>' : '';
    const contributionXml = (input.document.contributions ?? []).map(value => '<DatiCassaPrevidenziale><TipoCassa>' + value.tipoCassa
        + '</TipoCassa><AlCassa>' + rate(value.aliquota) + '</AlCassa><ImportoContributoCassa>' + money(value.amount)
        + '</ImportoContributoCassa><ImponibileCassa>' + money(value.base) + '</ImponibileCassa><AliquotaIVA>' + rate(value.vatRate)
        + '</AliquotaIVA>' + (value.withholding ? '<Ritenuta>SI</Ritenuta>' : '')
        + (value.vatRate === 0 ? '<Natura>' + escapeXml(value.natura!) + '</Natura>' : '') + '</DatiCassaPrevidenziale>').join('');
    const pecXml = filled(t.pecDestinatario) ? `<PECDestinatario>${escapeXml(t.pecDestinatario!.trim())}</PECDestinatario>` : '';

    return `<?xml version="1.0" encoding="UTF-8"?>`
        + `<p:FatturaElettronica versione="FPR12" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2">`
        + `<FatturaElettronicaHeader>`
        + `<DatiTrasmissione>`
        + idTrasmittenteXml(t.senderCountry, t.senderCode)
        + `<ProgressivoInvio>${escapeXml(t.progressivo.trim())}</ProgressivoInvio>`
        + `<FormatoTrasmissione>FPR12</FormatoTrasmissione>`
        + `<CodiceDestinatario>${escapeXml(t.codiceDestinatario.trim().toUpperCase())}</CodiceDestinatario>`
        + pecXml
        + `</DatiTrasmissione>`
        + `<CedentePrestatore><DatiAnagrafici>${cedenteDati}</DatiAnagrafici>${sedeXml(input.cedente)}</CedentePrestatore>`
        + `<CessionarioCommittente><DatiAnagrafici>${cessionarioDati}</DatiAnagrafici>${sedeXml(input.cessionario)}</CessionarioCommittente>`
        + `</FatturaElettronicaHeader>`
        + `<FatturaElettronicaBody>`
        + `<DatiGenerali><DatiGeneraliDocumento>`
        + `<TipoDocumento>${escapeXml(input.document.tipoDocumento)}</TipoDocumento>`
        + `<Divisa>${escapeXml(divisa)}</Divisa>`
        + `<Data>${escapeXml(input.document.data)}</Data>`
        + `<Numero>${escapeXml(input.document.numero.trim())}</Numero>`
        + withholdingXml + bolloXml + contributionXml
        + `<ImportoTotaleDocumento>${money(totale)}</ImportoTotaleDocumento>`
        + (input.document.rounding ? `<Arrotondamento>${money(input.document.rounding)}</Arrotondamento>` : '')
        + `</DatiGeneraliDocumento></DatiGenerali>`
        + `<DatiBeniServizi>${dettaglioLinee}${datiRiepilogo}</DatiBeniServizi>`
        + `</FatturaElettronicaBody>`
        + `</p:FatturaElettronica>`;
}
