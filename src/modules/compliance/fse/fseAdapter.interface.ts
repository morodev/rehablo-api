/**
 * Fascicolo Sanitario Elettronico (FSE) - interfaccia di integrazione.
 *
 * Riferimenti normativi principali:
 * - D.L. 179/2012, art. 12 (istituzione del FSE).
 * - DPCM 178/2015 (regolamento in materia di FSE).
 * - D.L. 34/2020, art. 11 e D.M. attuativi 2022 ("FSE 2.0"): estende l'obbligo di alimentazione
 *   a tutte le strutture sanitarie pubbliche e private, con infrastruttura di interoperabilità
 *   nazionale (INI) gestita da AgID/Ministero Salute sopra le infrastrutture regionali.
 * - PNRR Missione 6 Componente 2: finanziamenti e scadenze per l'estensione dell'alimentazione
 *   del FSE anche ai professionisti sanitari privati (fisioterapisti inclusi).
 *
 * PERCHÉ UN'INTERFACCIA E NON UN'IMPLEMENTAZIONE DIRETTA:
 * A differenza del Sistema Tessera Sanitaria (un unico endpoint nazionale), il FSE è alimentato
 * tramite l'infrastruttura di interoperabilità della REGIONE in cui opera lo studio (ogni Regione
 * ha un proprio gateway: es. Lombardia, Emilia-Romagna, Lazio, ecc., spesso tramite un
 * "intermediario" tecnologico accreditato). Collegarsi realmente richiede:
 *   1) Accreditamento formale del titolare (P.IVA) presso la Regione/ASL competente.
 *   2) Un certificato di firma digitale (spesso CNS/firma remota) per firmare i documenti CDA2.
 *   3) Generazione dei documenti clinici in formato CDA2 (HL7 Clinical Document Architecture)
 *      con metadati IHE XDS (repositoryUniqueId, documentUniqueId, ecc.).
 *   4) Trasmissione al gateway regionale via web service (SOAP/REST a seconda della Regione).
 *
 * Questa interfaccia astrae questi passaggi in modo che, una volta ottenuto l'accreditamento
 * regionale, sia sufficiente implementare un adapter concreto (es. `LombardiaFseAdapter`)
 * senza toccare il resto dell'applicazione (evaluations, invoice, patients).
 */

export interface FseClinicalDocument {
    /** Codice fiscale del paziente (obbligatorio, identificativo del fascicolo). */
    patientFiscalCode: string;
    /** Codice fiscale/P.IVA dell'autore del documento (il fisioterapista/struttura). */
    authorTaxCode: string;
    /** Tipologia del documento clinico (es. "referto fisioterapico", "verbale di valutazione"). */
    documentType: string;
    title: string;
    /** Contenuto del documento clinico. In produzione va incapsulato in CDA2 (HL7) prima dell'invio. */
    content: string;
    createdAt: Date;
    /** Metadati IHE XDS obbligatori per la pubblicazione nel registry regionale (vedi metadata.ts). */
    metadata: IheXdsMetadata;
}

/**
 * Metadati "XDSDocumentEntry" richiesti dal profilo IHE XDS.b su cui si basa l'infrastruttura
 * FSE regionale, per poter classificare/indicizzare il documento nel Registry e renderlo
 * reperibile in consultazione. Sono la parte "a corredo" del documento clinico vero e proprio:
 * senza metadati corretti il documento viene scartato dal Registry regionale anche se il
 * contenuto CDA2 è formalmente valido.
 *
 * I codici (OID, classCode, typeCode, formatCode) indicati come default sono quelli comunemente
 * usati nelle Linee Guida Nazionali HL7-CDA2/FSE pubblicate da AgID/Ministero della Salute, ma
 * VANNO VERIFICATI con la Regione di competenza (ogni Regione può richiedere vocabolari/OID
 * leggermente diversi nel proprio Manuale di Interoperabilità).
 */
export interface IheXdsMetadata {
    /** Identificativo univoco del documento, generato dal sistema alimentante (es. UUID). */
    documentUniqueId: string;
    /** Classe del documento secondo la tabella nazionale "Tipologia Documento FSE" (es. "Referto"). */
    classCode: string;
    /** Codice più specifico del tipo di documento (idealmente LOINC, es. referto di fisioterapia). */
    typeCode: string;
    /** Formato del contenuto: per CDA2 strutturato è tipicamente "urn:ihe:pcc:xphr:2007" o simile;
     *  per un PDF firmato è "urn:ihe:iti:xds-sd:pdf:2008". Da confermare con la Regione. */
    formatCode: string;
    /** Tipologia della struttura erogante (es. "Ambulatorio", "Studio professionale privato"). */
    healthcareFacilityTypeCode: string;
    /** Ambito clinico/disciplina (es. "Medicina fisica e riabilitazione"). */
    practiceSettingCode: string;
    /** "N" (normal) oppure "R" (restricted, se il paziente ha richiesto l'oscuramento). */
    confidentialityCode: 'N' | 'R';
    languageCode: string; // es. "it-IT"
}

export type FseConsentStatus = 'CONSENSO_PRESTATO' | 'CONSENSO_NEGATO' | 'NON_RICHIESTO';

export interface FseFeedResult {
    success: boolean;
    /** documentUniqueId assegnato dal repository regionale IHE XDS, se l'invio ha successo. */
    repositoryDocumentId?: string;
    message: string;
}

export interface FseAdapter {
    /** Alimenta il FSE regionale con un nuovo documento clinico. */
    feedDocument(document: FseClinicalDocument): Promise<FseFeedResult>;
    /** Verifica lo stato del consenso alla consultazione del FSE per un paziente. */
    getConsentStatus(patientFiscalCode: string): Promise<FseConsentStatus>;
}

