# Compliance backend Rehablo - stato e roadmap

Ultimo aggiornamento: 2026-08-24

Documento operativo per portare il backend `rehablo-api` a una copertura production-ready sugli
adempimenti italiani rilevanti per fisioterapia: Sistema Tessera Sanitaria, fatturazione sanitaria
ed elettronica, Fascicolo Sanitario Elettronico, GDPR e dati sanitari.

Questo documento integra `COMPLIANCE.md`: non sostituisce il parere di commercialista,
consulente privacy o referente regionale FSE, ma traduce i requisiti in lavoro tecnico verificabile
sul backend.

## Stato sintetico

| Area | Copertura BE stimata | Stato |
|---|---:|---|
| Fatturazione sanitaria base | 75-80% | Ciclo documento ora solido; mancano PDF, serie, test automatici |
| Sistema Tessera Sanitaria | 35-40% | Export bozza con audit; manca validazione/invio/ricevute |
| Fatturazione elettronica / SDI | 20-25% | Solo dati predisposti; niente FatturaPA/SDI/provider |
| Fascicolo Sanitario Elettronico | 10-15% | Solo scaffolding tecnico; nessun invio reale |
| GDPR e dati sanitari | 50-55% | Audit/consensi/write-scope avviati; manca retention completa |
| Sicurezza/RBAC backend | 70% | Rotte protette e write-scope misure; restano logging/rate-limit/storage |

Copertura complessiva stimata backend: circa 50%.

## Gia' implementato nel backend

### Fatturazione sanitaria

- Modello `Tenant` con dati fiscali principali: ragione sociale, P.IVA, CF, PEC, codice SDI,
  indirizzo, regime fiscale, bollo, ritenuta e contatore numerazione.
- Modello `Invoice` con `documentNumber`, `documentYear`, `documentType`, `vatNature`,
  `stsExpenseTypeCode`, `stsExcluded`, `stsSent`, `stsSentAt`, `issuer`, `fiscalNotes`.
- Stato documentale/pagamento su `Invoice.status`: `draft`, `issued`, `paid`, `void`, `credited`.
- Campi lifecycle: `issuedAt`, `sourceInvoiceId`, `voidedAt`, `voidedBy`, `voidReason`,
  `creditedAt`, `creditedBy`.
- Snapshot `Invoice.issuer` congelato all'emissione.
- Snapshot `Invoice.recipient` congelato sul documento fiscale.
- `POST /invoice` crea una bozza se `status=draft`; altrimenti emette e numera in transazione.
- `POST /invoice/:invoiceId/issue` emette una bozza e assegna il progressivo.
- `POST /invoice/:invoiceId/void` storna senza cancellare fisicamente.
- `POST /invoice/:invoiceId/credit` crea una nota di credito numerata e collegata alla fattura
  sorgente.
- `PUT /invoice/:invoiceId` blocca modifiche distruttive sulle fatture emesse; ammette solo
  aggiornamenti limitati a stato pagamento e dati pagamento.
- `DELETE /invoice/:invoiceId` cancella fisicamente solo bozze non numerate.
- Numerazione progressiva per anno con transazione e lock sul tenant.
- Calcolo lato server di IVA/natura, ritenuta, bollo e totali.
- `GET /reports/issuer-status` espone readiness dati emittente e profilo fiscale.

### Sistema Tessera Sanitaria

- Campo paziente `stsOppositionToDataSending`.
- Emissione fattura imposta `stsExcluded` se il paziente si e' opposto.
- `GET /invoice/export/sistema-ts?year=YYYY&markAsSent=true` produce XML, esclude bozze/storni
  e marca i documenti inclusi come inviati.
- `buildSistemaTSRecord()` usa lo snapshot emittente quando disponibile.
- Audit evento `sts.export.marked_sent`.

### FSE

- Modulo `modules/compliance/fse/` con `FseAdapter`, `NullFseAdapter`, registry adapter regionale,
  `resolveRegionForEvaluation()` e skeleton CDA2 livello iniziale.
- `Patient.structureId` ed `Evaluation.structureId` consentono di risalire alla Regione della
  struttura.

### GDPR, audit e dati sanitari

- Campi paziente per consenso privacy, versione informativa, consensi FSE e opposizione STS.
- Modello tenant-scoped `AuditLog` e helper `recordAuditEvent()`.
- Audit su eventi principali fattura, export STS, lettura paziente, modifica paziente e storico
  consensi.
- Modello tenant-scoped `ConsentEvent`.
- `GET /patient/:patientId/consents` espone lo storico consensi.
- `DELETE /patient/:patientId` non esegue hard delete se esistono fatture, valutazioni o misure:
  marca `deactivatedAt` per retention.
- Isolamento multi-tenant tramite schema Postgres per tenant.
- RBAC con `requirePermission`, `scopeWhere` e `patientScopeWhere`.
- Audit statico RBAC presente: `npm run audit:rbac`.
- Scrittura misurazioni manuali/API/import CSV vincolata allo scope paziente dell'utente.
- Refresh token opachi, hashati, ruotati, con reuse detection.
- Password hashate con bcrypt.
- Credenziali dispositivi cifrate AES-256-GCM.
- `helmet` e CORS configurato.

## Gap da chiudere

### Sistema Tessera Sanitaria

Obiettivo: passare da export interno "best effort" a gestione STS production-ready.

Manca:

- Tracciato ufficiale STS aggiornato e versionato per anno fiscale.
- Validazione XSD/record prima dell'export.
- Codici tipologia spesa ufficiali, non stringhe interne.
- Dettaglio per singole righe di spesa quando necessario.
- Modalita' pagamento tracciato/non tracciato.
- Rimborsi, rettifiche, annullamenti e reinvii.
- Modelli `StsSubmission` e `StsSubmissionItem`.
- Ricevute/esiti di trasmissione.
- Credenziali per soggetto inviante/intermediario.
- Invio web service o integrazione upload controllata.

### Fatturazione sanitaria/elettronica

Manca:

- Template PDF/HTML con diciture fiscali obbligatorie.
- Numerazione separata se servono serie diverse.
- Test automatici su concorrenza numerazione, blocco delete/update e nota di credito.
- FatturaPA XML per B2B/PA/non sanitario.
- Gestione SDI: invio, ricevute, scarti, conservazione e retry.
- Conservazione sostitutiva a norma o integrazione con provider.

### FSE

Obiettivo: da scaffolding a flusso effettivo per documenti clinici.

Manca:

- Modello `ClinicalDocument`.
- Modello `FseSubmission`.
- Flusso backend che, alla chiusura di una valutazione, genera documento clinico candidato.
- Validazione consenso consultazione/oscuramento secondo regole FSE.
- Document model per tracciare invii FSE: stato, regione, adapter, payload hash, esito, errori,
  repository id.
- CDA2 reale validato, non solo skeleton.
- Metadati IHE XDS completi.
- Firma digitale/CAdES/XAdES.
- Adapter regionale concreto o provider/intermediario.
- Retry e gestione ricevute.
- Audit degli accessi e delle operazioni FSE.

### GDPR e dati sanitari

Manca:

- Audit log sistematico su tutte le consultazioni cliniche: valutazioni, fatture sanitarie,
  documenti, raw file e misure.
- Retention policy configurabile e job di anonimizzazione/pseudonimizzazione.
- Snapshot paziente sui documenti clinici, prerequisito per anonimizzare anagrafiche senza
  perdere obblighi sanitari.
- Export dati paziente.
- Workflow cancellazione/anonymization completo e revisionabile.
- Cifratura applicativa o storage sicuro per file grezzi sanitari.
- Eliminazione log debug contenenti payload utente/tenant.
- Rate limit su auth e ingestion.

## Blocchi non completabili solo a codice

Questi punti richiedono input esterni prima dell'implementazione production-ready:

- Credenziali STS del soggetto inviante o intermediario.
- Ultimo tracciato/XSD STS e tabelle tipologia spesa per l'anno fiscale di invio.
- Scelta canale STS: web service diretto, intermediario o upload controllato.
- Regione FSE di ciascuna struttura, accreditamento, endpoint, certificati, ambiente di test e
  manuale di interoperabilita' regionale.
- Provider SDI/conservazione o canale accreditato.
- Policy legale/privacy approvata: tempi retention, base giuridica, informative e DPO se dovuto.

## Roadmap consigliata

### Fase 1 - Chiudere fattura e STS interno

Priorita': alta.

- Aggiungere test automatici su numerazione concorrente, delete/update emesse, issue draft,
  void e credit note.
- Introdurre `StsSubmission`/`StsSubmissionItem`.
- Rendere l'export STS riproducibile: simulazione, generazione, conferma invio, ricevuta.
- Aggiungere pagamento tracciato/non tracciato.

### Fase 2 - GDPR audit e retention completa

Priorita': alta, trasversale.

- Audit su consultazione valutazione, fattura, raw file e misure.
- Export dati paziente.
- Retention policy configurabile.
- Job di anonimizzazione compatibile con snapshot fiscali/clinici.
- Rimuovere log debug sensibili.
- Rate limit su auth e ingestion.

### Fase 3 - Sistema TS production-ready

Priorita': alta, ma dipende da credenziali/spec ufficiali.

- Tabelle/costanti versionate per codici STS.
- Validazione XSD.
- Gestione esiti/ricevute.
- Rettifica/annullamento/reinvio.
- Integrazione web service o provider.

### Fase 4 - FSE operativo

Priorita': media-alta, dipende da Regione/provider.

- `ClinicalDocument` e `FseSubmission`.
- Generazione documento da valutazione completata.
- Validazione CDA2 e metadati XDS.
- Adapter regionale o integrazione intermediario.
- Firma digitale.
- Stato invio, ricevute, retry, audit.

### Fase 5 - FatturaPA/SDI e conservazione

Priorita': media, necessaria per casi non sanitari/B2B/PA e conservazione.

- Generatore FatturaPA XML.
- Provider SDI o integrazione canale.
- Conservazione sostitutiva provider.
- Gestione ricevute SDI e scarti.

## Fonti normative operative

- Agenzia Entrate, scadenza trasmissione spese sanitarie 2025 al Sistema TS: https://www1.agenziaentrate.gov.it/servizi/scadenzario/main.php?chi=3809&come=439&cosa=11472&entroil=02-02-2026&op=4&vista=0
- Agenzia Entrate, spese sanitarie in precompilata incluse prestazioni di fisioterapia: https://infoprecompilata.agenziaentrate.gov.it/portale/w/faq-quali-altre-spese-sanitarie-non-trovo-nella-dichiarazione-precompilata-
- Agenzia Entrate, tracciabilita' pagamenti spese sanitarie: https://infoprecompilata.agenziaentrate.gov.it/portale/web/guest/oneri-e-spese1
- MEF/DEF, fisioterapisti e trasmissione Sistema TS: https://def.finanze.it/DocTribFrontend/getAttoNormativoDetail.do?ACTION=getArticolo&articolo=Articolo+2&codiceOrdinamento=200000200000000&id=%7B15D90384-481C-4EA8-8013-ED6048144280%7D
- MEF/DEF, modalita' tecniche e credenziali Sistema TS: https://def.finanze.it/DocTribFrontend/getAttoNormativoDetail.do?ACTION=getArticolo&codiceOrdinamento=600000000000000&id=%7B477D415F-CD4A-4192-B6BB-657156A6BCC7%7D
- Garante Privacy, FAQ fatturazione elettronica e dati sanitari: https://www.garanteprivacy.it/temi/fisco/faq-fatturazione-elettronica
- Garante Privacy, FSE e consenso consultazione/alimentazione automatica: https://www.garanteprivacy.it/temi/fse
- Garante Privacy, fasi attuazione FSE 2.0: https://www.garanteprivacy.it/web/guest/home/docweb/-/docweb-display/docweb/10061545
- Ministero Salute, repository supporto integrazione FSE 2.0: https://github.com/ministero-salute/it-fse-support
- Ministero Salute, documentazione gateway FSE: https://github.com/ministero-salute/it-fse-support/blob/main/doc/integrazione-gateway/README.md
- AgID, conservazione dei documenti informatici: https://www.agid.gov.it/index.php/it/piattaforme/conservazione
