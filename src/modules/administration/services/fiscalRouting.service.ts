/**
 * Motore di instradamento fiscale (provider-neutral).
 *
 * Decide, per un documento, su quale canale telematico vanno trasmessi i dati:
 *   - SDI  (FatturaPA)  → fatture elettroniche B2B e B2C di sole voci NON sanitarie;
 *   - STS  (Sistema TS) → dati di spesa sanitaria di persone fisiche.
 *
 * Regole di riferimento (da riverificare sul tracciato/normativa vigente prima di ogni
 * rilascio fiscale, cfr. docs/analisi-piano-gestione-amministrativa-fiscale.md §5):
 *
 *   - D.Lgs. 12/06/2025 n. 81: stabilizzazione del divieto di fatturazione elettronica via
 *     SDI per le prestazioni SANITARIE verso persone fisiche; i dati vanno al Sistema TS.
 *   - FAQ Garante privacy: esclusione dallo SDI dei documenti sanitari B2C anche in caso di
 *     opposizione; per i documenti MISTI l'intero documento resta fuori SDI.
 *   - D.Lgs. 175/2014 art. 3: obbligo di trasmissione al Sistema TS dei dati di spesa
 *     sanitaria; il paziente può opporsi (in tal caso il record NON viene trasmesso).
 *
 * Il motore è una funzione PURA: riceve un input già normalizzato (nessun accesso al DB) e
 * restituisce una decisione motivata e versionata, che il chiamante congela sul documento.
 * La classificazione "sanitaria/non sanitaria" delle righe appartiene al catalogo e viene
 * passata qui: righe non classificate producono `needsHealthcareClassification` invece di
 * essere indovinate, coerentemente col principio "dichiara l'ignoto, non inventarlo".
 */

export const FISCAL_ROUTING_RULE_VERSION = '2025-06-IT';

export type FiscalChannel = 'SDI' | 'STS';
export type RecipientKind = 'PERSON' | 'BUSINESS';
export type DocumentType = 'fattura' | 'ricevuta_fiscale' | 'nota_di_credito';

export interface FiscalRoutingLine {
    kind: 'SERVICE' | 'PRODUCT';
    /** true = prestazione/bene sanitario; false = non sanitario; null = non classificato. */
    isHealthcare: boolean | null;
}

export interface FiscalRoutingRecipient {
    kind: RecipientKind;
    /** Il committente possiede una partita IVA (soggetto B2B). */
    hasVatNumber: boolean;
    taxCode: string | null;
    /** Codice destinatario SDI (7 caratteri) del committente, se presente. */
    sdiCode: string | null;
    pec: string | null;
}

export interface FiscalRoutingInput {
    documentType: DocumentType;
    recipient: FiscalRoutingRecipient;
    lines: FiscalRoutingLine[];
    /** Il paziente si è opposto alla trasmissione al Sistema TS. */
    patientOpposesTs: boolean;
    /** Il profilo emittente Sistema TS è configurato (Impostazioni → Collegamenti fiscali). */
    stsIssuerConfigured: boolean;
    /** true se, per le righe sanitarie, il tipo di spesa TS è risolvibile senza errori. */
    stsExpenseTypeResolved: boolean;
}

export interface FiscalRoutingDecision {
    ruleVersion: string;
    /** Canali su cui il documento deve essere effettivamente trasmesso. */
    channels: FiscalChannel[];
    sdi: { required: boolean; reason: string };
    sts: {
        /** Il documento genera un record di spesa sanitaria da trasmettere. */
        eligible: boolean;
        reason: string;
        /** Numero di righe sanitarie che confluiscono nel record TS. */
        healthcareLineCount: number;
    };
    /** Dati mancanti che impediscono la trasmissione su un canale altrimenti dovuto. */
    blocks: string[];
    /** Segnalazioni non bloccanti (documento misto, opposizione, ecc.). */
    warnings: string[];
    /** Almeno una riga è priva di classificazione sanitaria: la decisione non è affidabile. */
    needsHealthcareClassification: boolean;
}

const validSdiCode = (code: string | null): boolean => typeof code === 'string' && /^[A-Z0-9]{7}$/i.test(code.trim());
const filled = (value: string | null): boolean => typeof value === 'string' && value.trim().length > 0;

/**
 * Calcola l'instradamento fiscale di un documento a partire da un input normalizzato.
 * Non effettua accessi al database: il chiamante fornisce righe, destinatario e stato TS.
 */
export function resolveFiscalRouting(input: FiscalRoutingInput): FiscalRoutingDecision {
    const blocks: string[] = [];
    const warnings: string[] = [];

    const healthcareLines = input.lines.filter(line => line.isHealthcare === true);
    const nonHealthcareLines = input.lines.filter(line => line.isHealthcare === false);
    const unclassifiedLines = input.lines.filter(line => line.isHealthcare === null);
    const needsHealthcareClassification = unclassifiedLines.length > 0;

    const hasHealthcare = healthcareLines.length > 0;
    const hasNonHealthcare = nonHealthcareLines.length > 0;
    const isBusiness = input.recipient.kind === 'BUSINESS' || input.recipient.hasVatNumber;

    const decision: FiscalRoutingDecision = {
        ruleVersion: FISCAL_ROUTING_RULE_VERSION,
        channels: [],
        sdi: { required: false, reason: '' },
        sts: { eligible: false, reason: '', healthcareLineCount: healthcareLines.length },
        blocks,
        warnings,
        needsHealthcareClassification,
    };

    if (input.lines.length === 0) {
        blocks.push('Il documento non contiene righe: impossibile determinare il canale fiscale.');
        decision.sdi.reason = 'Nessuna riga da instradare.';
        decision.sts.reason = 'Nessuna riga da instradare.';
        return decision;
    }

    if (needsHealthcareClassification) {
        warnings.push('Alcune voci non hanno una classificazione sanitaria: completala nel catalogo per un instradamento affidabile.');
    }

    // --- B2B: sempre SDI (FatturaPA), mai Sistema TS. ---
    if (isBusiness) {
        decision.sdi.required = true;
        decision.sdi.reason = 'Committente titolare di partita IVA: fattura elettronica B2B tramite SDI.';
        decision.sts.reason = 'Il Sistema TS riguarda le spese sanitarie delle persone fisiche, non i soggetti B2B.';
        if (!validSdiCode(input.recipient.sdiCode) && !filled(input.recipient.pec)) {
            blocks.push('Manca il codice destinatario SDI o la PEC del committente B2B.');
        }
        if (!filled(input.recipient.taxCode) && !input.recipient.hasVatNumber) {
            blocks.push('Manca la partita IVA o il codice fiscale del committente.');
        }
        if (decision.sdi.required && blocks.length === 0) decision.channels.push('SDI');
        return decision;
    }

    // --- B2C: persona fisica. ---
    if (hasHealthcare) {
        // Almeno una prestazione sanitaria → l'INTERO documento è fuori SDI (anche se misto).
        decision.sdi.required = false;
        decision.sdi.reason = hasNonHealthcare
            ? 'Documento misto con almeno una prestazione sanitaria verso persona fisica: escluso dallo SDI.'
            : 'Prestazioni sanitarie verso persona fisica: escluse dallo SDI.';
        if (hasNonHealthcare) {
            warnings.push('Documento misto: solo le righe sanitarie confluiscono nel Sistema TS; le altre restano fuori sia da SDI sia da TS.');
        }

        if (input.patientOpposesTs) {
            decision.sts.eligible = false;
            decision.sts.reason = 'Il paziente si è opposto alla trasmissione: nessun invio al Sistema TS.';
            warnings.push('Opposizione TS attiva: consegna il documento al paziente senza trasmetterlo.');
            return decision;
        }
        if (!input.stsIssuerConfigured) {
            decision.sts.eligible = false;
            decision.sts.reason = 'Profilo emittente Sistema TS non configurato.';
            blocks.push('Configura il profilo dell’emittente in Impostazioni → Amministrazione → Collegamenti fiscali.');
            return decision;
        }
        if (!input.stsExpenseTypeResolved) {
            decision.sts.eligible = false;
            decision.sts.reason = 'Tipo di spesa sanitaria non determinato per le righe sanitarie.';
            blocks.push('Seleziona il tipo di spesa nei dati Sistema Tessera Sanitaria del documento.');
            return decision;
        }
        decision.sts.eligible = true;
        decision.sts.reason = 'Spesa sanitaria di persona fisica: trasmissione al Sistema TS.';
        decision.channels.push('STS');
        return decision;
    }

    // Persona fisica, sole voci NON sanitarie → fattura elettronica B2C via SDI.
    decision.sdi.required = true;
    decision.sdi.reason = 'Voci non sanitarie verso persona fisica: fattura elettronica B2C tramite SDI.';
    decision.sts.reason = 'Nessuna prestazione sanitaria: nessun dato per il Sistema TS.';
    if (!filled(input.recipient.taxCode)) {
        blocks.push('Manca il codice fiscale del destinatario per la fattura elettronica.');
    }
    if (blocks.length === 0) decision.channels.push('SDI');
    return decision;
}
