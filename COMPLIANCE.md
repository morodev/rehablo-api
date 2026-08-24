# Adempimenti legali/normativi per software di fisioterapia in Italia

> Documento di riferimento interno su Sistema Tessera Sanitaria (STS), Fascicolo Sanitario
> Elettronico (FSE), GDPR/privacy dati sanitari e fatturazione sanitaria, con lo stato di
> adeguamento di Rehablo e la roadmap di implementazione.

## 1. Quadro normativo

### 1.1 Sistema Tessera Sanitaria (STS)
- **Base legale**: D.Lgs. 21/11/2014 n. 175, art. 3 (istituito per la dichiarazione dei redditi
  precompilata 730/Redditi PF); tracciati tecnici e tabelle pubblicati e aggiornati su
  https://sistemats1.sanita.finanze.it.
- **Chi è obbligato**: tutti gli esercenti "professioni sanitarie" per prestazioni rese a persone
  fisiche in libera professione. Il **fisioterapista**, professione sanitaria riabilitativa
  riconosciuta (L. 3/2018 art. 1 c. 313 e succ.) iscritta all'Albo unico **TSRM-PSTRP**, rientra
  tra i soggetti tenuti alla trasmissione.
- **Cosa va trasmesso**: codice fiscale paziente, importo, data e numero documento, tipologia di
  spesa (da tabella ministeriale, soggetta ad aggiornamento periodico), P.IVA/CF dell'erogatore.
- **Diritto di opposizione**: il paziente può opporsi all'invio dei propri dati al Sistema TS.
  Se esercitato, il professionista NON deve trasmettere quella spesa (ma resta comunque
  obbligato a fatturare/certificare il compenso).
- **Scadenze**: attualmente trasmissione con cadenza (mensile facoltativa / annuale entro fine
  gennaio-marzo dell'anno successivo, salvo proroghe annuali del MEF — **verificare la scadenza
  corrente prima di ogni invio**, poiché cambia frequentemente).

### 1.2 Fatturazione elettronica e prestazioni sanitarie
- Dal 2019 (DM 19/10/2020 e succ. proroghe annuali, tuttora in vigore) è **vietato** emettere
  fattura elettronica via SDI per le prestazioni sanitarie rese a persone fisiche i cui dati
  vengono (o andrebbero) trasmessi al Sistema TS, a tutela della riservatezza dei dati sanitari
  (art. 9 GDPR).
- La fattura/ricevuta va quindi emessa **fuori SDI** (cartacea o PDF), con dicitura del tipo
  *"fattura non soggetta a fatturazione elettronica ai sensi del provvedimento AdE del
  ..., dati trasmessi al Sistema Tessera Sanitaria"* (o "operazione esente dall'obbligo di
  fatturazione elettronica se il paziente si è opposto all'invio").
- Le prestazioni sanitarie sono di regola **esenti IVA** ai sensi dell'**art. 10, n. 18, DPR
  633/1972** ("natura" IVA `N4` nei tracciati fattura elettronica, usata comunque come
  riferimento anche sui documenti extra-SDI). Eventuale vendita di prodotti (tutori, materiale)
  può invece avere IVA ordinaria e, se fatturata elettronicamente a soggetti diversi da persone
  fisiche, richiede regolare invio SDI.
- Marca da bollo (2€) obbligatoria per importi esenti IVA superiori a 77,47€; ritenuta d'acconto
  se applicabile al regime del professionista: **già gestite** nel modello `Invoice` esistente
  (`isStamp`, `isTaxWithholding`).
- **Numerazione progressiva**: le fatture/ricevute devono avere una numerazione progressiva
  senza interruzioni per anno fiscale (obbligo generale di corretta tenuta della contabilità).

### 1.3 Fascicolo Sanitario Elettronico (FSE)
- **Base legale**: D.L. 179/2012 art. 12; DPCM 178/2015; D.L. 34/2020 art. 11 e decreti
  attuativi 2022 ("FSE 2.0"); investimenti e scadenze **PNRR Missione 6 Componente 2**.
- **Obbligo attuale**: pienamente cogente per strutture del SSN, ASL, ospedali; in fase di
  progressiva estensione anche a **strutture/professionisti sanitari privati**, incluse le
  prestazioni fisioterapiche, con scadenze fissate/prorogate a livello nazionale e attuazione
  demandata alle singole **Regioni** (ogni Regione ha una propria infrastruttura di
  interoperabilità: es. Lombardia, Emilia-Romagna, Lazio, ecc., spesso tramite intermediari
  tecnologici accreditati).
- **Requisiti tecnici per l'alimentazione**: accreditamento formale presso la Regione/ASL
  competente, certificato di firma digitale, generazione dei documenti clinici in formato
  **CDA2 (HL7 Clinical Document Architecture)** con metadati **IHE XDS**, trasmissione al
  gateway regionale (SOAP/REST secondo lo standard regionale).
- **Consensi**: alimentazione (in molte Regioni ormai automatica/obbligatoria anche senza
  consenso esplicito) e consultazione da parte di terzi operatori (richiede consenso specifico
  e revocabile del paziente).
- **Perché non è integrabile "a scatola chiusa"**: a differenza del Sistema TS (un solo
  endpoint nazionale), il FSE richiede un accreditamento specifico per Regione e per singolo
  titolare di P.IVA/struttura: non è possibile realizzare un connettore realmente funzionante
  senza le credenziali e le specifiche tecniche fornite dalla Regione di competenza del cliente.

### 1.4 GDPR e dati sanitari
- Dati sanitari = categoria particolare ex **art. 9 GDPR**: richiedono consenso esplicito,
  base giuridica adeguata, informativa privacy dedicata, misure di sicurezza rafforzate.
- Diritto di accesso/cancellazione **bilanciato** con l'obbligo di conservazione della
  documentazione sanitaria (in genere 10-20 anni a seconda del tipo di documento/regione):
  la cancellazione va gestita con attenzione (es. anonimizzazione anziché cancellazione fisica
  per i documenti soggetti a obbligo di conservazione).
- Necessario un **registro dei trattamenti**, un audit trail degli accessi alla cartella clinica
  digitale, e — se applicabile — nomina di un DPO.
- **Conservazione sostitutiva a norma** (CAD, D.Lgs. 82/2005) per fatture e cartella clinica
  digitale, con marcatura temporale.

## 2. Stato di adeguamento di Rehablo (prima di questo intervento)

| Adempimento | Stato precedente |
|---|---|
| Dati fiscali struttura/tenant (CF, PEC, indirizzo) | ❌ assenti |
| Dati professionista (CF, iscrizione Albo TSRM-PSTRP) | ❌ assenti |
| Consenso privacy/GDPR paziente | ❌ assente |
| Opposizione paziente a invio Sistema TS | ❌ assente |
| Consenso FSE (alimentazione/consultazione) | ❌ assente |
| Numerazione progressiva fattura/ricevuta | ❌ assente (nessun campo `documentNumber`) |
| Natura IVA esente (prestazioni sanitarie) | ❌ assente |
| Export dati Sistema TS | ❌ assente |
| Integrazione FSE (alimentazione documenti clinici) | ❌ assente |

## 3. Modifiche implementate (Fase 1 — questa iterazione)

1. **`Tenant`**: aggiunti `taxCode`, `pec`, `sdiRecipientCode`, indirizzo completo,
   `lastDocumentNumberByYear` (contatore progressivo fatture per anno fiscale).
2. **`Structure`**: aggiunti indirizzo completo, `region` (necessario per instradare la
   futura integrazione FSE verso il gateway regionale corretto), `structureCode`.
3. **`User`**: aggiunti `taxCode`, `professionalRegisterNumber`,
   `professionalRegisterProvince` (iscrizione Albo TSRM-PSTRP del fisioterapista).
4. **`Patient`**: aggiunti `privacyConsent` + data, `privacyPolicyVersion`,
   `stsOppositionToDataSending` (diritto di opposizione Sistema TS),
   `fseConsentFeeding`/`fseConsentViewing` + data (consensi FSE), `structureId` (struttura di
   riferimento anagrafico — necessaria in un contesto multi-struttura/multi-regione, vedi punto 9).
5. **`Invoice`**: aggiunti `documentNumber`/`documentYear` (progressivo per anno fiscale,
   assegnato automaticamente e in modo atomico in `invoice.controller.ts`), `documentType`,
   `vatNature` (es. `N4` per operazioni esenti art. 10 DPR 633/72), `stsExpenseTypeCode`,
   `stsExcluded` (calcolato automaticamente se il paziente si è opposto), `stsSent`, `stsSentAt`.
6. **`Invoice.issuer`** (JSONB): snapshot dei dati del cedente/prestatore (ragione sociale,
   P.IVA, codice fiscale, indirizzo completo, PEC, email, telefono) congelato all'emissione.
   Obbligatori sul documento per l'art. 21 comma 2 DPR 633/72. Sono copiati e non letti dal
   tenant in fase di stampa/export perché, se lo studio cambia sede o partita IVA, i documenti
   già emessi devono continuare a riportare i dati validi alla data di emissione — stesso
   principio già applicato a `productName`/`productVat` sulle righe.
   - `POST /invoice` rifiuta con **422** se i dati obbligatori dello studio sono incompleti
     (vedi `modules/invoice/utils/issuer.ts`): il controllo è lato server perché una fattura
     priva dei dati obbligatori sarebbe comunque già numerata, e i buchi nella numerazione
     non si sanano cancellando il documento.
   - `GET /reports/issuer-status` espone alla UI l'elenco dei dati mancanti, per avvisare
     prima della compilazione.
   - `buildSistemaTSRecord()` legge l'identificativo dell'erogatore dallo snapshot; i documenti
     anteriori all'introduzione del campo ricadono sui dati correnti del tenant.
7. **`modules/invoice/utils/sistemaTS.ts`**: costruzione dei record e generazione di un file
   XML "best effort" con i dati da trasmettere al Sistema TS (da validare con il tracciato
   ufficiale prima di un invio reale).
8. **`GET /invoice/export/sistema-ts?year=YYYY&markAsSent=true`**: nuovo endpoint che genera
   il file di export per l'anno richiesto, escludendo automaticamente le fatture con paziente
   opposto o già inviate.
9. **`modules/compliance/fse/`**: interfaccia `FseAdapter` + implementazione di default
   `NullFseAdapter` (non effettua alcun invio reale, logga chiaramente che l'integrazione va
   completata con un connettore regionale specifico) — predisposizione per la Fase 3.
10. **`Evaluation.structureId`** (+ fallback su `Patient.structureId`) e
    **`regionResolver.ts`/`getFseAdapter(regionCode)`**: correzione di un gap di modellazione —
    un tenant può avere più `Structure` in Regioni diverse, quindi l'adapter FSE va scelto per
    ogni singolo documento in base alla Regione della struttura in cui è stato erogato, non una
    sola volta per tenant (dettagli in `modules/compliance/fse/README.md`, sezione 6).
11. **Regime fiscale** (`Tenant.taxRegime` + `modules/invoice/utils/fiscalRegime.ts`):
    il codice della tabella `RegimeFiscale` FatturaPA (RF01-RF19) determina in modo deterministico
    come viene costruito ogni documento — se si espone l'IVA, quale natura indicare al suo posto
    (`N4` esente art. 10 vs `N2.2` non soggetta per i forfettari), se è ammessa la ritenuta
    d'acconto (esclusa dall'art. 1, c. 67, L. 190/2014) e quali diciture sono obbligatorie.
    Insieme al regime sono stati aggiunti `socialSecurityFund`/`socialSecurityRate` (rivalsa INPS
    4% vs contributo integrativo di cassa, che si comportano diversamente rispetto alla ritenuta),
    `withholdingRate`, `stampDutyAmount` e `stampChargedToPatient`.
    - `resolveFiscalProfile()` traduce i dati aziendali in regole applicabili; `applyFiscalRules()`
      in `invoice.controller.ts` le impone **lato server**, come già per i dati dell'emittente.
    - La **marca da bollo** (2,00 € oltre 77,47 €, DPR 642/72) viene applicata automaticamente
      valutando la soglia sull'imponibile delle sole righe **senza IVA**: su una fattura mista
      (prestazione esente + vendita di un prodotto con IVA) è quella la base di legge. Il tributo
      concorre al totale **solo se riaddebitato** al paziente (art. 15, c. 1, n. 3, DPR 633/72):
      in precedenza il backend non lo sommava mai e il frontend sempre, con totali divergenti.
    - `Invoice.fiscalNotes` (JSONB) congela le **diciture obbligatorie** all'emissione e
      `issuer.taxRegime` il regime vigente in quella data, con lo stesso principio dello snapshot
      dell'emittente: una fattura emessa in forfettario resta tale anche dopo il passaggio
      all'ordinario.
    - `GET /reports/issuer-status` restituisce anche il `fiscalProfile` risolto, così il form
      fattura propone i valori corretti invece di lasciar comporre documenti che il server
      dovrebbe poi correggere in silenzio.
    - Riferimento normativo di dettaglio: **`docs/REGIME_FISCALE_IT.md`**.
12. **Ciclo documentale e audit (aggiornamento 2026-08-24)**:
    - `Invoice.status` viene usato come stato documentale/pagamento (`draft`, `issued`, `paid`,
      `void`, `credited`) e sono stati aggiunti `issuedAt`, `sourceInvoiceId`, `voidedAt`,
      `voidedBy`, `voidReason`, `creditedAt`, `creditedBy`.
    - `POST /invoice` puo' creare una bozza (`status: draft`) senza bruciare numerazione; la
      numerazione progressiva e lo snapshot emittente vengono assegnati solo all'emissione.
    - `POST /invoice/:invoiceId/issue` emette una bozza numerandola in transazione.
    - `POST /invoice/:invoiceId/void` storna un documento emesso senza cancellarlo fisicamente.
    - `POST /invoice/:invoiceId/credit` crea una nota di credito numerata e collega il documento
      sorgente tramite `sourceInvoiceId`.
    - `Invoice.recipient` congela i dati principali del paziente intestatario sul documento
      fiscale, prerequisito per ristampe corrette e futura anonimizzazione dell'anagrafica.
    - `PUT /invoice/:invoiceId` blocca modifiche distruttive su documenti gia' emessi: restano
      ammessi solo aggiornamenti non fiscali limitati allo stato pagamento e ai dati pagamento.
    - `DELETE /invoice/:invoiceId` cancella fisicamente solo bozze non numerate; per documenti
      emessi risponde 409 e richiede storno/nota di credito.
    - `AuditLog` tenant-scoped e `recordAuditEvent()` registrano gli eventi documento principali
      (bozza, emissione, update, storno, nota di credito, export STS marcato inviato).
    - `ConsentEvent` tenant-scoped registra lo storico dei consensi privacy/STS/FSE; e'
      disponibile `GET /patient/:patientId/consents`.
    - `DELETE /patient/:patientId` non effettua hard delete se esistono fatture, valutazioni o
      misurazioni collegate: il paziente viene marcato con `deactivatedAt` per retention.
    - La scrittura di misurazioni manuali/API/import CSV verifica ora che il `patientId` sia
      nello scope RBAC dell'utente, non solo la lettura.


> Le colonne tenant-scoped vengono create automaticamente al primo accesso allo schema del tenant
> tramite `TENANT_SCHEMA_SYNC=additive` (`alter: { drop: false }`), quindi senza rimuovere colonne
> esistenti.
>
> **Eccezione**: `public.tenants` non è tenant-scoped e non viene toccata dal sync. Le colonne del
> regime fiscale vanno applicate con la migration
> `migrations/20260811-add-tax-regime-to-tenant.js`.

## 4. Matrice operativa aggiornata (2026-08-24)

Questa matrice separa quello che e' gia' stato portato a codice da quello che resta da
implementare e da cio' che richiede input esterni del cliente/provider. Serve come riferimento
prima di aprire nuove iterazioni tecniche.

| Area | Gia' presente nel backend | Da implementare nel backend | Dipendenze esterne |
|---|---|---|---|
| Sistema TS | Opposizione paziente, `stsExcluded`, export XML best-effort, audit export | `StsSubmission`/`StsSubmissionItem`, validazione tracciato/XSD, codici spesa versionati, pagamento tracciato/non tracciato, rimborsi/rettifiche/annullamenti/reinvii, ricevute/esiti | Credenziali STS nominali o intermediario; tracciati e tabelle ufficiali dell'anno fiscale; scelta canale web service/upload/provider |
| FSE | Consensi FSE paziente, storico `ConsentEvent`, `Structure.region`, `FseAdapter`/`NullFseAdapter`, risoluzione Regione per valutazione | `ClinicalDocument`, `FseSubmission`, generazione documento da valutazione chiusa, CDA2/PDF firmato, metadati XDS/FHIR dove richiesti, adapter regionale/provider, ricevute/retry/audit FSE | Accreditamento Regione/ASL, endpoint, certificati, ambiente test, manuale interoperabilita' regionale o provider autorizzato |
| SDI e conservazione | Dati fiscali tenant, PEC/codice SDI, regime fiscale, snapshot emittente/destinatario, ciclo documento non distruttivo | Separazione canale extra-SDI sanitario vs FatturaPA B2B/PA/non sanitario, XML FatturaPA, invio provider/canale, ricevute/scarti, pacchetti conservazione | Provider SDI/conservazione o canale accreditato; policy fiscale/commercialista |
| GDPR/dati sanitari | `AuditLog`, `ConsentEvent`, audit principali, deactivation paziente con record collegati, RBAC su scrittura misure | Audit sistematico su tutti gli accessi clinici, retention configurabile, export dati paziente, anonimizzazione/pseudonimizzazione, cifratura file/storage, rimozione log sensibili, rate limit | Policy privacy approvata: tempi retention, base giuridica, informative, DPO se dovuto |

Nota tecnica: STS production, FSE reale e SDI/conservazione non possono essere chiusi solo con
codice locale. Il backend puo' pero' implementare gia' i modelli, gli stati, le validazioni, gli
adapter e i workflow di preparazione; l'invio reale va attivato quando sono disponibili credenziali,
certificati, endpoint e provider.

## 5. Roadmap consigliata (fasi successive)

**Fase 2 — Sistema TS "production ready"**
- Introdurre i modelli `StsSubmission` e `StsSubmissionItem`, con stato, payload hash,
  progressivo invio, ricevuta, errori e utente operatore.
- Rendere l'export STS riproducibile: simulazione, generazione file, conferma invio, ricevuta.
- Aggiungere sui documenti fiscali la modalita' pagamento tracciato/non tracciato e usarla nel
  record STS.
- Validare `sistemaTS.ts` contro l'ultimo tracciato/XSD ufficiale e la tabella "Tipologia di
  spesa" in vigore per l'anno fiscale corrente.
- Gestire rimborsi, rettifiche, annullamenti e reinvii senza alterare i documenti fiscali
  originari.
- Invio via web service SOAP del Sistema TS (attualmente l'endpoint genera solo il file da
  caricare manualmente sul portale) previa registrazione delle credenziali del cliente.
- Template di stampa fattura/ricevuta con dicitura di esenzione SDI e natura IVA esente.

**Fase 3 — FSE**
- Determinare, per ciascun tenant, la Regione di competenza (`Structure.region`) e verificare
  i requisiti/tempistiche di obbligo per la propria categoria.
- Supportare il cliente nell'accreditamento regionale (fuori dal perimetro del solo software).
- Introdurre `ClinicalDocument` e `FseSubmission` per tracciare documenti clinici, payload,
  metadati, esiti, errori, retry e repository id.
- Generare il documento candidato alla chiusura di una valutazione/referto.
- Implementare CDA2 reale, PDF firmato dove necessario, metadati XDS/FHIR richiesti e adapter
  concreto per Regione o provider/intermediario.
- Mantenere audit trail specifico sugli accessi e sulle operazioni FSE.

**Fase 4 — GDPR, retention e sicurezza dati**
- Audit trail sistematico su accessi a valutazioni, fatture sanitarie, misure, documenti clinici
  e file grezzi.
- Export dati paziente e workflow revisionabile di anonimizzazione/pseudonimizzazione.
- Policy di retention/anonimizzazione conformi ai tempi minimi di conservazione sanitaria.
- Cifratura applicativa o storage sicuro per file grezzi sanitari.
- Rimozione log debug con payload utente/tenant e rate limit su auth/ingestion.

**Fase 5 — SDI e conservazione**
- Mantenere fuori SDI le prestazioni sanitarie rese a persone fisiche quando rientrano nel divieto
  di fatturazione elettronica sanitaria.
- Generare FatturaPA XML per B2B/PA/non sanitario.
- Integrare provider/canale SDI con ricevute, scarti e retry.
- Integrare conservazione sostitutiva a norma tramite provider o processo accreditato.

## 6. Avvertenza

Le integrazioni con Sistema TS e FSE prevedono **credenziali di accreditamento nominali**
(P.IVA/CF del professionista o della struttura) e, per il FSE, un accordo con l'infrastruttura
regionale competente: non sono attivabili "a codice" senza questi elementi forniti dal cliente
o dal suo commercialista/consulente. Il codice di questa fase fornisce le fondamenta dati e
gli export/adapter necessari a collegare rapidamente tali servizi non appena disponibili le
credenziali.

