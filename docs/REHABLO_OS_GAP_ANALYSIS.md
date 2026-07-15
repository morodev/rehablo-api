# Rehablo OS — Analisi del backend attuale & strategia di integrazione dispositivi

> Documento di analisi tecnica preparato a partire dalla visione "Rehablo OS" (conversazione strategica)
> e dallo stato **reale** del backend `rehablo-api`.
> Obiettivo: (1) capire cosa esiste già e cosa manca; (2) definire la soluzione migliore per integrare
> le apparecchiature di valutazione (VALD, Hawkin, Kinvent, Delsys, Noraxon, ecc.).

---

## 0. TL;DR (sintesi per chi ha fretta)

- Il backend **non parte da zero**: le fondamenta cliniche (paziente, valutazioni, ROM, forza manuale,
  sintomi/dolore, test ortopedici, questionari/scale PROMs, motore protocolli con fasi ed esercizi,
  agenda, fatturazione, consensi GDPR/FSE/STS) **ci sono già**.
- Mancano soprattutto **tre grandi blocchi**:
  1. Un **modello dati unificato delle misurazioni** (Observation/Metric) con i **metadata della
     misurazione** e un **dizionario dei dati** (Clinical Data Dictionary).
  2. I **dati strumentali** che oggi non esistono come struttura: metriche di forza da pedana/dinamometro
     (Peak Force, RFD, LSI…), performance neuromuscolare (CMJ, SJ, RSI, hop test), analisi del movimento,
     EMG; e il **logging degli interventi** oltre agli esercizi (terapia manuale, fisica/strumentale).
  3. Il **livello di integrazione** (API pubbliche, developer portal, connettori, import CSV/file, code
     asincrone) e il **motore del percorso + AILivello 1 (regole)**, che oggi non esistono.
- Sull'integrazione dispositivi la tua intuizione è corretta ma va completata: serve un **modello ibrido**
  → **API di ingestione proprietarie + Developer Portal** (per i partner aperti e per il futuro) **PIÙ**
  **connettori "pull"** verso le API dei vendor esistenti (VALD, Hawkin) **PIÙ** **import file** (Kinvent,
  Biodex…) **PIÙ** inserimento manuale. Il cuore di tutto è un **modello canonico Rehablo** che fa da
  "anti-corruption layer": il core non conosce VALD o Delsys, conosce solo le *Observation Rehablo*.

---

## 1. Stato reale del backend `rehablo-api`

### 1.1 Stack & architettura
- **Runtime**: Node.js ≥18, TypeScript, ES Modules.
- **Web**: Express 4.19, Helmet, CORS, Morgan, body-parser.
- **DB/ORM**: **PostgreSQL + Sequelize 6** (NON Mongoose).
- **Auth**: JWT stateless (`jsonwebtoken`) + RBAC con `accesscontrol`. Flag super-admin, multi-tenant.
- **Altro**: `bcryptjs`, `nodemailer` (email), `stripe` (pagamenti), `express-validator`, `moment`, `lodash`.
- **Architettura multi-tenant**: isolamento per **schema Postgres**.
  - Schema **`public`**: dati condivisi → utenti, tenant, strutture (sedi), **cataloghi** (scale/test
    standardizzati, esercizi, template di protocollo).
  - Schema **`rehablo_<tenantId>`**: dati del singolo centro → pazienti, valutazioni, dati clinici,
    fatture, agenda, istanze di protocollo.
  - Gerarchia: **Tenant → Structure (sede) → Users/Patients**. Un tenant può avere più sedi anche in
    regioni diverse (rilevante per FSE regionale).
  - I modelli tenant-scoped vengono registrati (`tenantModelsRegistry.ts`) e sincronizzati **lazy** alla
    prima richiesta del tenant (`ensureTenantSchema`).

### 1.2 Cosa c'è già, modulo per modulo

| Modulo | Contenuto esistente | Note |
|---|---|---|
| **auth** | User, Tenant, TenantUser, StructureUser, UserAvailability | Multi-tenant, sedi, super-admin, disponibilità operatori |
| **patients** | `Patient` (anagrafica + consensi) | name, surname, birthday, fiscalCode, gender, work, hobby, **sport** (stringa), address, emails[], phones[], tags[], notes, **consensi GDPR / opposizione STS / consensi FSE** |
| **evaluations** | `Evaluation` (contenitore di valutazione) | patientId, userId, structureId, date, title, notes, status DRAFT/COMPLETED. È il "contenitore seduta di valutazione" |
| **human-body** | Dati clinici oggettivi | `HumanBodyPoint` (punti su SVG corpo), `HumanBodySymptom` (dolore mattino/pomeriggio/sera/notte), **`HumanBodyArticularity` = ROM** (passivo/attivo, dolore, forza), **`HumanBodyStrength`** (forza manuale + dolore), `TestInstance` (**test ortopedici** speciali, isPositive), **questionari** custom + **scale standardizzate/PROMs** (`Scale` con score+interpretazione JSON, `UserScaleInstance`/`UserAnswer`) |
| **protocols** | **Motore protocolli (scheletro)** | Catalogo (public): `Exercise` (nome, video, categoria, distretti, attrezzatura), `ProtocolTemplate`, **`ProtocolPhaseTemplate`** (name, order, **durationDays, goals, progressionCriteria** come TEXT libero), `ProtocolTemplateExercise` (sets/reps/durata/freq settimanale). Tenant: `ProtocolInstance` (assegnazione al paziente), **`ProtocolPhaseInstance`** (avanzamento fase: status PENDING/IN_PROGRESS/COMPLETED + note), **`ProtocolExerciseLog`** (diario esercizi: completed, sets/reps completati, **painLevel, difficultyLevel**, note) |
| **agenda** | EventType, AgendaEvent (ricorrenze), AgendaEventException | Calendario/appuntamenti |
| **invoice** | Invoice + InvoiceProduct/Service | **Compliance fiscale IT**: STS (Tessera Sanitaria), fattura/ricevuta, rivalsa INPS, ritenuta, bollo |
| **products-services** | Category, Product, Service | Anagrafiche commerciali |
| **configuration** | Dashboard, Widget | Personalizzazione UI |
| **compliance/fse** | Modulo FSE | Fascicolo Sanitario Elettronico (vedi `COMPLIANCE.md`) |

**Conclusione parziale:** rispetto alla visione, il backend copre **già oggi** buona parte delle aree 1–4
(anagrafica base, ROM, forza manuale, dolore/sintomi, test, questionari/PROMs) e ha **già uno scheletro**
del "Clinical Pathway Engine" (aree 9 parziale + timeline fasi). Il grosso del lavoro è sui **dati
strumentali**, sul **modello di misurazione unificato**, sul **motore a regole** e sul **layer di
integrazione**.

---

## 2. Gap Analysis — le 12 aree del Clinical Data Model

Legenda: 🟢 presente · 🟡 parziale · 🔴 assente

| # | Area (visione) | Stato | Cosa manca concretamente |
|---|---|---|---|
| 1 | Anagrafica e contesto | 🟡 | Mancano **altezza, peso, BMI (derivato), arto dominante, livello sportivo (amatore/pro), ruolo, ore/settimana di allenamento, obiettivi del paziente**. Oggi `sport` è una stringa libera. → serve un `ClinicalProfile` o estensione strutturata del paziente |
| 2 | Dati clinici / diagnosi | 🔴 | **Nessuna struttura**: diagnosi, **codici ICD**, distretto, **data infortunio**, **data intervento**, fase biologica, imaging, farmaci, **controindicazioni**, comorbidità, recidive, fattori psicosociali, aspettative. Oggi solo testo libero (`background`/`notes`) |
| 3 | Questionari (PROMs) | 🟢/🟡 | Infrastruttura scale/questionari **presente** (score+interpretazione). Manca **il seeding dei PROMs clinici** (IKDC, KOOS, Lysholm, ACL-RSI, DASH, SPADI, ODI, Roland-Morris, NPRS, VAS, PSFS, EQ-5D) come catalogo pronto |
| 4 | ROM | 🟢 | Presente (`HumanBodyArticularity`: attivo/passivo, dolore, deficit). Eventualmente aggiungere calcolo **simmetria/deficit dx-sx automatico** |
| 5 | Forza | 🟡 | Esiste solo **forza manuale** (`HumanBodyStrength`, un valore). Mancano le **metriche strumentali**: Peak Force, Average Force, **RFD**, Impulse, **LSI**, Torque, Torque/kg → dipendono dal modello Observation (vedi §3) |
| 6 | Performance neuromuscolare | 🔴 | Assente: **CMJ, SJ, DJ, RSI, hop test, drop jump, sprint, agility, COD**, tempo, accel/decel |
| 7 | Analisi del movimento | 🔴 | Assente: cammino/corsa, pattern, asimmetrie, **joint angles**, cadenza, stride length, video, motion capture |
| 8 | EMG | 🔴 | Assente: RMS, peak, timing, **onset/offset**, co-contrazione, fatica, frequenza |
| 9 | Terapia | 🟡 | Presente **solo il diario esercizi** (`ProtocolExerciseLog`). Mancano: **terapia manuale** (tecnica/lato/dose/risposta), **terapie fisiche/strumentali** (tecar, laser, onde d'urto, NMES, BFR: dispositivo, parametri, intensità, durata, eventi avversi), dry needling, taping. Manca un **contenitore "seduta"** che unisca sintomi pre/post + esercizi + terapie |
| 10 | Outcome | 🔴 | Nessuna struttura di outcome finale / esito percorso / follow-up strutturato |
| 11 | Rehablo Clinical Score | 🔴 | Nessun **indice composito** (dolore+ROM+forza+performance+PROMs+…) né servizio di calcolo |
| 12 | **Metadata della misurazione** | 🔴 | **Assente ovunque**: dispositivo, modello, versione software, protocollo, operatore, freq. campionamento, lato, n° prove, best/media, unità, **file grezzo**, qualità, metodo di calcolo, consenso/provenienza. **È il pezzo più strategico e più mancante** |

### 2.1 Gap sul "Clinical Pathway Engine"
- 🟡 **Timeline a fasi**: esiste (`ProtocolPhaseTemplate` + `ProtocolPhaseInstance`).
- 🔴 **Problem list** strutturata (lista problemi ordinata) → assente.
- 🔴 **Goals misurabili** collegati ai problemi (indicatore + scadenza + cadenza rivalutazione) → assenti
  (oggi `goals` è testo libero della fase).
- 🔴 **Criteri di progressione valutabili dalla macchina**: oggi `progressionCriteria` è **testo libero**;
  serve trasformarlo in **regole strutturate** (JSON) che il motore possa confrontare con i valori reali
  del paziente per **proporre** l'avanzamento di fase.
- 🔴 **Motore di rivalutazione** (confronto iniziale/precedente/attuale/obiettivo + velocità di
  miglioramento) → assente.
- 🔴 **Piano settimanale** generato dalla fase → assente (esistono esercizi per fase, non la
  pianificazione settimanale).

### 2.2 Gap "trasversali" (AI, standard, governance)
| Tema | Stato | Nota |
|---|---|---|
| **AI Livello 1 — regole cliniche** | 🔴 | Nessun rule engine (SE dolore>5/10 ALLORA…) |
| **AI Livello 2 — assistente generativo** | 🔴 | Nessuna integrazione LLM (riassunto cartella, bozza piano, report) |
| **AI Livello 3 — modelli predittivi** | 🔴 | Corretto rimandarlo: servono prima i dati |
| **AI Livello 4 — Learning Health System** | 🔴 | Nessuna pipeline dati longitudinale/anonimizzata |
| **Standard FHIR** | 🔴 | Nessuna risorsa/mapping FHIR (Observation, QuestionnaireResponse, CarePlan, Goal) |
| **Dataset ricerca pseudonimizzato** | 🔴 | Isolamento multi-tenant sì, ma nessun layer separato per uso secondario/ricerca (rilevante EHDS) |
| **Documentazione API (OpenAPI/Swagger)** | 🔴 | Necessaria per il developer portal |
| **Upload file / object storage** | 🔴 | Nessun `multer`/storage: serve per i **file grezzi** dei dispositivi (curve forza-tempo, CSV, PDF) |
| **Job/queue asincrone** | 🔴 | Nessun scheduler/worker: serve per **pull periodico** dai vendor e per elaborare import pesanti |

---

## 3. Il pezzo mancante più importante: il modello di misurazione unificato

Prima di collegare qualsiasi macchina, va creato il **modello canonico Rehablo**. È ciò che rende
il software indipendente dai produttori (esattamente come dice la visione: *"il software non deve
conoscere una ForceDecks"*).

Propongo **tre entità nuove** + un **dizionario**:

### 3.1 `MetricDefinition` (Clinical Data Dictionary) — schema `public`
Il "dizionario dei dati". Ogni variabile misurabile del sistema è definita **una volta**:
```
id, code (es. "KNEE_EXT_PEAK_FORCE"), displayName, clinicalDescription,
category (STRENGTH|ROM|NEUROMUSCULAR|MOVEMENT|EMG|QUESTIONNAIRE|SYMPTOM|VITAL),
unit (N, Nm, cm, %, deg, ms, Hz…), dataType (number|ratio|angle|time|boolean),
physiologicalRange {min,max}, mcid (minimal clinically important difference),
applicableDistricts[], applicableSides (LEFT|RIGHT|BILATERAL),
higherIsBetter (bool), aiUsage[] (algoritmi che la usano)
```
→ Integrare un nuovo dispositivo diventa: *"questa macchina produce queste 15 `MetricDefinition`"*.

### 3.2 `Observation` (misurazione unificata) — schema tenant
Sostituisce/affianca le tabelle specializzate. Modellata su **FHIR Observation** per interoperabilità:
```
id, patientId, evaluationId?, sessionId?,
metricCode (FK MetricDefinition), value (number/json per curve),
unit, side (LEFT|RIGHT|BILATERAL), trialNumber?, aggregation (BEST|MEAN|RAW),
effectiveDateTime, sourceId (FK DeviceSource), operatorId,
rawFileId? (FK RawFile), quality (GOOD|DOUBTFUL|INVALID),
calculationMethod, consentRef, provenance (MANUAL|DEVICE_API|IMPORT)
```

### 3.3 `MeasurementMetadata` / `RawFile`
- `MeasurementMetadata`: dispositivo, modello, **versione software**, protocollo, freq. campionamento,
  n° prove, note (dolore/compensi/test interrotto). (Può essere embeddato nell'Observation come JSONB.)
- `RawFile`: file grezzo originale (CSV/JSON/PDF/video) su object storage, con hash e checksum.

> Questo blocco (§3) è il **fondamento**: senza di esso ogni integrazione produce dati "orfani" e non
> confrontabili tra centri. **È la priorità tecnica #1.**

---

## 4. Strategia di integrazione dispositivi (la tua domanda centrale)

La tua idea — *"facciamo delle nostre API con un centro per sviluppatori, chi vuole si integra"* — è
**giusta come visione di lungo periodo** (il modello Stripe/Apple/Garmin). Ma da sola non basta nel breve,
perché i vendor già affermati (VALD, Hawkin) **non scriveranno codice contro le tue API**: espongono le
**loro** e ti aspetti che sia tu a leggerle. Quindi la soluzione migliore è **ibrida, a 4 canali**, tutti
convergenti sullo **stesso modello canonico** (§3).

### 4.1 I 4 canali di integrazione

```
                 ┌────────────────────────────────────────────────┐
                 │              REHABLO CORE / DB                  │
                 │   (Observation + MetricDefinition canonici)     │
                 └───────────────▲───────────────▲────────────────┘
                                 │ (tutto normalizzato in Observation Rehablo)
      ┌──────────────┬───────────┴───────┬───────────────┬─────────────────┐
      │              │                   │               │                 │
① INGESTION API   ② CONNETTORI        ③ IMPORT FILE   ④ INSERIMENTO      (webhook out
  (inbound push)     (outbound pull)     (CSV/Excel/PDF)   MANUALE          verso partner)
  Developer Portal   VALD, Hawkin…       Kinvent, Biodex   fallback
  partner aperti /   (API vendor)        BTS, Easytech
  connettori propri
```

- **① Rehablo Ingestion API (inbound) + Developer Portal** → *la tua idea*.
  - REST versionata (`/v1/observations`, `/v1/measurements`, upload file), documentata (OpenAPI),
    **Sandbox**, autenticazione **OAuth2 client-credentials** o **API key** *scoped per tenant*.
  - Serve per: **partner nuovi/aperti** che vogliono certificarsi, per **i tuoi stessi connettori**, per
    **app wearable** future (Apple Health/Garmin).
  - È il "flywheel" strategico: **Rehablo Certified Devices**.
- **② Connettori "pull"** → per i vendor con API proprie (VALD, Hawkin Dynamics, Delsys/Noraxon SDK).
  - Un **framework a plugin**: interfaccia `Connector { pull(connection): Observation[] }`.
  - Ogni vendor = un adapter che si autentica alle **loro** API, scarica test/metriche e **traduce** nel
    modello canonico usando il **mapping del data dictionary**.
  - Richiede uno **scheduler/worker** (pull periodico) e storage delle credenziali per tenant.
- **③ Import file** → per i dispositivi "chiusi" (Kinvent export CSV/PDF, Biodex, BTS, Easytech).
  - Upload file → parser per formato → normalizzazione unità → Observation. Conserva sempre il `RawFile`.
- **④ Inserimento manuale** → fallback universale (già in parte presente per ROM/forza/test).

### 4.1.1 Come funziona DAVVERO in pratica (chi fa cosa? serve sentire le aziende?)

**Principio di base (fondamentale):** il **proprietario dei dati e dell'account del dispositivo è il
centro**, non Rehablo. Tu costruisci il collegamento **una volta**, poi **ogni centro collega il proprio
account**. Rehablo non chiede i dati "all'azienda in generale": legge i dati **di quel centro**,
**autorizzati da quel centro**. Questo è anche ciò che rende l'operazione lecita (privacy/licenza).

| Canale | Serve contattare l'azienda? | Chi autorizza l'accesso ai dati | Cosa costruisce Rehablo (una volta sola) | Cosa fa il centro (per ogni dispositivo) |
|---|---|---|---|---|
| **② Connettore pull** (VALD, Hawkin…) | **Sì, ma poco**: registrarsi come sviluppatore, leggere la doc, ottenere l'app/credenziali. *Non serve un contratto per iniziare.* | **Il centro**, con le **proprie credenziali** del suo account VALD/Hawkin | Il **connettore** (codice) che parla con l'API del vendor e traduce in `Observation` | Va in *Impostazioni → Dispositivi*, collega il proprio account (OAuth/API key). Fine. |
| **③ Import file** (Kinvent, Biodex, BTS…) | **No.** Basta un **file di esempio** (lo dà il centro, non l'azienda) | Il centro (esporta e carica il file) | Il **parser** del formato CSV/Excel/PDF → `Observation` | Esporta dal software del dispositivo e **carica il file** in Rehablo |
| **④ Manuale** | **No.** | L'operatore | I **form** di inserimento (in parte già esistenti) | Digita i valori |
| **① La TUA Ingestion API** (Developer Portal) | **No** (per costruirla). Semmai sono **loro** a contattare **te** | Il centro (rilascia una API key al partner) | L'**API pubblica** `/v1` + doc + Sandbox | Attiva l'integrazione e genera la API key per quel partner |

**Traduzione pratica:**
- Per i dispositivi **aperti** (VALD, Hawkin): serve un **minimo contatto tecnico** con l'azienda —
  registrarsi al loro portale sviluppatori, leggere la documentazione, ottenere l'accesso all'API. **Non
  serve firmare una partnership per cominciare**: le loro API sono pensate proprio perché software di
  terze parti (come Rehablo) leggano i dati *per conto del cliente che possiede l'account*. Un accordo
  formale serve semmai **dopo**, per il co-marketing ("Rehablo Certified") e per condizioni migliori.
- Per i dispositivi **chiusi** (Kinvent export, Biodex, BTS…): **non serve contattare nessuno**. Lavori
  sul **file esportato** che ti fornisce il centro. Ti basta un file di esempio per scrivere il parser.
- Per l'**inserimento manuale**: niente, è sempre disponibile.
- Per la **tua API/Developer Portal** (canale ①): la costruisci e la pubblichi **senza chiedere permesso a
  nessuno**. Sono i produttori (o l'IT del centro) che un domani si integrano *verso di te*. Diventa
  interessante quando Rehablo ha abbastanza centri da rendere conveniente per loro comparire tra i
  "dispositivi compatibili".

**Esempio concreto — un centro con una pedana VALD ForceDecks:**
1. *Una volta per tutte:* Rehablo si registra sul portale sviluppatori VALD, legge la doc, scrive il
   **connettore VALD** (mappa i test ForceDecks → metriche del dizionario Rehablo: CMJ height, Peak Force,
   RSI, asimmetria…).
2. *Il centro:* in Rehablo apre *Dispositivi → VALD → Collega*, inserisce/autorizza le **sue** credenziali
   VALD. (I dati restano suoi: sta solo dando a Rehablo il permesso di leggerli.)
3. *Automatico:* ogni notte (o on-demand) il connettore **scarica i nuovi test** di quel centro, li
   normalizza in `Observation` Rehablo e li collega al paziente giusto (matching per nome/data nascita o
   ID esterno).
4. *Risultato:* il fisioterapista apre la cartella del paziente e vede i dati VALD **già dentro Rehablo**,
   confrontabili con ROM, forza, PROMs, ecc. — **senza reinserire nulla a mano**.

> In sintesi: **le uniche aziende da "sentire" sono quelle a canale ② (VALD, Hawkin) e solo per la parte
> tecnica** (accesso al loro portale sviluppatori). Tutto il resto (import file, manuale, la tua API) **non
> richiede il coinvolgimento del produttore**. E in ogni caso è sempre **il centro** ad autorizzare
> l'accesso ai propri dati.

### 4.1.2 Esempio END-TO-END: come si integra un dinamometro e DOVE finiscono i dati

> Questa sezione risponde a: *"come faccio a sapere che modello creare? per il dinamometro come lo
> integro? i dati dove li salva?"*

**Il concetto che cambia tutto:** **NON si crea un modello/tabella nuovo per ogni dispositivo.** Il modello
è **già deciso e fisso** (`Observation` + `MetricDefinition`, vedi §3). Integrare un dispositivo significa
solo **due cose**:
1. Definire (una volta) **quali metriche del dizionario** produce quel dispositivo (`MetricDefinition`).
2. Scrivere una **mappatura** *campo del dispositivo → codice metrica Rehablo* (+ conversione unità).
I dati poi finiscono **sempre nella stessa tabella `observations`**, qualunque sia il dispositivo.

#### Passo 0 — Cosa "sputa fuori" il dinamometro
Esempio di export di un dinamometro (isometrico) per la forza degli estensori del ginocchio:
```
Paziente,      Data,        Muscolo,          Lato,    Peak Force (N), Test
Mario Rossi,   2026-07-10,  Estensori ginocch, Sinistro, 245.3,        MVIC
Mario Rossi,   2026-07-10,  Estensori ginocch, Destro,   320.1,        MVIC
```

#### Passo 1 — Voci del dizionario (`MetricDefinition`), create UNA volta (schema public)
| code | category | unit | side | higherIsBetter |
|---|---|---|---|---|
| `KNEE_EXT_PEAK_FORCE` | STRENGTH | N | LEFT/RIGHT | true |
| `KNEE_EXT_LSI` (derivata) | STRENGTH | % | BILATERAL | true |

> Queste voci **valgono per QUALSIASI dinamometro** (Kinvent, VALD DynaMo, handheld…). Il secondo
> dinamometro che integri **riusa le stesse metriche**: non si tocca il dizionario.

#### Passo 2 — La mappatura (l'unica cosa "specifica" del dinamometro)
```
"Peak Force (N)"  +  Muscolo="Estensori ginocchio"   →   metricCode = KNEE_EXT_PEAK_FORCE
"Lato"=Sinistro/Destro                                →   side = LEFT / RIGHT
unità già in Newton                                   →   nessuna conversione
```
Questa mappatura può stare **nel codice** del connettore/parser, oppure — meglio per scalare — in una
**tabella `MetricMapping`** (dato, non codice): `sourceId + externalKey → metricCode + unit + transform`.
Aggiungere un nuovo dispositivo = **aggiungere righe di mappatura**, non scrivere nuove entità.

#### Passo 3 — DOVE finiscono i dati: righe nella tabella `observations` (schema `rehablo_<tenant>`)
| id | patientId | metricCode | value | unit | side | effectiveDateTime | sourceId | provenance | rawFileId |
|---|---|---|---|---|---|---|---|---|---|
| … | Mario | `KNEE_EXT_PEAK_FORCE` | 245.3 | N | LEFT | 2026-07-10 | *Dinamometro X* | IMPORT | file_abc |
| … | Mario | `KNEE_EXT_PEAK_FORCE` | 320.1 | N | RIGHT | 2026-07-10 | *Dinamometro X* | IMPORT | file_abc |
| … | Mario | `KNEE_EXT_LSI` | 76.6 | % | BILATERAL | 2026-07-10 | *(calcolata)* | DERIVED | file_abc |

- La riga **LSI** è **derivata** da Rehablo: `245.3 / 320.1 × 100 = 76,6%` (con `calculationMethod`
  = "weaker/stronger×100"). Questo è già "valore aggiunto Rehablo", non del dispositivo.

#### Riepilogo — dove sta ogni cosa
| Cosa | Dove | Schema |
|---|---|---|
| Definizione metrica (dizionario) | tabella `metric_definitions` | **public** (condivisa da tutti i centri) |
| Le misurazioni del paziente | tabella `observations` | **`rehablo_<tenant>`** (dati del centro) |
| Metadata (device, versione, protocollo, n° prove…) | `measurement_metadata` o JSONB nell'observation | `rehablo_<tenant>` |
| File grezzo originale (CSV/PDF/curva) | object storage (S3/MinIO) + riga `raw_files` | `rehablo_<tenant>` |
| Mappatura campo→metrica | tabella `metric_mappings` (o nel connettore) | **public** |

#### Perché così i dati sono "unificati"
Il dinamometro Kinvent, un dinamometro VALD DynaMo, un handheld o l'inserimento manuale scrivono **tutti**
righe `observations` con lo **stesso `metricCode` e la stessa unità**. Quindi:
- Puoi **confrontare** la forza del quadricipite tra dispositivi diversi e tra centri diversi.
- L'AI e il `RehabloScore` leggono **`KNEE_EXT_PEAK_FORCE`** senza sapere né volersi importare *da quale
  macchina* proviene (lo sa il campo `sourceId`, ma non serve alla logica clinica).
- Cambiare dinamometro domani = cambiare la **mappatura**, non il modello dati.

> **In una frase:** il "modello da creare" è **uno solo e lo crei all'inizio** (`Observation` +
> `MetricDefinition`). Per ogni nuovo dispositivo **non crei modelli**: aggiungi **voci di dizionario**
> (se produce metriche nuove) e una **mappatura**. I dati vivono tutti in `observations`.

### 4.1.3 Chi dichiara "quale dispositivo sto usando" e come si sceglie/cambia la mappatura

> ⚠️ **Onestà tecnica:** nella sezione precedente ho semplificato troppo. Qui il meccanismo vero.
> **La sorgente NON viene mai indovinata: viene sempre DICHIARATA.** E **la mappatura del dinamometro A
> NON funziona per il B** — è corretto così: ogni sorgente ha la **sua** mappatura, e il sistema sceglie
> quale usare **in base al `sourceId` dichiarato**. L'unificazione avviene **a valle** (tutti scrivono in
> `observations`), non a monte.

#### Chi dichiara la sorgente, canale per canale
| Canale | Chi dichiara "sto usando il device X" | Come, in pratica | Dove sta la mappatura | Come si cambia |
|---|---|---|---|---|
| **③ Import file** (dinamometro CSV) | **L'operatore**, nella UI | Sceglie il device da un **menù a tendina** al caricamento → il frontend invia `sourceId` col file | **`import_profiles` / `metric_mappings`** (dato) legati a quel `sourceId` | **Mapping editor** (UI admin), *senza deploy* |
| **② Connettore pull** (VALD…) | **Implicito nel connettore** | Il connettore VALD gira solo sulle connessioni VALD del centro | Nel **codice del connettore** (o tabella) | Modifica codice + deploy |
| **① Ingestion API** (partner) | **La API key** | Ogni chiave è legata a un `ApiClient`/sorgente; il payload arriva già canonico | Lato **partner** (mappano loro) o profilo per-client | Il partner aggiorna il suo lato |
| **④ Manuale** | **Il form** | Il campo del form è già legato al `metricCode` | Il **form** stesso | Config del form |

#### Il passaggio che avevo saltato: la REGISTRAZIONE del dispositivo (una tantum)
Prima di caricare qualsiasi dato, il centro **registra** i propri dispositivi (una volta sola):
`Impostazioni → Dispositivi → Aggiungi`. Questo crea una riga **`DeviceConnection`** nello schema del
centro, che lega un dispositivo fisico a una **sorgente del catalogo** (`DeviceSource`) e quindi a una
**mappatura**.
```
DeviceConnection (schema rehablo_<tenant>)
  id, tenantId, sourceId (FK DeviceSource), label ("Dinamometro sala 2"),
  channel (IMPORT|CONNECTOR|API), credentials (cifrate, solo per CONNECTOR/API),
  importProfileId? (quale mappatura usare), active
```
- Se il device è **già nel catalogo Rehablo** (es. "Kinvent K-Force"), la mappatura **esiste già**: il
  centro deve solo selezionarlo.
- Se è un **CSV sconosciuto**, un admin usa **una volta** il *mapping wizard* per associare le colonne alle
  metriche → crea un `import_profile` riutilizzabile.

#### Il flusso API concreto (il tuo dinamometro che esporta CSV)
```
POST /v1/imports            (multipart/form-data)
  file:      dynamo_export.csv
  sourceId:  "kinvent-kforce"     ← il frontend lo manda PERCHÉ l'utente ha scelto il device dal menù
  patientId: "..."                ← opzionale (altrimenti matching per nome/data nascita)

Backend:
  1. carica ImportProfile/metric_mappings WHERE sourceId = "kinvent-kforce"
  2. il parser legge le colonne SECONDO quella mappatura
  3. per ogni riga → crea una Observation (metricCode, value, unit, side…)
  4. salva il file grezzo (raw_files + object storage)
  5. risponde con { imported: 2, skipped: 0, observationIds: [...] }
```
→ **Rispondendo secco alle tue frasi:** *"come fa a sapere quale sto usando?"* → perché **`sourceId` glielo
dici tu** (l'utente lo seleziona). *"quali dati invierà?"* → li descrive il **profilo di mappatura** di
quel `sourceId`. *"la mappatura di A non va per B"* → **esatto**, e infatti il backend carica la mappatura
**di quel `sourceId`**, non una mappatura universale.

#### Com'è fatta una riga di mappatura (mappatura = DATO, non codice)
| sourceId | externalKey (colonna del file) | filtro | metricCode | unitFrom | unitTo | transform | side |
|---|---|---|---|---|---|---|---|
| `kinvent-kforce` | `Peak Force (N)` | Muscolo=`Estensori ginocchio` | `KNEE_EXT_PEAK_FORCE` | N | N | `x*1` | da colonna `Lato` |
| `biodex-iso` | `PT (ft-lb)` | — | `KNEE_EXT_PEAK_TORQUE` | ft·lb | Nm | `x*1.3558` | da colonna `Side` |

- **Dinamometro A** e **Dinamometro B** hanno **righe di mappatura diverse** (colonne diverse, unità
  diverse), ma **producono le stesse metriche canoniche** in `observations`. Ecco perché a valle i dati
  sono confrontabili anche se a monte i file erano completamente diversi.
- **Cambiare la mappatura** = modificare queste righe dal *mapping editor* (o aggiungerne per un nuovo
  device). Nessun cambiamento al modello dati, nessun deploy per i CSV.

#### Quando serve comunque il codice (non tutto è editabile da UI)
- **Connettori API** (VALD, Hawkin): la logica di autenticazione e paginazione è **codice** (un adapter per
  vendor). La *corrispondenza campo→metrica* può comunque stare in tabella, ma l'adapter va scritto.
- **Formati binari/PDF complessi**: il *parser* è codice; solo la corrispondenza colonna→metrica è dato.
- **CSV/Excel "tabellari"**: mappabili **interamente da UI** col mapping wizard, senza sviluppatore.

> **In sintesi (versione onesta):** sì, **qualcuno deve dichiarare il device** — ed è l'operatore (menù a
> tendina all'upload) o la configurazione della connessione/API key. Sì, **ogni device ha la sua
> mappatura**. La parte "facile" non è integrare *un* device: è che, una volta deciso il modello canonico,
> **aggiungere il device N+1 non tocca il resto del software** — aggiungi una `DeviceSource`, un profilo di
> mappatura e (se serve) un adapter. Il core, l'AI e lo score restano identici.

### 4.1.4 Come si copre il mercato SENZA mappare a mano ogni device (e senza contattare i vendor)

> Preoccupazione legittima: *"non conosciamo tutti i device del mercato; per ognuno dobbiamo farci dare il
> CSV e scrivere una mappatura custom? così Rehablo è vuoto il giorno 1."* Risposta onesta e strategia.

**Verità #1 — per il CSV serve conoscere le colonne, ma NON scrivere codice né contattare il vendor.**
La mappatura si fa **una volta, come DATO, con un wizard visuale**, sul **file reale del cliente** (che il
centro esporta dal proprio device). Il primo centro che ha il "Dinamometro A" lo mappa (o lo mappa un tuo
operatore) trascinando colonna→metrica; il profilo viene **pubblicato** e da lì **vale per tutti i centri**
con quel device. Non serve un developer, non serve un deploy, non serve telefonare al produttore.

**Verità #2 — Rehablo NON è vuoto il giorno 1.** Il canale **manuale funziona per QUALSIASI device da
subito**: l'operatore digita i valori (X Y Z), con i campi guidati dal dizionario. Il valore clinico c'è
dal primo giorno, anche prima di qualsiasi mappatura o API.

**Verità #3 — le API (VALD/Hawkin) richiedono codice per vendor, ma sono pochissime.** Sono la manciata di
"nativi": un connettore per vendor, scritto una volta, riutilizzato da tutti i centri.

**Il flusso di onboarding di un device sconosciuto (self-service):**
```
1. Il centro esporta un CSV dal suo device (Dinamometro A).
2. POST /imports/inspect { csv }         → il wizard mostra le COLONNE reali + anteprima.
3. L'operatore/admin mappa colonna→metrica (trascinando).
4. POST /import-profiles { sourceId, name, definition }   → salva la mappatura come DATO (PUBLISHED).
5. Da ora POST /imports usa quella mappatura. Vale per QUEL device, per TUTTI i centri, per sempre.
```
→ **Domani mattina:** Centro A con Dinamometro A (X Y Z) e Centro B con Dinamometro B (P K W) sono gestiti
**entrambi**: se la mappatura del loro device esiste → import automatico; se non esiste ancora → 5 minuti
di wizard sul loro file (una volta), oppure **manuale** nel frattempo. Nessuno resta senza soluzione.

**Chi popola il catalogo?** Strategia realistica di copertura del mercato, in ordine:
1. **Manuale** per tutti i device (copertura 100% dal giorno 1).
2. **Import wizard** per i device che esportano CSV/Excel: mappati on-demand al primo incontro, poi
   condivisi. Nel tempo si costruisce una **libreria di mappature** che copre l'80% dei device diffusi.
3. **Connettori API** per i "nativi" (VALD, Hawkin, Delsys…): investimento mirato sui pochi che contano.

> In sintesi: la scalabilità NON viene dal "conoscere in anticipo tutti i device", ma dal fatto che
> **mappare un device è un'operazione di configurazione (dato), non di sviluppo (codice)** — fatta una
> volta e condivisa. Questa è la differenza tra un giocattolo e un prodotto.

### 4.2 Perché il modello canonico è non negoziabile
Il core parla **solo** `Observation` + `MetricDefinition`. VALD, Delsys, un CSV o l'inserimento manuale
sono semplici **"provenienze"** (`provenance` + `DeviceSource`). Domani cambi una pedana senza toccare il
resto del software. **L'AI non parla con VALD: parla con il DB Rehablo.**

### 4.3 Le tre categorie "Rehablo Certified Devices" (per il marketing/UX)
- ✅ **Compatibile nativamente** → canali ① o ② (VALD, Hawkin, Kinvent, Delsys).
- 🟡 **Compatibile tramite importazione** → canale ③ (Biodex, Easytech, BTS).
- ⚪ **Compatibile manualmente** → canale ④ (qualsiasi dispositivo).

### 4.4 Nuovi moduli backend da creare
1. **`modules/platform`** (Developer Portal / API pubblica):
   - `ApiClient` (app partner), `ApiCredential` (OAuth2 client / API key, scopes, **tenant-scoped**),
     `Webhook` + `WebhookDelivery`, rate limiting, audit log.
   - Endpoint pubblici versionati `/v1/*` + **OpenAPI/Swagger** + ambiente **Sandbox**.
2. **`modules/devices`** (Integrazioni):
   - `DeviceSource` (catalogo dispositivi/vendor, public), `DeviceConnection` (credenziali vendor per
     tenant), `Connector` framework (adapter VALD/Hawkin/…), `ImportJob` (stato import file),
     `RawFile` (object storage).
3. **`modules/measurements`** (Modello canonico):
   - `MetricDefinition` (public), `Observation` (tenant), `MeasurementMetadata`.
4. **Infrastruttura**:
   - `multer` + object storage (S3/MinIO) per i file grezzi.
   - Scheduler/worker (`node-cron` per iniziare, poi **BullMQ + Redis**) per il pull periodico e gli
     import pesanti.
   - Generazione **OpenAPI** (es. `swagger-jsdoc` + `swagger-ui-express` o `zod-to-openapi`).

---

## 5. Gap sul motore clinico e sull'AI (dopo i dati)

Una volta pronto il modello di misurazione, i tasselli successivi (in ordine):

1. **`ClinicalProfile` / estensione paziente** (area 1): altezza, peso, BMI derivato, arto dominante,
   livello/ruolo sportivo, ore allenamento, obiettivi.
2. **`ClinicalCase` / `Diagnosis`** (area 2): diagnosi, ICD, distretto, data infortunio/intervento, fase
   biologica, controindicazioni, comorbidità, recidive, fattori psicosociali, aspettative.
3. **`Problem` + `Goal`** (problem list + obiettivi misurabili collegati a un `metricCode`, con target,
   scadenza, cadenza rivalutazione).
4. **Upgrade `progressionCriteria` → regole strutturate (JSON)**: da testo libero a criteri valutabili
   (es. `{ metric: "KNEE_EXT_DEFICIT", op: "<", value: 10, unit: "%" }`). È il cuore del **Pathway
   Engine**: confronta i valori reali con i criteri e **propone** (non impone) l'avanzamento.
5. **`Session` (seduta)** contenitore che unisce: sintomi pre/post, esercizi (`ProtocolExerciseLog`
   esistente), **terapia manuale** (`ManualTherapyLog`), **terapie fisiche/strumentali**
   (`PhysicalTherapyLog`: dispositivo, parametri, dose, eventi avversi), risposta, aderenza.
6. **`Reassessment`** + servizio di confronto (iniziale/precedente/attuale/obiettivo + velocità).
7. **`RehabloScore`** service (indice composito configurabile).
8. **Rule Engine (AI Livello 1)**: motore di regole cliniche esplicite, trasparenti e approvate dai
   professionisti → produce **proposte** con motivazione e criteri soddisfatti/non soddisfatti; ogni
   decisione dell'operatore (approva/modifica/rifiuta) va **registrata** (utile per gli step futuri).
9. **AI Livello 2 (assistente generativo)** come **modulo interno `modules/ai`** dello stesso backend
   monolitico (NON un microservizio): *legge il DB Rehablo* (mai i vendor), costruisce il prompt e chiama
   un'API LLM esterna. Produce riassunto cartella, bozza piano, report, dati mancanti. Sempre con
   approvazione umana.
   > **Nota architetturale:** il backend è volutamente un **monolite** (`package.json`: *"monolithic
   > backend - merges all former microservices"*). Quindi l'AI resta **dentro l'unico backend** come
   > modulo, con un **confine interno pulito** (il modulo `ai` orchestra leggendo il DB, non viene
   > chiamato dagli altri moduli). L'unico pezzo che *un domani* potrebbe vivere fuori è il Livello 3–4
   > (modelli predittivi), tipicamente in **Python/ML**: grazie al confine pulito potrà essere estratto
   > senza riscrivere il resto. Regola: **monolite-first**, si separa solo se e quando serve davvero.

> **Nota normativa** (già ben inquadrata nella visione): più il sistema formula raccomandazioni
> individuali diagnostico/terapeutiche, più si avvicina alla qualifica di **Medical Device Software**
> (MDR) e agli obblighi dell'**AI Act** per i sistemi ad alto rischio. → Fase iniziale come **supporto
> decisionale con supervisione umana e regole trasparenti**; qualifica CE/MDR solo nella fase evoluta.
> L'esistente su GDPR/FSE/STS è un ottimo punto di partenza per la governance dati (EHDS).

---

## 6. Roadmap consigliata (mappata sulle fasi della visione)

> ### ✅ Stato implementazione — Slice verticale Fase 0 (fatto)
> Modulo **`src/modules/measurements/`** creato e compilante (`tsc --noEmit` pulito), integrato nel monolite:
> - **`MetricDefinition`** (dizionario, schema `public`) + **seed** ginocchio (8 metriche) al boot.
> - **`Observation`** (modello canonico, schema tenant) con `provenance` MANUAL/IMPORT/DEVICE_API/DERIVED,
>   lato, aggregazione, `metadata` JSONB, `sourceId`, `quality`.
> - **`DeviceSource`** (catalogo dispositivi, schema `public`) + seed reale (Kinvent K-Force, Biodex,
>   VALD DynaMo, dinamometro manuale generico): dichiara `channels` (MANUAL/IMPORT/API_PULL/API_PUSH) e
>   **`producesMetrics`** (quali metriche del dizionario produce → alimenta i CAMPI del form manuale).
> - **`DeviceConnection`** (schema tenant): connessione del centro a un device, con **credenziali del
>   vendor CIFRATE** (AES-256-GCM, mai restituite in chiaro) → è QUI che si salva l'API key del centro.
> - **Imbuto unico di ingestione** (`services/observation.service.ts`): valida contro il dizionario
>   (metrica esistente + unità coerente) e salva. **Tutti i canali passano di qui.**
> - **Motore di mappatura** portato nel modulo (`mapping/`) + registro `kinvent-kforce` / `biodex-iso`.
> - **`ImportProfile`** (mappatura come DATO, schema `public`): le mappature vivono in DB e si creano/
>   modificano da **wizard** senza deploy. Le due di esempio sono seminate da qui. `resolveDeviceMapping`
>   legge dal DB (fallback al codice).
> - **Endpoint** (`routes/measurements.routes.ts`):
>   - `POST /observations` → canale ④ **manuale** · `POST /v1/observations` → canale ① **Ingestion API**
>   - `POST /imports/inspect` → **wizard**: colonne + anteprima del CSV · `POST /imports` → import
>   - `GET/POST /import-profiles` → **mappatura come dato** (il wizard salva qui)
>   - `GET /observations?patientId=…` → lettura
>   - `GET /device-catalog` → catalogo dispositivi · `GET /device-catalog/:sourceId/metrics` → **campi del
>     form manuale** · `POST /device-connections` → salva connessione+credenziali · `GET /device-connections`
>
> **Ancora da fare** (Fase 0/1 residua): upload file con `multer` + object storage (`RawFile`), matching
> paziente automatico, **UI del mapping wizard** (frontend), **connettore pull VALD** (usa le credenziali
> di `DeviceConnection` + scheduler), API key per il canale ① (push).
>
> ### ✅ Frontend — Impostazioni → Dispositivi (fatto)
> In `rehab.io_fe` (`src/app/modules/admin/pages/settings/devices/`): nuovo pannello **Dispositivi** nella
> pagina Impostazioni, con ricerca, vista **card/tabella** e pulsante **Aggiungi dispositivo**. Il
> **wizard** (dialog a step) permette di: (1) definire il device e i canali; (2) scegliere le metriche
> raccolte (campi del manuale); (3) **caricare un CSV di esempio → vedere le colonne reali → mappare
> colonna→metrica** (con colonna data/lato/discriminante e alias del lato) → salva l'`ImportProfile`.
> Consuma `GET /metrics`, `POST /imports/inspect`, `POST /import-profiles`, `GET/POST /device-catalog`.

### Fase 0 — Fondamenta dati (PRIORITÀ ASSOLUTA, abilita tutto il resto)
- [x] `MetricDefinition` (data dictionary) + seed (avviato: ginocchio; obiettivo ~120–150 metriche).
- [x] `Observation` (modello canonico, FHIR-aligned) + `MeasurementMetadata` (come JSONB `metadata`).
- [ ] `RawFile` + upload file (`multer` + object storage) e normalizzazione unità out-of-band.

### Fase 1 — Integrazione dispositivi (la tua domanda)
- [~] `modules/devices`: `DeviceSource` (catalogo) e `DeviceConnection` (credenziali cifrate per tenant) **fatti** nel modulo `measurements`; manca il framework `Connector` (pull).
- [~] **Import CSV/Excel universale** (canale ③) — *fatto per CSV via `POST /imports` (JSON); manca l'upload multipart e l'import Excel*.
- [ ] **1° connettore pull**: VALD (usa le credenziali di `DeviceConnection` + scheduler) → poi Hawkin.
- [~] `modules/platform`: Ingestion API — *base fatta con `POST /v1/observations`; mancano OpenAPI, Sandbox e API key tenant-scoped*.
- [ ] Developer Portal (frontend) con pagina "Rehablo Certified Devices".

### Fase 2 — Motore clinico
- [ ] `ClinicalProfile`, `ClinicalCase/Diagnosis`, `Problem`, `Goal`.
- [ ] Upgrade `progressionCriteria` → **regole JSON valutabili** + Pathway Engine (proposte di avanzamento).
- [ ] `Session` + `ManualTherapyLog` + `PhysicalTherapyLog`, `Reassessment`, `RehabloScore`.
- [ ] Seed PROMs clinici (IKDC, KOOS, ACL-RSI, DASH, SPADI, ODI, NPRS…) nel catalogo scale esistente.

### Fase 3 — AI
- [ ] Rule Engine (Livello 1) con registrazione delle decisioni dell'operatore.
- [ ] Assistente generativo (Livello 2) come **modulo `modules/ai`** nell'unico backend monolitico (legge
      solo il DB Rehablo). *Niente microservizio.*
- [ ] (Solo dopo dati sufficienti) Livelli 3–4: coorti, pulizia, modelli predittivi, learning health
      system. Unico pezzo eventualmente estraibile in futuro (stack Python/ML), se e quando serve.

### Percorso clinico pilota — *pilota ≠ scope della piattaforma*
> ⚠️ **Chiarimento importante:** LCA, spalla e lombalgia **non sono gli unici percorsi supportati**.
> Sono solo i **3 percorsi PILOTA** con cui *validare* il motore clinico. La fisioterapia intera entra
> tutta, per gradi: grazie al modello canonico (Observation + Data Dictionary + ProtocolTemplate/Phase/
> Criteria), **aggiungere un percorso è creare un nuovo template clinico — NON modificare il software**.

Perché proprio questi tre come pilota:
- **Alta frequenza** in uno studio → si raccolgono dati rapidamente.
- **Molto strutturabili** (fasi nette, test oggettivi, criteri di Return to Sport) → ideali per collaudare
  il Pathway Engine e le regole (AI Livello 1).
- Rappresentano **tre macro-famiglie diverse** (post-chirurgico articolare, distretto complesso multi-piano,
  colonna/dolore): se il modello regge su questi, regge su quasi tutto il resto.

### La fisioterapia completa — tassonomia dei percorsi (tutti ospitabili dallo stesso motore)
| Macro-area | Esempi di percorsi |
|---|---|
| Ortopedico post-chirurgico | LCA e altre plastiche legamentose, menisco/cartilagine, **protesi** (anca/ginocchio/spalla), riparazione **cuffia dei rotatori**, instabilità di spalla, fratture, tunnel carpale |
| Tendinopatie | achillea, rotulea, cuffia, **epicondilite/epitrocleite**, gluteo medio |
| Colonna | lombalgia, **cervicalgia**, ernia discale, stenosi, post-chirurgia vertebrale, scoliosi |
| Sportiva / muscolare | lesioni **hamstring**/polpaccio, distorsioni e **instabilità di caviglia**, return to sport, prevenzione infortuni |
| Neurologica | ictus, Parkinson, SM, lesioni midollari, riabilitazione **vestibolare**/equilibrio |
| Reumatologica / degenerativa | **artrosi**, artrite reumatoide, fibromialgia |
| Geriatrica | cadute, fragilità, decondizionamento |
| Cardio-respiratoria | BPCO, riabilitazione cardiaca, post-COVID |
| Uro-ginecologica | **pavimento pelvico**, riabilitazione perineale |
| Altre | pediatrica, post-oncologica/**linfedema**, **dolore cronico**, ATM (temporo-mandibolare), ergonomia/occupazionale |

### Piano di espansione dei contenuti (dopo i 3 pilota)
- **Ondata 1 (validazione motore):** LCA → spalla (cuffia/instabilità) → lombalgia.
- **Ondata 2 (ortopedia ad alto volume):** protesi anca/ginocchio, caviglia, tendinopatie principali,
  cervicalgia.
- **Ondata 3 (allargamento):** neuro-riabilitazione, geriatrica/cadute, reumatologica.
- **Ondata 4 (specialistica):** pavimento pelvico, cardio-respiratoria, oncologica/linfedema, pediatrica.

> Ogni ondata **non richiede nuovo codice del core**: aggiunge template di percorso, criteri, metriche
> del dizionario e voci di libreria esercizi/interventi. Il software resta lo stesso.

---

## 7. Risposta diretta alle tue due domande

1. **"Quante cose mancano rispetto a oggi?"**
   Le **fondamenta gestionali e cliniche di base ci sono** (paziente, valutazioni, ROM, forza manuale,
   sintomi, test, PROMs, scheletro protocolli/fasi, agenda, fatturazione, consensi). Mancano i **3 blocchi
   pesanti**: (a) modello di misurazione unificato + metadata + data dictionary; (b) dati strumentali
   (forza device, performance, movimento, EMG) e logging terapie; (c) layer di integrazione + motore a
   regole + AI. In termini di sforzo, la parte "Rehablo OS" vera e propria è **la maggioranza del lavoro
   ancora da fare**, ma su fondamenta solide.

2. **"Meglio fare le nostre API con un developer center?"**
   **Sì, ma non da solo.** Le tue API + Developer Portal sono la **strategia di lungo periodo giusta**
   (canale ①). Per essere operativi da subito servono **anche** i connettori "pull" verso i vendor
   esistenti (canale ②), l'import file (③) e il manuale (④). Il punto architetturale che rende tutto
   coerente è **il modello canonico Rehablo (Observation + Data Dictionary)**: costruito quello, ogni
   canale diventa solo un "adattatore" e il resto del software (incluse le AI) non cambia mai.


