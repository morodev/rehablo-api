/**
 * Costruttore del documento clinico in formato CDA2 (HL7 Clinical Document Architecture, Release 2).
 *
 * Il FSE non accetta "campi liberi": ogni documento clinico deve essere incapsulato in un XML
 * CDA2 con una struttura Header + Body standardizzata, poi FIRMATO DIGITALMENTE (CAdES/XAdES) e
 * pubblicato nel Registry/Repository regionale insieme ai metadati IHE XDS (`IheXdsMetadata`).
 *
 * Questo builder genera uno scheletro CDA2 "Livello 1" (corpo non strutturato, solo testo/HTML
 * nella sezione narrativa) valido come punto di partenza. Le Linee Guida Nazionali FSE prevedono
 * anche un "Livello 2/3" con sezioni codificate (es. con codici LOINC/SNOMED) per una vera
 * interoperabilità semantica: per un referto fisioterapico strutturato (obiettivi, scale di
 * valutazione, articolarità...) andrebbe arricchito con le sezioni codificate previste dalla
 * Guida di Implementazione Nazionale HL7-CDA2, che è la fonte da consultare per i dettagli
 * (root/OID, vocabolari, template id) prima di andare in produzione.
 *
 * OID indicati sotto (es. per il Codice Fiscale) sono quelli comunemente adottati nelle
 * implementazioni CDA2 italiane: vanno comunque riconfermati con la Regione/AgID.
 */

import { FseClinicalDocument } from './fseAdapter.interface.js';

/** OID nazionale usato in ambito HL7-IT per identificare il Codice Fiscale come "root" dell'id. */
const OID_CODICE_FISCALE = '2.16.840.1.113883.2.9.4.3.2';

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function toHl7Timestamp(date: Date): string {
    // Formato HL7 richiesto: YYYYMMDDHHmmss+ZZzz
    return date
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, '+0000');
}

/**
 * Genera lo scheletro XML CDA2 (Livello 1) per un documento clinico prodotto da Rehablo
 * (es. referto di valutazione fisioterapica, piano di trattamento, relazione di fine terapia).
 *
 * NOTA: questo è un TEMPLATE DIDATTICO/DI PARTENZA, non un generatore certificato. Prima
 * dell'uso reale va validato con l'XSD ufficiale CDA2 e con i vincoli della Guida di
 * Implementazione Nazionale/regionale (template id specifici, vocabolari controllati, ecc.).
 */
export function buildCda2Skeleton(document: FseClinicalDocument): string {
    const { metadata } = document;

    return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <!-- Identificativo univoco del documento: deve coincidere con metadata.documentUniqueId
       usato anche nei metadati IHE XDS inviati al Registry regionale. -->
  <id root="${OID_CODICE_FISCALE}" extension="${escapeXml(metadata.documentUniqueId)}" />

  <!-- Tipo/classe del documento: da tabella nazionale "Tipologia Documento FSE" + LOINC. -->
  <code code="${escapeXml(metadata.typeCode)}" codeSystem="2.16.840.1.113883.6.1" displayName="${escapeXml(document.documentType)}" />

  <title>${escapeXml(document.title)}</title>
  <effectiveTime value="${toHl7Timestamp(document.createdAt)}" />
  <confidentialityCode code="${metadata.confidentialityCode}" codeSystem="2.16.840.1.113883.5.25" />
  <languageCode code="${escapeXml(metadata.languageCode)}" />

  <!-- Paziente: identificato tramite Codice Fiscale (OID nazionale). -->
  <recordTarget>
    <patientRole>
      <id root="${OID_CODICE_FISCALE}" extension="${escapeXml(document.patientFiscalCode.toUpperCase())}" />
    </patientRole>
  </recordTarget>

  <!-- Autore del documento: il fisioterapista/struttura, identificato tramite CF/P.IVA. -->
  <author>
    <time value="${toHl7Timestamp(document.createdAt)}" />
    <assignedAuthor>
      <id root="${OID_CODICE_FISCALE}" extension="${escapeXml(document.authorTaxCode.toUpperCase())}" />
    </assignedAuthor>
  </author>

  <!-- Corpo del documento: Livello 1 (testo narrativo). Per un vero referto strutturato
       (LOINC/SNOMED, scale di valutazione, articolarità...) va sostituito con <structuredBody>
       e sezioni codificate secondo la Guida di Implementazione Nazionale HL7-CDA2. -->
  <component>
    <structuredBody>
      <component>
        <section>
          <title>${escapeXml(document.title)}</title>
          <text>${escapeXml(document.content)}</text>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>
`;
}

