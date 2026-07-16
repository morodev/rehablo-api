# Rehablo OS — Piano di Implementazione

> Deriva da `docs/REHABLO_OS_GAP_ANALYSIS.md` (§6 Roadmap). Copre Fase 0 (residua), Fase 1, Fase 2, Fase 3.
> Ogni funzionalità è una **slice verticale completa e autonoma**: modello dati (se serve) + servizio +
> endpoint + **procedura di test manuale** con criteri di accettazione. Nessuna funzionalità va lasciata
> a metà: se non è completabile subito, è marcata `⏸ BLOCCATA` con la ragione esplicita, e le funzionalità
> successive che non dipendono da essa procedono comunque.
>
> **Strategia di test**: non ci sono test automatici nel progetto (`package.json` → `"test": "echo ... exit 1"`).
> Ogni feature è verificata **manualmente** (curl/Postman + verifica DB) secondo i criteri di accettazione
> elencati. Convenzioni comuni in fondo alla sezione "Come testare".

---

## 0. Decisioni di dominio (prese in fase di pianificazione)

| Tema | Decisione |
|---|---|
| Scope piano | Tutte le fasi (0 residua, 1, 2, 3) |
| Testing | Manuale (nessun framework automatico introdotto) |
| Storage RawFile | Filesystem locale dietro interfaccia `StorageAdapter` (swappabile con S3/MinIO in futuro senza toccare il resto) |
| Connettore VALD | Nessuna credenziale reale disponibile ora → adapter con client HTTP iniettabile, testato con fixture/mock; l'attivazione con credenziali reali è un task separato successivo, fuori da questo piano |
| Auth Ingestion API (canale ①) | API key semplice (hash in DB, header `X-Api-Key`), niente OAuth2 in questa iterazione |
| Scheduler pull | `node-cron` in-process (no Redis/BullMQ) |
| Diagnosi ICD | Campo `icdCode` validato in formato, con catalogo **parziale** seedato solo per i 3 percorsi pilota (LCA, spalla, lombalgia) |
| Session (Fase 2) | **Non** si crea una nuova entità: si riusa/estende `Evaluation` esistente come contenitore di seduta |
| PROMs da seedare | Lista completa citata nel documento (IKDC, KOOS, Lysholm, ACL-RSI, DASH, SPADI, ODI, Roland-Morris, NPRS, VAS, PSFS, EQ-5D) |
| AI Livello 2 provider | Nessun provider concreto scelto ora → si pianifica solo l'interfaccia astratta `LlmProvider` + un `MockLlmProvider` per test offline |
| RehabloScore formula | **⏸ In sospeso**: la formula clinica reale va validata con i fisioterapisti. Si costruisce comunque l'architettura completa e testabile con una formula PLACEHOLDER chiaramente etichettata come non-clinicamente-validata |
| Rule Engine (criteri/regole cliniche) | **⏸ In sospeso** sulla libreria: l'utente non è sicuro esistano librerie mature adatte. **Raccomandazione**: costruire un evaluator custom minimale (operatori `<,<=,>,>=,==,!=`, `AND`/`OR`, contro `metricCode`), perché i criteri sono già dati JSON e la trasparenza è richiesta per audit MDR/AI Act. Alternativa valutabile: [`json-rules-engine`](https://www.npmjs.com/package/json-rules-engine) (npm, MIT, supporta esattamente questo pattern fact→condition→event). **Per non bloccare il piano**: la Fase 2 (F2.4, criteri di avanzamento fase) usa da subito un mini-evaluator custom **completo e autonomo** (scope ridotto: singola metrica vs soglia + AND/OR). La Fase 3 (F3.1, motore di regole cliniche generali) ha un **checkpoint esplicito** prima di iniziare per confermare se riusare/estendere quell'evaluator o adottare `json-rules-engine`. |

---

## Come testare (convenzioni comuni)

1. Avviare il backend: `npm run dev` (porta da `.env`/`env.ts`, default espone tutte le route senza prefisso `/api`).
2. Ottenere un token: `POST /auth/login` con credenziali di un utente/tenant di test → `Authorization: Bearer <token>` per tutte le richieste successive.
3. Le richieste tenant-scoped passano dal middleware `resolveTenantSchema`: nessun header aggiuntivo richiesto oltre al Bearer (il tenant si ricava dall'utente autenticato).
4. Per ogni feature: eseguire i passi in "Test manuale", verificare la risposta HTTP indicata **e** lo stato in DB dove specificato (query diretta o endpoint di lettura già esistente).
5. Una feature è "fatta" solo se **tutti** i criteri di accettazione sono verificati; altrimenti resta aperta (non si passa alla successiva funzionalità dipendente).

---

## FASE 0 — Fondamenta dati (residua)

### F0.1 — `RawFile` + `StorageAdapter` locale ✅ FATTO (verificato manualmente il 2026-07-16)
**Obiettivo**: conservare il file grezzo originale (CSV/Excel/PDF) di ogni import, con hash/checksum, dietro un'interfaccia storage astratta.

**Da costruire**
- `src/modules/measurements/storage/storageAdapter.ts`: interfaccia `StorageAdapter { save(buffer, meta): Promise<{storagePath, checksumSha256}>; read(storagePath): Promise<Buffer>; }`.
- `src/modules/measurements/storage/localStorageAdapter.ts`: implementazione su filesystem, directory da env `RAW_FILE_STORAGE_DIR` (default `./storage/raw-files`), organizzata per `tenantId/yyyy/mm/`.
- `src/modules/measurements/models/rawFile.model.ts` (schema tenant): `id, tenantId, originalName, mimeType, sizeBytes, checksumSha256, storagePath, uploadedBy, uploadedAt`.
- Registrare `RawFile` in `tenantModelsRegistry.ts`.
- Endpoint: `POST /raw-files` (multipart, campo `file`) → salva su storage + riga DB → risponde `{ id, checksumSha256, sizeBytes }`.
- `GET /raw-files/:id/download` → stream del file (verifica autorizzazione tenant).

**Dipendenza nuova**: `multer` (+ `@types/multer`) da aggiungere a `package.json`.

**Test manuale**
1. `POST /raw-files` con un CSV di esempio (multipart/form-data, campo `file`).
2. Verificare risposta `201` con `id` e `checksumSha256`.
3. Verificare che il file esista fisicamente in `RAW_FILE_STORAGE_DIR/<tenantId>/...`.
4. `GET /raw-files/:id/download` → il contenuto scaricato deve avere lo stesso hash SHA-256 del file originale.
5. Provare un upload > limite dimensione configurato (es. 20MB) → deve rispondere `413`/`400` esplicito, non un crash.

**Criteri di accettazione**
- [x] File salvato su disco e riga `raw_files` coerente (dimensione, hash).
- [x] Download restituisce byte identici all'originale.
- [x] Errore gestito per file troppo grande/mimetype non atteso.

> **Nota implementativa**: `POST /raw-files` e `GET /raw-files/:id/download` sono generici e riutilizzabili
> da qualunque canale futuro (import CSV/Excel, connettori, ecc.), non solo dall'import. `multer` è stato
> installato in versione `^2.2.0` (non `1.x`, impattata da diverse CVE DoS). Verificato manualmente con
> upload/download CSV (hash SHA-256 coincidente), upload senza campo `file` (400), download di un id
> inesistente (404) e upload oltre il limite di 20MB (413 `LIMIT_FILE_SIZE`, nessun residuo su disco/DB).

---

### F0.2 — Import CSV via upload multipart (agganciato a `RawFile`)
**Obiettivo**: sostituire/estendere l'attuale `POST /imports` (JSON con `csv` come stringa) con una variante multipart che allega anche il `RawFile`, mantenendo la retrocompatibilità JSON.

**Da costruire**
- Estendere `import.controller.ts#importCsv`: se la richiesta è `multipart/form-data` con campo `file`, leggere il buffer, salvarlo come `RawFile` (via F0.1), poi procedere come oggi (parsing testo CSV dal buffer invece che da `req.body.csv`).
- Propagare `rawFileId` in ogni `ObservationInput` generato, cosi le `Observation` risultanti referenziano il file sorgente.
- Mantenere il path JSON esistente (`{ sourceId, patientId, csv }`) per non rompere l'integrazione frontend attuale.

**Test manuale**
1. Ripetere il test esistente di import CSV via JSON (`{sourceId, patientId, csv}`) → deve continuare a funzionare identico (non-regressione).
2. Eseguire lo stesso import ma come multipart (`sourceId`, `patientId` come campi form + `file` come file CSV).
3. `GET /observations?patientId=...` → le Observation create devono avere `rawFileId` valorizzato (verificare via query diretta o estendendo la risposta se non già presente).
4. `GET /raw-files/:id/download` con l'id referenziato dalle Observation → deve restituire lo stesso CSV caricato.

**Criteri di accettazione**
- [ ] Import JSON esistente non-regredito.
- [ ] Import multipart funzionante e produce le stesse Observation dell'equivalente JSON.
- [ ] `rawFileId` popolato e scaricabile.

---

## FASE 1 — Integrazione dispositivi

### F1.1 — Framework `Connector` (interfaccia pull) + registry
**Obiettivo**: definire il contratto comune per i connettori "pull" (canale ②), senza ancora un vendor reale collegato.

**Da costruire**
- `src/modules/measurements/connectors/connector.types.ts`: `interface Connector { sourceId: string; pull(connection: DeviceConnection, since?: Date): Promise<ObservationInput[]>; }`.
- `src/modules/measurements/connectors/connectorRegistry.ts`: mappa `sourceId → Connector`, con `registerConnector()` / `getConnector(sourceId)`.
- `src/modules/measurements/connectors/httpClient.ts`: wrapper HTTP iniettabile (per permettere mock nei test manuali, es. puntando a `http://localhost:PORT/__mock-vald` durante i test).

**Test manuale**
1. Scrivere un connettore di prova banale (`echo-connector`, non spedito in produzione) che ritorna 1 osservazione fissa, registrarlo nel registry.
2. Da un piccolo script (`tsx` one-off o endpoint di debug temporaneo) invocare `getConnector('echo-connector').pull(fakeConnection)` → verificare che ritorni l'array atteso.
3. Rimuovere il connettore di prova prima di considerare la feature chiusa (serve solo a validare il framework).

**Criteri di accettazione**
- [ ] Registrare/recuperare un connettore per `sourceId` funziona.
- [ ] Il contratto `pull()` è rispettato (Promise di `ObservationInput[]`).

---

### F1.2 — Connettore VALD (mock/testabile senza credenziali reali) + scheduler
**Obiettivo**: primo connettore reale, ma con client HTTP mockato (⏸ integrazione con VALD vera rimandata a quando saranno disponibili credenziali sandbox — task separato fuori da questo piano).

**Da costruire**
- `src/modules/measurements/connectors/vald.connector.ts`: implementa `Connector`, usa `httpClient` iniettato; mappa la struttura di risposta VALD (ForceDecks: CMJ height, Peak Force, RSI, asimmetria) su `metricCode` del dizionario (nuove `MetricDefinition` se non esistenti: `CMJ_HEIGHT`, `RSI`, ecc. — vedi F1.2b).
- `src/modules/measurements/connectors/vald.fixtures.ts`: risposta JSON di esempio (fixture) usata da un `MockHttpClient` per i test manuali offline.
- `src/modules/measurements/scheduler/pullScheduler.ts`: `node-cron` job che, per ogni `DeviceConnection` con `channel = 'API_PULL'` e `active = true`, invoca il connettore corrispondente e ingerisce il risultato tramite `ingestObservations`. Endpoint `POST /device-connections/:id/sync-now` per trigger manuale (senza aspettare il cron) — indispensabile per i test.
- Aggiungere `lastSyncAt` update dopo ogni pull riuscito (campo già presente su `DeviceConnection`).

**F1.2b — Nuove `MetricDefinition` neuromuscolari minime**: seed di `CMJ_HEIGHT` (cm), `CMJ_PEAK_FORCE` (N), `RSI` (ratio), categoria `NEUROMUSCULAR`, così il connettore ha un dizionario target.

**Test manuale**
1. Creare una `DeviceConnection` con `sourceId: 'vald-forcedecks'`, `channel: 'API_PULL'`, `config` con un flag `useMock: true`.
2. `POST /device-connections/:id/sync-now` → deve rispondere con `{ imported: N, skipped: 0 }` usando la fixture.
3. `GET /observations?patientId=...` → verificare presenza delle nuove Observation con `provenance: 'DEVICE_API'`, `sourceId: 'vald-forcedecks'`.
4. Verificare `lastSyncAt` aggiornato sulla `DeviceConnection` (`GET /device-connections`).
5. Rilanciare `sync-now` una seconda volta con lo stesso `since` → verificare che non duplichi le stesse osservazioni (idempotenza: da garantire con una chiave naturale, es. `sourceId + externalTestId` in `metadata`, controllata prima dell'insert).

**Criteri di accettazione**
- [ ] Sync manuale funzionante con fixture mock.
- [ ] Observation create correttamente categorizzate.
- [ ] `lastSyncAt` aggiornato.
- [ ] Nessuna duplicazione al secondo sync.
- ⏸ Integrazione con account VALD reale: **non in scope**, richiede credenziali — task di follow-up esplicito quando disponibili.

---

### F1.3 — Import Excel (`.xlsx`) oltre a CSV
**Obiettivo**: estendere il canale ③ ai file Excel (Biodex/Easytech spesso esportano `.xlsx`).

**Da costruire**
- Dipendenza nuova: `xlsx` (SheetJS) o `exceljs`.
- `src/modules/measurements/mapping/excelParser.ts`: converte il primo foglio di un `.xlsx` in righe equivalenti al parser CSV esistente (stesso formato intermedio, così `applyMapping` non cambia).
- Estendere `POST /imports/inspect` e `POST /imports` per accettare anche `.xlsx` (rilevato da mimetype/estensione), riusando la stessa `ImportProfile`/mappatura per `sourceId`.

**Test manuale**
1. Preparare un file `.xlsx` con le stesse colonne di un CSV già mappato (es. `biodex-iso`).
2. `POST /imports/inspect` (multipart) → deve restituire le stesse colonne/anteprima ottenute dal CSV equivalente.
3. `POST /imports` con lo stesso file → deve produrre le stesse Observation dell'equivalente CSV.

**Criteri di accettazione**
- [ ] Inspect funziona su `.xlsx`.
- [ ] Import produce risultati identici (a parità di dati) all'equivalente CSV.

---

### F1.4 — Ingestion API pubblica con API Key tenant-scoped (canale ①)
**Obiettivo**: rendere `POST /v1/observations` (già esistente) autenticabile da un partner esterno via API key, invece di richiedere il JWT interno.

**Da costruire**
- `src/modules/platform/` (nuovo modulo): `ApiClient` (schema public: `id, name, tenantId`), `ApiCredential` (schema public o tenant? → **tenant-scoped**, dato che la key dà accesso ai dati di un centro specifico: `id, tenantId, apiClientId, keyHash, scopes[], active, createdAt, lastUsedAt`).
- Generazione: `POST /api-credentials` (autenticato con JWT interno admin) → ritorna la **chiave in chiaro una sola volta** + il suo hash salvato in DB (mai restituita di nuovo).
- Middleware `apiKeyAuth.ts`: legge header `X-Api-Key`, calcola hash, cerca `ApiCredential` attiva, risolve `tenantId` e lo inietta come se fosse `resolveTenantSchema` (stesso contratto `req.tenantSchema`/`req.tenantId`).
- `POST /v1/observations` passa da `requireAuth` (JWT) a `apiKeyAuth` (nuovo router dedicato `/v1/*` separato da quello autenticato con JWT).

**Test manuale**
1. Con un JWT admin: `POST /api-credentials` → salvare la chiave in chiaro ricevuta (non più recuperabile).
2. `POST /v1/observations` con header `X-Api-Key: <chiave>` e payload canonico → deve rispondere `201` e creare l'Observation nel tenant corretto.
3. Stessa richiesta con chiave errata/revocata → `401`.
4. Disattivare la credenziale (`active: false`) → richiesta successiva → `401`.
5. Verificare `lastUsedAt` aggiornato dopo una chiamata riuscita.

**Criteri di accettazione**
- [ ] Generazione chiave one-time-view.
- [ ] Auth via API key funzionante e tenant-scoped corretto (i dati finiscono nel tenant giusto, non in un altro).
- [ ] Revoca/disattivazione blocca l'accesso.

---

### F1.5 — Rate limiting + audit log sull'Ingestion API
**Obiettivo**: proteggere `/v1/*` da abuso e tracciare ogni chiamata partner.

**Da costruire**
- Dipendenza nuova: `express-rate-limit`.
- Rate limit per `ApiCredential` (non per IP): chiave di bucket = `apiClientId`. Limite configurabile via env (default es. 120 req/min).
- `ApiCallLog` (schema tenant): `id, apiCredentialId, method, path, statusCode, createdAt` — scritto da un middleware dopo la response.

**Test manuale**
1. Superare il rate limit con richieste ripetute rapide → verificare risposta `429` con header `Retry-After`.
2. `GET /api-credentials/:id/logs` (nuovo endpoint semplice) → verificare che ogni chiamata precedente (comprese quelle in `401`/`429`) sia loggata.

**Criteri di accettazione**
- [ ] 429 restituito oltre soglia.
- [ ] Log presente e consultabile per ogni chiamata.

---

### F1.6 — OpenAPI/Swagger + Sandbox
**Obiettivo**: documentazione pubblica navigabile delle route `/v1/*`.

**Da costruire**
- Dipendenze nuove: `swagger-jsdoc`, `swagger-ui-express` (+ types).
- Annotazioni JSDoc sopra le route `/v1/observations` (request/response schema, esempio).
- `GET /docs` → Swagger UI; `GET /docs.json` → spec grezza.
- "Sandbox": un tenant demo pre-seedato (flag `isSandbox: true` sul Tenant) i cui dati sono isolati e resettabili via `POST /sandbox/reset` (cancella e ri-seeda le Observation demo).

**Test manuale**
1. Aprire `GET /docs` nel browser → la pagina Swagger UI carica e mostra `POST /v1/observations` con schema.
2. Da Swagger UI, eseguire una chiamata "Try it out" con una API key sandbox → deve funzionare end-to-end.
3. `POST /sandbox/reset` → verificare che i dati demo tornino allo stato iniziale.

**Criteri di accettazione**
- [ ] Swagger UI raggiungibile e accurata.
- [ ] Sandbox isolata e resettabile.

---

### F1.7 — Developer Portal frontend minimo (repo `rehab.io_fe`)
**Obiettivo**: UI per generare/revocare API key e consultare i log, oltre al pannello Dispositivi già esistente.

**Da costruire** (in `rehab.io_fe`, area Impostazioni)
- Pagina "Sviluppatori/API": lista credenziali (nome, stato, ultimo uso), pulsante "Genera nuova chiave" (mostra la chiave in chiaro una sola volta in un dialog con avviso "copiala ora"), pulsante "Revoca".
- Consuma `POST /api-credentials`, `GET /api-credentials`, `PATCH /api-credentials/:id` (revoca), `GET /api-credentials/:id/logs` (F1.4/F1.5 lato BE).

**Test manuale**
1. Da UI, generare una chiave → verificare che compaia il dialog con la chiave in chiaro e non sia più recuperabile dopo la chiusura.
2. Revocare dalla UI → verificare che una chiamata `curl` con quella chiave torni `401`.
3. Consultare i log dalla UI → devono corrispondere a quanto visto in F1.5 via API diretta.

**Criteri di accettazione**
- [ ] Flusso genera/copia/revoca completo da UI.
- [ ] Coerenza tra stato UI e stato reale via API.

---

## FASE 2 — Motore clinico

### F2.1 — `ClinicalProfile` (estensione anagrafica)
**Obiettivo**: dati strutturati oggi assenti su `Patient` (area 1 del gap analysis).

**Da costruire**
- `src/modules/patients/models/clinicalProfile.model.ts` (schema tenant, 1:1 con `Patient`): `patientId, heightCm, weightKg, dominantSide (LEFT|RIGHT), sportLevel (AMATEUR|SEMI_PRO|PRO), sportRole?, trainingHoursPerWeek?, patientGoals?: string`.
- `bmi` **derivato** (calcolato, non salvato): `weightKg / (heightCm/100)^2`, esposto in lettura.
- Endpoint: `GET /patients/:id/clinical-profile`, `PUT /patients/:id/clinical-profile` (upsert).

**Test manuale**
1. `PUT /patients/:id/clinical-profile` con `heightCm: 180, weightKg: 75, dominantSide: 'RIGHT'`.
2. `GET /patients/:id/clinical-profile` → verificare i valori salvati **e** `bmi` calcolato correttamente (≈23.15).
3. Aggiornare solo `weightKg` → verificare che gli altri campi non vengano azzerati (upsert parziale).

**Criteri di accettazione**
- [ ] CRUD funzionante, 1:1 con paziente.
- [ ] BMI calcolato correttamente e coerente dopo update parziale.

---

### F2.2 — `Diagnosis`/`ClinicalCase` + catalogo ICD-10 parziale (pilota)
**Obiettivo**: dati clinici/diagnosi oggi completamente assenti (area 2).

**Da costruire**
- `src/modules/patients/models/catalog/icdCode.model.ts` (schema public): `code (PK, es. "S83.5"), displayName, applicablePilot ('ACL'|'SHOULDER'|'LOW_BACK')`. Seed **solo** con i codici dei 3 percorsi pilota (es. LCA: `S83.5`; cuffia dei rotatori: `M75.1`; lombalgia: `M54.5` — elenco indicativo da confermare con un fisioterapista/medico se serve maggiore precisione clinica).
- `src/modules/patients/models/clinicalCase.model.ts` (schema tenant): `id, patientId, icdCode (FK logica a catalogo), district, injuryDate?, surgeryDate?, biologicalPhase?, contraindications?: string[], comorbidities?: string[], notes?`.
- Endpoint: `GET/POST /patients/:id/clinical-cases`, `PATCH /clinical-cases/:id`.
- `GET /icd-codes` (catalogo, filtrabile per `applicablePilot`).

**Test manuale**
1. `GET /icd-codes?applicablePilot=ACL` → deve tornare almeno il codice LCA seedato.
2. `POST /patients/:id/clinical-cases` con `icdCode` valido → `201`.
3. `POST` con `icdCode` inesistente nel catalogo → `400` esplicito (validazione contro il catalogo).
4. `GET /patients/:id/clinical-cases` → il caso creato è presente con tutti i campi.

**Criteri di accettazione**
- [ ] Catalogo pilota seedato e filtrabile.
- [ ] CRUD `ClinicalCase` funzionante e validato contro il catalogo.

---

### F2.3 — `Problem` + `Goal` (collegati a `metricCode`)
**Obiettivo**: problem list ordinata + obiettivi misurabili (gap Pathway Engine).

**Da costruire**
- `src/modules/protocols/models/problem.model.ts` (tenant): `id, patientId, clinicalCaseId?, description, priority (1..N), status (ACTIVE|RESOLVED), createdAt`.
- `src/modules/protocols/models/goal.model.ts` (tenant): `id, problemId, metricCode (FK logica a MetricDefinition), targetValue, targetSide?, dueDate?, reassessmentFrequencyDays, status (PENDING|ACHIEVED|MISSED)`.
- Endpoint: `POST/GET /problems`, `PATCH /problems/:id`, `POST/GET /problems/:id/goals`, `PATCH /goals/:id`.

**Test manuale**
1. Creare un `Problem` (es. "Deficit di forza quadricipite") collegato a un `ClinicalCase`.
2. Creare un `Goal` sotto quel problem con `metricCode: 'KNEE_EXT_LSI', targetValue: 90, dueDate: +60gg`.
3. `GET /problems/:id/goals` → il goal è presente con `status: 'PENDING'`.
4. `PATCH /goals/:id` con `status: 'ACHIEVED'` → verificare persistenza.

**Criteri di accettazione**
- [ ] Problem list ordinabile per priorità.
- [ ] Goal collegato a un `metricCode` reale del dizionario (validare che il `metricCode` esista, altrimenti `400`).

---

### F2.4 — `progressionCriteria` strutturato + mini-evaluator + proposta di avanzamento fase
**Obiettivo**: sostituire il testo libero con regole JSON valutabili contro le `Observation` reali del paziente (Pathway Engine, versione "proposta").

**Da costruire**
- Migrare `ProtocolPhaseTemplate.progressionCriteria` da `TEXT` a `JSONB`, formato:
  ```json
  { "op": "AND", "conditions": [
      { "metricCode": "KNEE_EXT_LSI", "operator": ">=", "value": 90 },
      { "metricCode": "PAIN_NPRS", "operator": "<=", "value": 2 }
  ]}
  ```
- `src/modules/protocols/services/criteriaEvaluator.ts`: funzione pura `evaluate(criteria, latestObservationsByMetric): { satisfied: boolean, details: Array<{metricCode, expected, actual, satisfied}> }`. **Nessuna libreria esterna** (mini-evaluator custom, scope volutamente limitato: confronto singola metrica + AND/OR a un livello, senza nesting profondo — sufficiente per i criteri di fase).
- Endpoint: `GET /protocol-instances/:id/phases/:phaseId/progression-check` → carica le ultime Observation del paziente per ogni `metricCode` citato nei criteri, valuta, e ritorna `{ satisfied, details }` **senza avanzare automaticamente la fase** (è una proposta, l'operatore conferma da UI esistente su `ProtocolPhaseInstance.status`).

**Test manuale**
1. Impostare `progressionCriteria` su una `ProtocolPhaseTemplate` di test col JSON sopra.
2. Creare Observation per il paziente: `KNEE_EXT_LSI = 92`, `PAIN_NPRS = 1`.
3. `GET /.../progression-check` → `satisfied: true`, `details` mostra entrambe le condizioni soddisfatte.
4. Cambiare `PAIN_NPRS = 4` → ripetere → `satisfied: false`, il dettaglio indica quale condizione fallisce.
5. Chiedere il check per un `metricCode` senza nessuna Observation registrata → deve rispondere `satisfied: false` con motivo esplicito "dato mancante", non un errore 500.

**Criteri di accettazione**
- [ ] Criteri salvabili come JSON e retrocompatibili (migrazione dal testo libero, anche solo svuotando i valori esistenti con nota di migrazione manuale se necessario).
- [ ] Evaluator corretto sui casi soddisfatto/non-soddisfatto/dato-mancante.
- [ ] Nessun avanzamento automatico: resta una proposta.

---

### F2.5 — Estensione `Evaluation` come contenitore di seduta + log terapie
**Obiettivo**: unire sintomi pre/post + esercizi + terapie sotto lo stesso `evaluationId` (decisione: riuso di `Evaluation`, non nuova entità).

**Da costruire**
- Estendere `Evaluation`: aggiungere `painLevelPre?: number (0-10)`, `painLevelPost?: number (0-10)`, `sessionType ('ASSESSMENT'|'TREATMENT')` (default `'ASSESSMENT'` per non-regredire l'uso attuale).
- `src/modules/protocols/models/manualTherapyLog.model.ts` (tenant): `id, evaluationId, technique, district, side, dose?, patientResponse?, notes`.
- `src/modules/protocols/models/physicalTherapyLog.model.ts` (tenant): `id, evaluationId, deviceLabel, parameters: JSONB (intensità, durata, frequenza...), adverseEvents?: string`.
- Endpoint: `POST/GET /evaluations/:id/manual-therapy-logs`, `POST/GET /evaluations/:id/physical-therapy-logs`.
- `ProtocolExerciseLog` esistente: verificare/aggiungere collegamento opzionale a `evaluationId` (se non già presente) così una seduta di trattamento aggrega anche il diario esercizi del giorno.

**Test manuale**
1. Creare una `Evaluation` con `sessionType: 'TREATMENT'`, `painLevelPre: 6`.
2. Aggiungere un `ManualTherapyLog` e un `PhysicalTherapyLog` a quella evaluation.
3. Aggiornare `painLevelPost: 3` sulla stessa evaluation.
4. `GET /evaluations/:id` (esteso) → deve ritornare pre/post + riferimenti ai log collegati (o endpoint aggregato `GET /evaluations/:id/session-summary`).

**Criteri di accettazione**
- [ ] `Evaluation` esistente non-regredita (i flussi di valutazione classica continuano a funzionare con `sessionType` default).
- [ ] Log manuali/fisici collegati e recuperabili per `evaluationId`.

---

### F2.6 — Servizio di rivalutazione (`Reassessment` comparison)
**Obiettivo**: confronto iniziale/precedente/attuale/obiettivo + velocità di miglioramento.

**Da costruire**
- `src/modules/measurements/services/reassessment.service.ts`: `compare(patientId, metricCode): { baseline, previous, current, goal?, deltaFromBaseline, deltaFromPrevious, trendPerWeek }`, basato su query ordinate per `effectiveDateTime` su `Observation` + `Goal` collegato (se esiste, da F2.3).
- Endpoint: `GET /patients/:id/reassessment?metricCode=...`.

**Test manuale**
1. Inserire 3 Observation nel tempo per lo stesso `metricCode` (baseline, intermedia, attuale) + un `Goal` con target.
2. `GET /patients/:id/reassessment?metricCode=...` → verificare che `baseline`/`previous`/`current` corrispondano ai 3 valori nell'ordine cronologico corretto e che `deltaFromBaseline`/`trendPerWeek` siano calcolati correttamente (verificabile a mano con una calcolatrice).
3. Chiamare con un `metricCode` senza storico → risposta esplicita "nessun dato", non errore.

**Criteri di accettazione**
- [ ] Calcoli numerici verificati a mano su un caso di test.
- [ ] Gestione corretta del caso "nessun dato".

---

### F2.7 — `RehabloScore` (architettura pluggable + formula placeholder)
**Obiettivo**: indice composito, con **formula reale in sospeso** (da validare coi fisioterapisti). Si consegna un'architettura completa e testabile, non la validità clinica.

**Da costruire**
- `src/modules/measurements/models/catalog/scoreDefinition.model.ts` (schema public): `id, code, displayName, components: JSONB` (lista di `{ metricCode, weight, normalization }`), `active`. Nessun peso reale precompilato: si seeda **una sola** definizione demo (`code: 'DEMO_SCORE'`) chiaramente marcata `⚠️ PLACEHOLDER — non validata clinicamente` in `displayName`.
- `src/modules/measurements/services/rehabloScore.service.ts`: normalizza ogni componente su scala 0-100 (usando `physiologicalRange`/`higherIsBetter` da `MetricDefinition`), applica i pesi, somma → punteggio totale + breakdown per componente.
- Endpoint: `GET /patients/:id/rehablo-score?scoreCode=DEMO_SCORE`.

**Test manuale**
1. Popolare Observation per i `metricCode` citati nella `DEMO_SCORE`.
2. `GET /patients/:id/rehablo-score?scoreCode=DEMO_SCORE` → verificare che il breakdown mostri ogni componente normalizzato + il totale pesato, ricalcolabile a mano.
3. Rimuovere/alterare un peso in `ScoreDefinition.components` (via un futuro CRUD o direttamente in DB per il test) → il ricalcolo riflette il cambiamento senza deploy.

**Criteri di accettazione**
- [ ] Architettura pluggable verificata (cambiare pesi cambia il risultato senza modifiche al codice).
- [ ] Etichettatura "placeholder non-validato" visibile in risposta API (campo `disclaimer` esplicito).
- ⏸ **Formula clinica reale**: da definire con i fisioterapisti — task di follow-up separato, non blocca la chiusura di questa feature architetturale.

---

### F2.8 — Seed PROMs completi
**Obiettivo**: popolare il catalogo `Scale` esistente con tutti i PROMs citati nel documento.

**Da costruire**
- Seed data (analogo a `seedCatalogData()` già esistente in `human-body/models/catalog`) per: IKDC, KOOS, Lysholm, ACL-RSI, DASH, SPADI, ODI, Roland-Morris, NPRS, VAS, PSFS, EQ-5D — ciascuno con le proprie domande/scoring in formato compatibile col modello `Scale`/`interpretazione JSON` già esistente.
- ⚠️ **Nota legale non bloccante**: alcuni PROMs standardizzati richiedono licenza d'uso commerciale (es. permessi degli autori/copyright per KOOS, DASH, ecc.). Il seed tecnico procede comunque; la verifica dei diritti d'uso è responsabilità del prodotto/legale, da tracciare come task separato prima del go-live commerciale (non blocca lo sviluppo/test).

**Test manuale**
1. Avviare il backend → verificare nei log che il seed non generi errori.
2. `GET /scales` (endpoint catalogo esistente) → tutti e 12 i PROMs elencati devono comparire.
3. Compilare un'istanza (`UserScaleInstance`/`UserAnswer`, flusso già esistente) per almeno 2 PROMs diversi (es. uno a punteggio semplice tipo NPRS, uno a domande multiple tipo KOOS) → verificare che lo scoring calcolato sia coerente con l'algoritmo dichiarato per quella scala.

**Criteri di accettazione**
- [ ] Tutti i 12 PROMs presenti nel catalogo.
- [ ] Scoring corretto testato su almeno 2 scale rappresentative delle due tipologie (score singolo vs questionario a items).

---

### F2.9 — Piano settimanale generato dalla fase (proiezione read-only)
**Obiettivo**: colmare il gap "piano settimanale assente" senza reinventare il modello (usa dati già presenti su `ProtocolTemplateExercise`).

**Da costruire**
- `src/modules/protocols/services/weeklyPlan.service.ts`: dato un `ProtocolInstance` + fase attiva, distribuisce gli esercizi della fase sui giorni della settimana in base a `weeklyFrequency`/`sets`/`reps` già esistenti su `ProtocolTemplateExercise` (algoritmo semplice round-robin, non ottimizzato clinicamente).
- Endpoint: `GET /protocol-instances/:id/weekly-plan`.

**Test manuale**
1. Su un `ProtocolInstance` con fase attiva contenente 3 esercizi con frequenze diverse (es. 3x/sett, 7x/sett, 2x/sett).
2. `GET /protocol-instances/:id/weekly-plan` → verificare che ogni esercizio compaia nel numero di giorni corrispondente alla sua `weeklyFrequency` (contabile a mano).

**Criteri di accettazione**
- [ ] Distribuzione settimanale coerente con le frequenze configurate, verificata contando i giorni nella risposta.

---

## FASE 3 — AI

### F3.1 — Rule Engine generale (AI Livello 1) — ⏸ CHECKPOINT prima di iniziare
**Obiettivo**: regole cliniche generali (es. "SE dolore NPRS > 7 ALLORA segnala") oltre ai criteri di fase già coperti da F2.4.

**⏸ Checkpoint da confermare prima di scrivere codice**: riusare/estendere il `criteriaEvaluator` di F2.4 (stesso formato JSON, ambito più ampio: non solo criteri di fase ma regole generali su qualunque combinazione di Observation/Patient/ClinicalCase) **oppure** adottare `json-rules-engine`. Raccomandazione: iniziare riusando l'evaluator esistente (già testato in F2.4) e valutare la libreria solo se servirà nesting di regole complesso che l'evaluator custom non copre.

**Da costruire (una volta confermato il checkpoint)**
- `src/modules/protocols/models/clinicalRule.model.ts` (schema public, catalogo regole condivise): `id, code, description, criteria (stesso formato JSON di F2.4), severity (INFO|WARNING|ALERT), suggestedAction`.
- `src/modules/protocols/services/ruleEngine.service.ts`: valuta tutte le `ClinicalRule` attive contro i dati correnti di un paziente, produce `RuleProposal[]`.
- `src/modules/protocols/models/ruleProposalDecision.model.ts` (tenant, audit): `id, ruleCode, patientId, proposedAt, operatorDecision (APPROVED|MODIFIED|REJECTED), operatorId, decidedAt, notes`. **Obbligatorio** per requisito normativo (tracciare ogni decisione dell'operatore, citato nel documento §5 punto 8).
- Endpoint: `GET /patients/:id/rule-proposals` (valuta e ritorna proposte), `POST /rule-proposals/:ruleCode/decision` (registra decisione operatore).

**Test manuale**
1. Creare una `ClinicalRule` di test (`NPRS > 7 → ALERT`).
2. Popolare Observation con `PAIN_NPRS = 8` per un paziente.
3. `GET /patients/:id/rule-proposals` → la regola compare come proposta attiva.
4. `POST /rule-proposals/.../decision` con `operatorDecision: 'APPROVED'` → verificare persistenza in `RuleProposalDecision`.
5. Ripetere il `GET` → la stessa regola non deve ripresentarsi come "nuova" se già decisa di recente (definire una finestra di cooldown, es. non riproporre entro 24h dalla decisione — da testare impostando una decisione e verificando che non ricompaia).

**Criteri di accettazione**
- [ ] Proposte generate correttamente dai criteri.
- [ ] Ogni decisione operatore registrata e auditabile.
- [ ] Cooldown anti-spam funzionante.

---

### F3.2 — Modulo `ai` interno (Livello 2, assistente generativo) — provider astratto
**Obiettivo**: riassunto cartella / bozza piano, **senza** legarsi a un provider LLM specifico (decisione utente: solo interfaccia).

**Da costruire**
- `src/modules/ai/llmProvider.interface.ts`: `interface LlmProvider { complete(prompt: string, opts?): Promise<string>; }`.
- `src/modules/ai/mockLlmProvider.ts`: implementazione deterministica (es. template string che riassume i campi ricevuti) — **usata di default**, permette di testare l'intero modulo **senza chiavi/costi esterni**.
- `src/modules/ai/services/patientSummary.service.ts`: costruisce il prompt leggendo **solo il DB Rehablo** (Patient, ClinicalCase, ultime Observation, PROMs) — mai chiamate dirette a vendor esterni, coerente con la nota architetturale del documento.
- Endpoint: `GET /patients/:id/ai-summary` → usa il provider configurato (default `Mock`), ritorna testo + un flag esplicito `requiresHumanApproval: true` + `generatedByProvider: 'mock'|'<futuro provider>'`.
- Punto di estensione: `src/modules/ai/providers/` dove un futuro `OpenAiProvider`/`AzureOpenAiProvider` implementerà la stessa interfaccia — attivabile via env (`AI_PROVIDER=mock|openai|azure`) senza toccare il resto del modulo.

**Test manuale**
1. `GET /patients/:id/ai-summary` (con `AI_PROVIDER=mock` di default) → deve rispondere con un riepilogo testuale coerente con i dati realmente presenti per quel paziente (verificabile leggendo i dati sorgente e confrontando).
2. Verificare che il flag `requiresHumanApproval: true` sia sempre presente (nessuna azione automatica).
3. Verificare che nessuna chiamata di rete esterna venga effettuata (log/monitor di rete durante il test, dato che il provider è mock).

**Criteri di accettazione**
- [ ] Riepilogo generato coerente con i dati sorgente, provider mock, zero dipendenze esterne.
- [ ] Interfaccia pronta per un provider reale futuro senza refactor (solo aggiunta di un nuovo file `providers/*.ts`).
- ⏸ **Provider LLM reale**: non scelto, task di follow-up separato quando sarà presa la decisione (impatta env vars, costi, DPA/data residency).

---

### F3.3 — Livelli 3–4 (modelli predittivi, Learning Health System)
**Non pianificato in dettaglio in questa iterazione**: il documento stesso li rimanda ("servono prima i dati"). Nessuna funzionalità di codice da consegnare ora. Annotazione per il backlog: quando ci sarà volume dati sufficiente (Fase 2 completata e usata in produzione per un periodo), valutare l'estrazione di un servizio Python/ML separato, sfruttando il confine pulito del modulo `ai` (che già legge solo DB, mai i moduli chiamano `ai` direttamente).

---

## FASE E — Valutazioni come contenitore (ri-architettura evaluation + human-body)

> **Origine**: richiesta prodotto (2026-07-16). Oggi il frontend salva i dati clinici (punti, sintomi,
> ROM, forza, scale) **solo per `patientId`**, senza `evaluationId`: riaprendo il corpo umano si vedono
> **tutti i dati di tutti i giorni mischiati**. Il backend invece ha già `Evaluation` come aggregate root
> (CRUD completo, `getEvaluationById` che carica sintomi/ROM/forza/questionari/scale/test filtrati per
> `evaluationId`, colonne `evaluationId` già presenti sui sotto-modelli). Serve: (1) far sì che **ogni**
> salvataggio porti l'`evaluationId`; (2) legare punti e misure strumentali alla valutazione; (3)
> ricostruire il frontend attorno alla valutazione.

### Decisioni di dominio (confermate con il prodotto)
| Tema | Decisione |
|---|---|
| Modello mentale | Il **punto** sul corpo è l'**ancora di una registrazione** (sintomo, ROM, forza, test, questionario, **device/CSV**). Cliccando un punto scegli dal menù cosa registrare; ricliccando rivedi i dati (come oggi per i sintomi). |
| Scoping punti | **Per-valutazione**: nuova valutazione = corpo **vuoto**; riaprendo vedi solo i punti di quella seduta. → `HumanBodyPoint` acquista `evaluationId`. |
| Misure strumentali | Il device/CSV è una **voce del menù del punto**: click punto → "Device/CSV" → modale upload → salva → `Observation` agganciata a `humanBodyPointId` (+ `evaluationId`). |
| Stato/lock | `DRAFT` editabile finché **è ancora la giornata di creazione**; con "Salva e chiudi" **oppure** a fine giornata → `COMPLETED` = **sola lettura per sempre**. |
| Data clinica | Default oggi; **retrodatabile** (≤ oggi); **mai futura**. È un attributo separato dalla finestra di modifica (legata alla giornata di creazione). |
| Modifica di una COMPLETED | Non si sblocca: si fa **"Duplica in nuova valutazione"** (clone derivato con `parentEvaluationId`, precompilato dai dati della sorgente, data = oggi). L'originale resta immutabile → dato clinico reale intatto. |
| Creazione | **A un click**, tutto preimpostato (titolo automatico "Valutazione di {paziente} del {data}"); unica cosa modificabile la data. |
| Pagine | (a) pagina **globale** con tutte le valutazioni di tutti i pazienti; (b) dalla riga paziente in *contacts* l'azione "Valutazioni" apre la **lista valutazioni del paziente** (invece di aprire direttamente la human-body). |
| Dati legacy | **Cancellati** (ambiente di sviluppo, nessun dato reale da preservare). |

### E1 — Fondamenta dati backend (`evaluationId` ovunque + punti/misure legati alla valutazione) ✅
**Da costruire**
- `HumanBodyPoint`: aggiungere `evaluationId` (UUID, nullable) + associazione `Evaluation.hasMany(HumanBodyPoint)`.
- `Observation`: aggiungere `humanBodyPointId` (UUID, nullable) → aggancio del dato device/CSV/manuale al punto.
- `saveScale` (`scaleInstance.controller.ts`): **oggi non persiste `evaluationId`** → correggere (aggiungere `evaluationId` alla create). Gli altri save (symptom, articularity, strength, test, questionnaire, point) già lo persistono via spread `...req.body`.
- `getEvaluationById`: includere anche `HumanBodyPoint` e le `Observation` (query separata per `evaluationId`) così il dettaglio valutazione mostra TUTTO ciò che appartiene alla seduta.

**Test manuale**
1. `POST /evaluation` per un paziente → ottengo `evaluationId`.
2. `POST /human-body-point` con `evaluationId` → il punto risulta con quell'`evaluationId` in DB.
3. `POST /human-body-symptom` e `POST /scales-instance` con `evaluationId` → entrambi persistono `evaluationId`.
4. `POST /observations` (manuale) con `evaluationId` + `humanBodyPointId` → l'Observation risulta agganciata al punto e alla valutazione.
5. `GET /evaluation/:id` → la risposta include punti, sintomi, scale e observations **solo** di quella valutazione.

**Criteri di accettazione**
- [x] `HumanBodyPoint.evaluationId` e `Observation.humanBodyPointId` presenti e persistiti.
- [x] `saveScale` persiste `evaluationId`.
- [x] `getEvaluationById` restituisce punti + observations della sola valutazione.

### E2 — Caricamento human-body filtrato per valutazione (backend) ✅
**Da costruire**
- `getAllHumanBodyPointsWithEvents` / `getAllHumanBodyPoints`: accettare `evaluationId` in query e filtrare (mantenendo retrocompatibilità: senza `evaluationId` comportamento invariato, ma il nuovo frontend passerà sempre `evaluationId`).
- Endpoint per recuperare le `Observation` di un punto (`GET /observations?humanBodyPointId=...`) per mostrarle nel drawer del punto come sintomi/ROM.

**Test manuale**
1. Due valutazioni diverse per lo stesso paziente, con punti diversi.
2. `GET /human-body-point-event?patientId=..&evaluationId=A` → solo i punti di A; idem per B.
3. `GET /observations?humanBodyPointId=..` → solo le misure di quel punto.

**Criteri di accettazione**
- [x] I punti sono correttamente segregati per valutazione (niente più "mischiati").

> **Nota implementativa**: scoping per `evaluationId` (senza più filtro `userId`, dato che la valutazione
> è condivisa dagli operatori del centro); senza `evaluationId` comportamento legacy invariato (filtro per
> operatore). `GET /observations` ora accetta `humanBodyPointId`/`evaluationId` e richiede almeno un filtro
> di scoping (400 altrimenti). Verificato end-to-end (5/5): 2 valutazioni con punti distinti correttamente
> segregate, observations per punto, retrocompatibilità legacy, guardia 400. Attenzione: resta attiva la
> **deduplica per coordinata** (una sola point per coppia cx/cy) del comportamento storico.

### E3 — Ciclo di vita valutazione: lock + data + clone (backend) ✅
**Da costruire**
- Validazione `date`: rifiuto `> oggi`; default oggi.
- Stato/lock: helper `isEditable(evaluation)` = `status === 'DRAFT' && createdAt è oggi`. Una `DRAFT` creata ieri risulta comunque non-editabile oggi (lock calcolato, nessun job notturno necessario). Tutti i save rifiutano scritture se la valutazione target non è editabile (guardia `409 Conflict`).
- `POST /evaluation/:id/clone`: crea nuova `Evaluation` `DRAFT` (data oggi, `parentEvaluationId = :id`) e **duplica** tutti i sotto-record (punti, sintomi, ROM, forza, test, questionari+risposte, scale+risposte, observations) con nuovi id e nuovo `evaluationId`.
- `Evaluation`: aggiungere `parentEvaluationId` (nullable, self-reference logica).

**Test manuale**
1. Creare valutazione, aggiungere dati, "chiudere" (`status COMPLETED`).
2. Tentare un `POST /human-body-symptom` con quell'`evaluationId` → `409` (immutabile).
3. `POST /evaluation/:id/clone` → nuova valutazione DRAFT con **copia** dei dati e `parentEvaluationId` valorizzato.
4. Modificare la copia → consentito; l'originale resta invariata.
5. `POST /evaluation` con `date` futura → `400`.

**Criteri di accettazione**
- [x] COMPLETED immutabile (scritture rifiutate).
- [x] Clone duplica fedelmente tutti i sotto-record con nuovi id.
- [x] Data futura rifiutata.

> **Nota implementativa**: guardia `assertEvaluationEditable` in `evaluationGuard.ts` applicata a TUTTI i
> save clinici (punto, sintomo, ROM, forza, test, scala, questionario, observation manuale/ingestion).
> **Cambio di default**: una nuova valutazione ora nasce `DRAFT` (prima era `COMPLETED`), coerente col
> ciclo di vita. Clone in `evaluationClone.ts` con rimappatura degli id dei punti (i sotto-record
> agganciati seguono il nuovo punto). Verificato end-to-end (17/17): data futura→400, DRAFT-oggi
> scrivibile, chiusura→COMPLETED, scrittura su COMPLETED→409, DRAFT di ieri→409, clone DRAFT con
> `parentEvaluationId`, duplicazione fedele di punti/sintomi/observations con id nuovi e remap, sorgente
> invariata, copia modificabile.

### E4 — Pulizia dati legacy (backend, una tantum) ✅
**Da costruire**
- Script/endpoint admin `POST /maintenance/purge-legacy-clinical-data` (protetto, solo super-admin) che cancella i record clinici con `evaluationId IS NULL` nello schema del tenant (punti, sintomi, ROM, forza, questionari, scale, observations orfane). **Oppure** script `.cjs` una-tantum documentato.

**Test manuale**
1. Eseguire lo script su un tenant di sviluppo → i vecchi dati senza `evaluationId` spariscono; le valutazioni nuove restano.

**Criteri di accettazione**
- [x] Nessun record clinico orfano (`evaluationId IS NULL`) dopo l'esecuzione.

> **Nota implementativa**: nuovo modulo `modules/maintenance` con endpoint `POST /maintenance/purge-legacy-clinical-data`
> (middleware `requireSuperAdmin`). Cancella in ordine di dipendenza (prima eventi/risposte figlie dei
> padri legacy, poi i record con `evaluationId IS NULL`, infine i punti) e ritorna i conteggi per tabella.
> **Idempotente**. Verificato end-to-end (6/6): dati legacy rimossi, dati agganciati alla valutazione
> preservati, seconda esecuzione cancella 0. Da eseguire una volta sul tenant di sviluppo reale quando si
> vuole ripartire pulito.

### E5 — FE: pagina "Valutazioni del paziente" ✅
**Da costruire** (in `rehab.io_fe`)
- Dalla riga paziente in *contacts*, l'azione "Valutazioni" apre una pagina **lista valutazioni del paziente** (data, titolo, stato, operatore, sintesi), con pulsante **"Nuova valutazione"** e, su ogni riga COMPLETED, azioni "Apri (read-only)" e "Duplica in nuova".
- Nuovo service Angular `evaluations.service.ts` (create/list/get/clone) verso gli endpoint esistenti.

**Test manuale**
1. Dal paziente → "Valutazioni" → vedo la lista (vuota all'inizio).
2. "Nuova valutazione" → crea DRAFT e naviga alla human-body scoped.

**Criteri di accettazione**
- [x] La riga contacts non apre più direttamente la human-body ma la lista valutazioni.

> **Nota implementativa**: nuovo modulo lazy `modules/admin/apps/evaluations` (rotta `/apps/evaluations/patient/:patientId`),
> `EvaluationsService` (list/get/create/update/clone/remove), componente standalone `PatientEvaluationsComponent`
> (lista con stato DRAFT/COMPLETED, "Nuova valutazione", menù Duplica/Elimina con `RehabloConfirmationService`).
> Il pulsante "Valutazioni" in `contacts/list` ora punta a `/apps/evaluations/patient/:id` (prima apriva
> `human-white-body`). **Build Angular AOT OK.** *Seam*: "Nuova"/"Apri"/"Duplica" navigano alla rotta
> `human-white-body/:patientId/:evaluationId` che viene creata in **E6** (fino ad allora quel click porta al
> canvas non ancora scoped). La pagina lista è però già pienamente testabile (crea/duplica/elimina).

### E6 — FE: human-body "scoped" alla valutazione (create → vuoto → salva/chiudi → read-only) ✅
**Da costruire**
- La human-body riceve `evaluationId` in rotta; carica **solo** i punti/eventi di quella valutazione.
- Tutti i salvataggi (punti, sintomi, ROM, forza, scale, questionari, test) inviano `evaluationId`.
- "Salva e chiudi" → `PUT /evaluation/:id { status: 'COMPLETED' }` → vista read-only.
- Riapertura COMPLETED → UI in sola lettura (input disabilitati), con "Duplica in nuova valutazione".

**Test manuale**
1. Nuova valutazione → corpo vuoto → inserisco un punto con un sintomo → salvo.
2. Riapro la stessa valutazione → vedo solo quel punto (non i dati di altri giorni).
3. Chiudo → read-only. "Duplica" → nuova DRAFT modificabile.

**Criteri di accettazione**
- [x] Niente più punti "mischiati" tra giorni.
- [x] Read-only effettivo dopo la chiusura.

> **Nota implementativa**: nuova rotta `human-white-body/:patientId/:evaluationId` (la vecchia `:patientId`
> resta per retrocompat). `HumanBodyResolvers` e `getHumanBodyPoints` passano `evaluationId` → punti scoperti.
> Il componente legge `evaluationId`, carica lo stato via `EvaluationsService.getById` (→ `readOnly` se
> COMPLETED) e inietta `evaluationId` nei 4 oggetti dati (`symptom`/`extraData`/`questionnaire`/`scale`); i
> 4 componenti figli (symptoms-v2, movement, compiler, questionnaire-compiler) inoltrano `evaluationId` nei
> POST (e nei `pointToCreate`). Aggiunto `evaluationId?` al tipo FE `HumanBodyPoint`. **Barra valutazione**
> in alto: titolo + stato, "Salva e chiudi" (DRAFT→COMPLETED, torna alla lista) o "Duplica in nuova
> valutazione" (se chiusa). In `readOnly` la toolbar di disegno è nascosta e `onClickPathBody`/
> `openAutocomplete` fanno early-return (nessuna scrittura possibile; il backend E3 blocca comunque con 409).
> **Build Angular AOT OK.**

### E7 — FE: voce menù punto "Device/CSV" con modale upload ✅
**Da costruire**
- Nel menù del punto, nuova voce **Device/CSV**: apre modale che (a) seleziona il dispositivo configurato, (b) carica il file, (c) chiama l'import → crea `Observation` con `humanBodyPointId` + `evaluationId`.
- Ricliccando il punto, le misure importate si mostrano nel drawer come sintomi/ROM/questionari.

**Test manuale**
1. Click su un punto → Device/CSV → carico un CSV di un dispositivo configurato → salvo.
2. Riclicco il punto → vedo le misure importate.

**Criteri di accettazione**
- [x] Il dato device/CSV è visibile agganciato al punto, dentro la valutazione.

> **Nota implementativa**: BE — `POST /imports` ora accetta `evaluationId` + `humanBodyPointId` (propagati
> nelle Observation) con guardia di immutabilità (409 su valutazione chiusa). FE — nuovo dialog standalone
> `components/device-import` (tendina dispositivi da `GET /import-profiles` PUBLISHED, upload file letto come
> testo): crea il punto (`createPoint` con marker `device_csv`, scoperto sulla valutazione) e poi importa
> agganciando `humanBodyPointId`+`evaluationId`. Voce menù punto "Importa da dispositivo (CSV)"
> (`openDeviceImport`, early-return in readOnly). `HumanBodyService.getObservationsByPoint` +
> `pointObservations$`; il drawer del punto mostra la sezione **"Misure da dispositivo"** (metrica, valore,
> unità, lato, data), caricata nel `forkJoin` al click del punto. **Build Angular AOT OK.**

### E8 — FE: pagina globale "Tutte le valutazioni" ✅
**Da costruire**
- Voce di menù con elenco di tutte le valutazioni di tutti i pazienti (paziente, data, stato, operatore), filtrabile, con link alla singola valutazione.

**Test manuale**
1. Apro la pagina globale → vedo valutazioni di più pazienti → clic apre la valutazione.

**Criteri di accettazione**
- [x] Elenco cross-paziente funzionante e navigabile.

> **Nota implementativa**: nuovo componente standalone `all-evaluations` (rotta `/apps/evaluations/all`) che
> unisce `GET /evaluation` (tutte) + `getContacts()` per mostrare il **nome paziente**, con **ricerca**
> client-side (paziente/titolo), stato DRAFT/COMPLETED, e azioni "Apri" (canvas scoped) e "Valutazioni del
> paziente". Aggiunta la voce di menù laterale **"Valutazioni"** (`data.ts`, link `/apps/evaluations/all`).
> **Build Angular AOT OK.** (Nota: il nome operatore non è mostrato per ora — richiederebbe una mappa
> utenti; facile da aggiungere in seguito.)

---

## Ordine di esecuzione consigliato

```
F0.1 → F0.2 → F1.1 → F1.2 (+F1.2b) → F1.3 → F1.4 → F1.5 → F1.6 → F1.7
   → F2.1 → F2.2 → F2.3 → F2.4 → F2.5 → F2.6 → F2.7 → F2.8 → F2.9
   → F3.1 (checkpoint) → F3.2 → (F3.3 backlog, non ora)

Ri-architettura valutazioni (indipendente, priorità prodotto):
E1 → E2 → E3 → E4 → E5 → E6 → E7 → E8
```

Motivazione: ogni riga dipende solo da funzionalità già chiuse a sinistra (es. F2.3 `Goal.metricCode` richiede il dizionario già esistente da Fase 0; F2.6 usa `Goal` da F2.3; F3.1 riusa l'evaluator di F2.4). Le feature Fase 1 sono indipendenti da Fase 2/3 e potrebbero procedere in parallelo se ci sono più sviluppatori.

## Elenco dipendenze npm nuove da introdurre (via feature)
| Dipendenza | Introdotta da | Motivo |
|---|---|---|
| `multer`, `@types/multer` | F0.1 | upload multipart |
| `xlsx` (o `exceljs`) | F1.3 | parsing Excel |
| `express-rate-limit` | F1.5 | rate limiting per API key |
| `swagger-jsdoc`, `swagger-ui-express` (+types) | F1.6 | documentazione OpenAPI |
| `node-cron`, `@types/node-cron` | F1.2 | scheduler pull |
| _(nessuna)_ per rule/criteria evaluator | F2.4/F3.1 | scelta esplicita: evaluator custom, no libreria esterna (checkpoint in F3.1 può ribaltare questa scelta) |

