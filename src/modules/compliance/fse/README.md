# FSE (Fascicolo Sanitario Elettronico) — come funziona davvero

Questo modulo è uno **scaffolding**: definisce l'interfaccia (`FseAdapter`) e i tipi necessari
per collegare Rehablo al Fascicolo Sanitario Elettronico, ma **non esegue alcuna trasmissione
reale** finché non viene implementato un adapter concreto per la Regione del cliente (vedi
`NullFseAdapter`, l'implementazione di default che si limita a loggare "non configurato").

## 1. Gli attori in gioco

```
 Rehablo (sistema alimentante)
        │
        │ 1. genera il documento clinico (CDA2) + metadati (IHE XDS)
        │ 2. lo firma digitalmente
        ▼
 Gateway / Infrastruttura di interoperabilità REGIONALE
 (uno per Regione: Lombardia, Emilia-Romagna, Lazio, ecc.
  spesso gestito da un intermediario tecnologico accreditato,
  es. Lispa, InSiel, Dedalus, Regione stessa...)
        │
        │ 3. valida, indicizza (Registry) e archivia il file (Repository)
        ▼
 INI — Infrastruttura Nazionale per l'Interoperabilità
 (fa da "hub" tra le Regioni: permette a un medico in Regione X
  di consultare un documento alimentato da una struttura in Regione Y)
        │
        ▼
 Altri operatori sanitari / il paziente stesso (app IO, portale FSE regionale)
 → CONSULTANO il documento (se hanno il consenso)
```

Rehablo, per un fisioterapista libero professionista o uno studio privato, gioca sempre e solo
il ruolo di **sistema alimentante**: produce documenti e li invia. Non deve mai implementare il
lato "consultazione" (quello lo fa il portale regionale/l'app IO).

## 2. Cosa viaggia concretamente: due pacchetti distinti

Ogni invio ("alimentazione") consiste in **due parti**, entrambe obbligatorie:

1. **Il documento clinico**, in formato **CDA2** (HL7 Clinical Document Architecture) — vedi
   `cda2Builder.ts` in questo modulo per uno scheletro di partenza. È un XML con:
   - **Header**: chi è il paziente (CF), chi è l'autore (CF del fisioterapista), tipo di
     documento, data, livello di riservatezza.
   - **Body**: il contenuto clinico vero e proprio (narrativo a "Livello 1", oppure sezioni
     codificate LOINC/SNOMED a "Livello 2/3" per la piena interoperabilità semantica).
   - Il file XML va poi **firmato digitalmente** (CAdES) e in molte Regioni anche **marcato
     temporalmente**.

2. **I metadati IHE XDS** (`IheXdsMetadata` nell'interfaccia `FseAdapter`), che NON fanno parte
   del contenuto del documento ma servono al **Registry regionale** per indicizzarlo e renderlo
   cercabile: identificativo univoco del documento, classe/tipo documento, formato, ambito
   clinico (es. "Medicina fisica e riabilitazione"), tipo di struttura erogante, codice di
   riservatezza, lingua, ecc.

Questi due pacchetti (documento + metadati) vengono trasmessi insieme al gateway regionale
tramite la transazione IHE **ITI-41 "Provide and Register Document Set-b"** (un web service
SOAP con allegato MTOM/XOP), che è lo standard su cui si basano tutte le infrastrutture FSE
regionali italiane.

## 3. Cosa invierebbe concretamente un fisioterapista

Documenti clinici tipici prodotti dal modulo `evaluations`/`human-body` di Rehablo che
avrebbe senso alimentare nel FSE:

- **Referto di valutazione fisioterapica iniziale** (anamnesi, scale/test somministrati,
  articolarità, forza, sintomi rilevati).
- **Piano di trattamento riabilitativo** (obiettivi, protocollo assegnato).
- **Relazione di fine trattamento / dimissione** (esito, scale di controllo finali).

Ognuno di questi diventerebbe un `FseClinicalDocument` con il proprio `documentType` e i
metadati IHE XDS coerenti (classe "Referto", ambito "Medicina fisica e riabilitazione").

## 4. Alimentazione vs Consultazione (non confondere)

- **Alimentazione** = Rehablo pubblica un documento nel Fascicolo del paziente. In molte Regioni
  è ormai un obbligo che prescinde da un consenso esplicito del paziente (il consenso "di
  default" è già previsto dalla normativa FSE 2.0), ma va comunque informato.
- **Consultazione** = un ALTRO operatore sanitario (es. un medico, un altro specialista) legge
  quel documento dal Fascicolo. Questa richiede un **consenso specifico e revocabile** del
  paziente, gestito dal portale regionale — Rehablo può solo interrogare lo stato di quel
  consenso (`getConsentStatus`), non modificarlo.

## 5. Cosa serve realmente per attivare un adapter concreto (fuori dal perimetro del solo codice)

1. **Accreditamento** del professionista/struttura presso la Regione competente (pratica
   amministrativa, richiede tempo, non è automatizzabile via software).
2. **Certificato di firma digitale** (spesso su smart card/CNS o firma remota con HSM) per
   firmare ogni CDA2 prodotto.
3. **Credenziali/endpoint del gateway regionale** (URL del web service, WSDL, eventuale mutual
   TLS) forniti dalla Regione o dall'intermediario tecnologico incaricato.
4. **Ambiente di collaudo regionale**: quasi tutte le Regioni offrono un ambiente di test prima
   di abilitare l'invio in produzione, dove validare i primi documenti.

## 6. Multi-tenant, multi-struttura, multi-regione: come si sceglie l'adapter giusto

**Un singolo tenant può avere più `Structure` (sedi), anche in Regioni diverse fra loro.**
Per questo l'adapter FSE **non va scelto una volta per tenant**, ma **per ogni singolo
documento**, in base alla Regione della struttura in cui è stato effettivamente erogato:

```
 tenant "Studio Rossi"
   ├── Structure "Sede Milano"   → region = "LOMBARDIA"
   └── Structure "Sede Bologna"  → region = "EMILIA-ROMAGNA"
```

Per rendere questo possibile:

- **`Evaluation.structureId`** identifica in quale sede è stata svolta la valutazione (fonte
  primaria per instradare l'invio).
- **`Patient.structureId`** è la struttura di riferimento anagrafico del paziente, usata come
  **fallback** se la singola valutazione non specifica una struttura propria.
- **`regionResolver.ts`** (`resolveRegionForEvaluation`) applica questa logica: dato
  `structureId` (o in mancanza il `patientId`), recupera la `Structure` corrispondente e ne
  legge `region`.
- **`getFseAdapter(regionCode)`** (in `nullFseAdapter.ts`) seleziona l'adapter concreto
  registrato per quella Regione tramite `registerFseAdapter(regionCode, factory)`; se nessun
  adapter è ancora stato registrato per quella Regione, ricade su `NullFseAdapter` (loggando
  esplicitamente quale Regione manca), invece di inviare tutto con un adapter "di default"
  potenzialmente sbagliato.

Uso tipico, dal punto dove viene generato un documento clinico (es. dopo aver completato una
`Evaluation`):

```ts
const region = await resolveRegionForEvaluation({
    tenantSchema,
    structureId: evaluation.structureId,
    patientId: evaluation.patientId
});

const adapter = getFseAdapter(region); // NullFseAdapter finché non è configurato un adapter per `region`
const result = await adapter.feedDocument(clinicalDocument);
```

## 7. Come si collega tutto questo al resto di Rehablo (quando sarà il momento)

Un adapter concreto (es. `LombardiaFseAdapter implements FseAdapter`), registrato con
`registerFseAdapter('LOMBARDIA', () => new LombardiaFseAdapter())`, dovrebbe:

```ts
async feedDocument(document: FseClinicalDocument): Promise<FseFeedResult> {
  const cda2Xml = buildCda2Skeleton(document);        // 1. genera il CDA2
  const signedXml = await signCades(cda2Xml, cert);    // 2. firma digitale (da implementare)
  const soapEnvelope = buildIti41Envelope(signedXml, document.metadata); // 3. metadati IHE XDS
  const response = await soapClient.send(soapEnvelope); // 4. invio al gateway regionale
  return { success: response.ok, repositoryDocumentId: response.documentUniqueId, message: '...' };
}
```

I punti 2-4 richiedono le credenziali/endpoint del punto 5 sopra: per questo `NullFseAdapter`
resta l'adapter di default finché queste informazioni non sono disponibili — evita di
implementare (o peggio, di far credere funzionante) un'integrazione che non può essere testata
né validata senza un vero accreditamento regionale.



