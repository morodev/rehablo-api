# Rehablo — Ruoli e Permessi (RBAC scoped)

> Documento di design condiviso backend (`rehablo-api`) e frontend (`rehab.io_fe`).
> Stato: **Fase 1 implementata** (catalogo permessi, ruoli, middleware, guard/direttiva FE).

---

## 1. Requisiti raccolti

| Requisito | Decisione |
|---|---|
| Ruoli operativi | Owner, Segreteria, Fisioterapista, Fisiatra, Ortopedico, Collaboratore esterno, Sola lettura, Paziente (+ SuperAdmin piattaforma) |
| Granularità sui dati (own vs any) | **Sì, requisito** → permessi con *scope* |
| Ruoli custom per tenant | No, **ruoli fissi di sistema** (seed nel codice) |
| Scope del ruolo | Tenant **+ override per struttura** (`structure_users.role`) |
| Risoluzione permessi | **Dentro il JWT**, access token breve + refresh token |
| Portale paziente | In roadmap → principal type separato (`staff` / `patient`) |
| Migrazione | Nessun dato di produzione → design libero |

---

## 2. Modello concettuale

```
User (public.users)          ← identità, nessun ruolo qui
  └─ TenantUser (role)       ← ruolo BASE nel tenant
       └─ StructureUser (role?) ← OVERRIDE opzionale nella singola struttura
```

**Regola d'oro:** il ruolo non sta sullo `User`. Un utente può appartenere a più tenant
e avere ruoli diversi in strutture diverse dello stesso tenant.

**Risoluzione del ruolo effettivo** (al login e al `login-premise`):

```
ruoloEffettivo = structure_users.role (se valorizzato per il premise selezionato)
               ?? tenant_users.role
```

---

## 3. Formato dei permessi

```
<resource>:<action>:<scope>
   patient : read   : structure
```

### Resources (1:1 con i moduli API)
`patient`, `evaluation`, `protocol`, `bodymap`, `measurement`, `agenda`,
`invoice`, `product`, `dashboard`, `user`, `structure`, `tenant`, `maintenance`

### Actions
`read`, `create`, `update`, `delete`, `export`, `manage`

> `manage` è un **wildcard**: soddisfa qualunque altra action sulla stessa resource.

### Scopes (gerarchici)
| Scope | Significato | Rank |
|---|---|---|
| `own` | solo record di cui l'utente è owner/assegnatario | 1 |
| `structure` | tutti i record della struttura selezionata | 2 |
| `tenant` | tutti i record del tenant | 3 |

Uno scope superiore **implica** quelli inferiori: chi ha `patient:read:tenant`
soddisfa anche una richiesta di `patient:read:own`.

### Perché non CASL / accesscontrol
- `accesscontrol` (già in `package.json`, mai usato) modella solo `own|any`: non regge
  il livello intermedio *structure*, che qui è centrale.
- CASL sarebbe ottimo per regole isomorfe BE↔FE, ma le sue `conditions` sono query
  Mongo-like: con **Sequelize** andrebbero tradotte a mano, perdendo il vantaggio.
- Lo scope a 3 livelli copre il fabbisogno con ~150 righe di codice e zero dipendenze.
  Se in futuro servissero condizioni arbitrarie, la migrazione a CASL resta possibile
  perché il catalogo permessi è centralizzato in un solo file.

---

## 4. Matrice ruoli → permessi (sintesi)

| | Owner | Segreteria | Fisioterapista | Fisiatra / Ortopedico | Collab. esterno | Sola lettura | Paziente |
|---|---|---|---|---|---|---|---|
| Anagrafica pazienti | tenant CRUD | structure CRU | own RU + create | structure R | own R | tenant R | own R |
| Dati clinici (valutazioni, bodymap, misurazioni) | tenant | **nessuno** | own CRUD | structure R / own CRU | own CRU | tenant R | own R |
| Protocolli | tenant | nessuno | own CRUD | structure R / own CRU | own R | tenant R | own R |
| Agenda | tenant CRUD | structure CRUD | structure R / own CRUD | structure R / own CRUD | own CRU | tenant R | own R |
| Fatturazione | tenant CRUD | structure CRU | nessuno | nessuno | nessuno | tenant R | own R |
| Listino prodotti/servizi | tenant CRUD | tenant R | tenant R | tenant R | — | tenant R | — |
| Utenti e strutture | tenant manage | structure R | structure R | structure R | — | tenant R | — |
| Dati azienda / billing | tenant manage | — | — | — | — | — | — |

> La matrice autoritativa è il codice: `src/modules/auth/rbac/roles.ts`.
> `SUPER_ADMIN` non è un ruolo di tenant: è il flag `users.isSuperAdmin` e **bypassa** ogni check.

---

## 5. Token e sessione (Fase 4 — implementata)

### Access token (JWT, 15 min)
```jsonc
{
  "sub": "<userId>", "actor": "staff",
  "email": "...", "isSuperAdmin": false,
  "tid": "<tenantId>",           // tenant attivo
  "sid": "<structureId|null>",   // premise selezionato
  "role": "THERAPIST",
  "perms": ["patient:read:own", "agenda:manage:own", ...]
}
```

Durata breve **per necessità**: i permessi viaggiano nei claim, quindi un token longevo
terrebbe in vita permessi già revocati. Configurabile con `JWT_EXPIRES_IN` (default `15m`).

### Refresh token (opaco, 30 giorni)
Tabella `public.refresh_tokens`, `REFRESH_TOKEN_TTL_DAYS` (default 30).

| Meccanismo | Come |
|---|---|
| **Hashing** | si salva solo lo SHA-256: un dump del DB non permette di impersonare nessuno |
| **Rotation** | ogni `/auth/refresh` invalida il token presentato ed emette il successivo |
| **Reuse detection** | un token già ruotato che ricompare = copia in giro → si revoca l'intera `familyId` |
| **Contesto** | il record memorizza `tenantId`/`structureId`, così il rinnovo resta coerente col premise |
| **Purge** | token scaduti e revocati da oltre 30 giorni rimossi all'avvio e ogni 24h |

La `familyId` identifica la catena di rotazioni nata da un singolo login. Revocarla chiude
quella sessione e basta: gli altri dispositivi dell'utente restano attivi.

### Endpoint
| Endpoint | Comportamento |
|---|---|
| `POST /auth/login` | emette `accessToken` + `refreshToken` (nuova famiglia) |
| `POST /auth/login-premise/:id` | riemette entrambi con ruolo e permessi della struttura scelta |
| `POST /auth/refresh` | ruota il refresh e **ricalcola ruolo e permessi dal DB** |
| `DELETE /auth/logout` | revoca il refresh token presentato |

> `/auth/refresh` si autentica con il refresh token nel body, non con l'access token
> (che a quel punto è scaduto per definizione).

**Il refresh rilegge i permessi dal database**: è ciò che rende accettabile un access token
breve senza penalizzare l'utente, e fa sì che un cambio di ruolo diventi effettivo entro
15 minuti invece che a fine sessione.

### Revoca su cambio ruolo
`PATCH /user/:id/role` e `/structure-role` chiamano `revokeAllForUser()`: l'utente interessato
dovrà rifare il login. Scelta prudente — per un declassamento è il comportamento corretto,
per una promozione è un fastidio accettabile in cambio della certezza che nessun permesso
revocato sopravviva.

### Lato client
`AuthService.refreshAccessToken()` condivide un'unica richiesta fra tutte le chiamate in attesa
(`shareReplay`): senza, N richieste scadute insieme genererebbero N refresh paralleli e — con la
rotazione attiva — tutte tranne una fallirebbero, facendo scattare la reuse detection su un
utente legittimo.

L'interceptor gestisce tre casi:
1. token già scaduto → refresh **prima** di inviare, evitando un 401 annunciato;
2. 401 su token che sembrava valido (clock skew, revoca) → un solo refresh e retry;
3. refresh fallito → logout.

Gli endpoint di sessione (`login`, `refresh`, `logout`, `login-token`) sono esclusi
dall'interceptor per non creare ricorsione.

---

## 6. Enforcement backend

```ts
router.use(requireAuth, resolveTenantSchema);

router.get('/patient',        requirePermission('patient', 'read'),   ctrl.findAll);
router.post('/patient',       requirePermission('patient', 'create'), ctrl.save);
router.delete('/patient/:id', requirePermission('patient', 'delete'), ctrl.remove);
```

Il middleware, oltre a consentire/negare, popola `req.access`:

```ts
req.access = { scope: 'own' | 'structure' | 'tenant', resource, action }
```

Il controller applica il filtro **row-level**:

```ts
const where = {
  ...scopeWhere(req, { ownerField: 'referentUserId', structureField: 'structureId' })
};
const patients = await Patient.schema(req.tenantSchema!).findAll({ where });
```

- `scope = 'tenant'` → nessun filtro extra (lo schema Postgres isola già il tenant)
- `scope = 'structure'` → `structureId = req.user.sid`
- `scope = 'own'` → `referentUserId = req.user.sub`

Per il singolo record si usa `assertCanAccessRecord(req, record, fields)` che lancia 403.

**Deny-by-default**: una rotta senza `requirePermission` va considerata un bug.

---

## 7. Enforcement frontend (Fase 5 — implementata)

Il frontend non è una barriera di sicurezza: nasconde ciò che l'utente non potrebbe comunque
usare. L'unico controllo che conta resta quello dell'API.

| Livello | Strumento | Stato |
|---|---|---|
| Rotte | `permissionGuard` + `data: { permissions: [...] }` | ✅ su contacts, evaluations, calendar, invoices, products-services, human-body |
| Menu | `RehabloNavigationItem.permissions` + `filterNavigationByPermissions()` | ✅ agganciato al layout classic |
| Template | `*rehabloHasPermission="'invoice:create'"` | ✅ usato nella pagina Team |
| Logica TS | `PermissionsService.can(...)` / `scopeOf(...)` | ✅ |

### Filtro della navigazione
Applicato nel `ClassicLayoutComponent` con un `computed` sui signal dei permessi: al cambio
di struttura (che può cambiare il ruolo effettivo) il menu si riallinea **senza ricaricare
la pagina**. Il filtro rimuove anche i gruppi rimasti senza figli e i separatori orfani.

> Gli altri layout (compact, futuristic, horizontal) non sono agganciati: se verranno
> attivati, va replicato lo stesso `computed`.

### Pagina Team (`/settings`)
La gestione utenti vive nel componente `settings/team`:
- select del **ruolo** popolata da `GET /auth/roles` (non più valori hardcodati);
- select multipla delle **sedi** in cui l'utente può operare;
- pulsanti nuovo/modifica/elimina condizionati da `*rehabloHasPermission`;
- la select del **proprio** ruolo è disabilitata, coerentemente con il 403 dell'API.

In modifica, ruolo e sedi **non** passano da `PATCH /user`: hanno endpoint dedicati perché
vivono su `tenant_users` e `structure_users`. In creazione viaggiano invece nello stesso
payload, perché l'API crea utente, membership e assegnazioni insieme.

`updateUserStructures` esegue un diff invece di cancellare e ricreare: riscrivere tutto
perderebbe gli override di ruolo per struttura.

### Bug corretti strada facendo
Il frontend chiamava due endpoint inesistenti — modifica ed eliminazione utente
rispondevano 404:

| Prima | Ora |
|---|---|
| `PATCH /user/edit/{id}` | `PATCH /user/{id}` |
| `DELETE /user/delete/{id}` | `DELETE /user/{id}` |

---

## 8. Cosa è stato implementato (Fase 1)

### Backend — `rehablo-api`
| File | Contenuto |
|---|---|
| `src/modules/auth/rbac/permissions.ts` | Catalogo resources/actions/scopes, `perm()`, `crud()`, `resolveGrantedScope()`, `hasPermission()` |
| `src/modules/auth/rbac/roles.ts` | `RoleCode`, `ROLE_DEFINITIONS` (matrice ruolo→permessi), `resolveEffectiveRole()`, `getRolePermissions()` |
| `src/middleware/rbac.ts` | `requirePermission()`, `requireAnyPermission()`, `scopeWhere()`, `assertCanAccessRecord()` |
| `src/modules/auth/controllers/rbac.controller.ts` | `GET /auth/roles`, `GET /auth/me/permissions` |
| `models/tenantUser.model.ts` | colonna `role` (ENUM, default `THERAPIST`) |
| `models/structureUser.model.ts` | colonna `role` (ENUM, nullable = eredita dal tenant) |
| `controllers/auth.controller.ts` | `buildRbacClaims()`: emette `role` + `perms` nel JWT al login e al `login-premise` |
| `routes/patient.routes.ts` | **rotta di riferimento** con `requirePermission` su ogni endpoint |

> Le colonne `role` vengono create in automatico da `syncAuthModels()` (`sync({ alter: true })`).

### Frontend — `rehab.io_fe`
| File | Contenuto |
|---|---|
| `core/auth/rbac/permissions.ts` | Mirror del catalogo backend |
| `core/auth/rbac/permissions.service.ts` | Stato a signal: `can()`, `canAny()`, `canAll()`, `scopeOf()`, `hasRole()` |
| `core/auth/guards/permission.guard.ts` | `permissionGuard` / `permissionChildGuard` funzionali |
| `@rehablo/directives/has-permission/` | Direttiva strutturale `*rehabloHasPermission` |
| `core/navigation/navigation.permissions.ts` | `filterNavigationByPermissions()` con pulizia di gruppi e separatori orfani |
| `core/auth/auth.service.ts` | Carica i permessi a ogni nuovo token, li azzera al logout |
| `core/auth/auth.utils.ts` | `AuthUtils.decodeToken()` pubblico |
| `public/i18n/*.json` | Chiavi `role-owner`, `role-secretary`, … |

### Esempi d'uso

**Rotta API**
```ts
router.get('/evaluation', requirePermission('evaluation', 'read'), ctrl.getEvaluations);
```

**Controller con filtro row-level**
```ts
const where = { ...scopeWhere(req, { ownerField: 'authorUserId', structureField: 'structureId' }) };
```

**Rotta Angular**
```ts
{
    path: 'invoices',
    canActivate: [permissionGuard],
    data: { permissions: ['invoice:read'] },
    loadChildren: () => import('app/modules/admin/invoices/invoices.routes'),
}
```

**Template**
```html
<button *rehabloHasPermission="'patient:delete'" (click)="delete()">Elimina</button>
```

**Voce di menu**
```ts
{ id: 'invoices', title: 'Fatture', type: 'basic', link: '/invoices', permissions: ['invoice:read'] }
```

---

## 9. Stato dell'enforcement per modulo (Fasi 3 e 3b)

Ogni rotta che tocca dati dichiara il permesso richiesto **e** filtra i record per scope.

| Modulo | Resource | `requirePermission` | Filtro row-level | Strategia |
|---|---|---|---|---|
| patients | `patient` | ✅ | ✅ | `scopeWhere` su `userId` / `structureId` |
| evaluations | `evaluation` | ✅ | ✅ | `scopeWhere` su `userId` / `structureId` |
| agenda | `agenda` | ✅ | ✅ | `scopeWhere` su `calendarId` / `structureId` |
| invoice | `invoice` | ✅ | ✅ | `patientScopeWhere` su `patientID` |
| human-body | `bodymap` / `evaluation` | ✅ | ✅ | `patientScopeWhere` su `patientId` |
| protocols (istanze) | `protocol` | ✅ | ✅ | `patientScopeWhere`; le fasi via protocollo padre |
| measurements | `measurement` | ✅ | ✅ | `patientScopeWhere` su `patientId` |
| configuration | `dashboard` | ✅ | ✅ | ownership stretta (`userId`), widget via dashboard |
| products-services | `product` | ✅ | n/d | listino tenant-wide |
| protocols (cataloghi) | `protocol` | ✅ | n/d | schema public: scrittura a scope `tenant` |
| auth (user/tenant/structure) | `user`, `tenant`, `structure` | ✅ | n/d | schema public |
| maintenance | — | ✅ `requireSuperAdmin` | n/d | — |

### Le tre strategie di scoping

**1. Owner diretto** (`scopeWhere`) — il record ha una colonna che punta al professionista.
Usata dove esiste: `Patient.userId`, `Evaluation.userId`, `AgendaEvent.calendarId`.

**2. Ereditato dal paziente** (`patientScopeWhere`) — il record non ha un proprietario ma appartiene
a un paziente: fatture, misure, sintomi, protocolli. L'ampiezza si eredita da quella sui pazienti
tramite sotto-query:

```sql
patientId IN (SELECT id FROM "<schema>".patients WHERE "userId" = '<uuid>')
```

Sotto-query e non caricamento in memoria degli id, così resta efficiente con anagrafiche grandi.
UUID e nome schema sono validati con regex prima dell'interpolazione: nessun input utente nell'SQL.

> **Scelta di modello**: sui dati clinici (body map, valutazioni) lo scope segue il *paziente*, non
> l'operatore che ha inserito il dato. Una valutazione è condivisa dagli operatori del centro
> (vedi FASE E): filtrare per `userId` spezzerebbe il lavoro in équipe.

**3. Ownership stretta** — dashboard e widget sono configurazioni *personali*: si modificano solo
le proprie, a prescindere dallo scope. Nemmeno il titolare tocca la dashboard di un collega.

### Modifiche allo schema
`AgendaEvent.structureId` (UUID, nullable): non esisteva alcun legame tra appuntamento e sede,
quindi lo scope `structure` sull'agenda era impossibile. Viene valorizzato automaticamente alla
creazione con il premise selezionato.

### Gate sulle risorse figlie
Dove il record figlio non ha riferimenti propri, la verifica passa dal padre:

| Figlio | Gate |
|---|---|
| `ProtocolPhaseInstance` | `ProtocolInstance` nello scope |
| `Widget` | `Dashboard` di proprietà |
| eventi ricorrenti (`recurringEventId`) | serie visibile nello scope |
| `InvoiceProduct` / `InvoiceService` | fattura già verificata |

### Creazioni verificate
Non basta filtrare le letture: creare un record *su* un paziente altrui è una scrittura non
autorizzata. Sono ora verificati i pazienti in `createEvaluation`, `saveInvoice`, `assignProtocol`
e `findAppointmentsForPatientById`. In `saveAgendaEvent`, chi ha scope `own` non può creare
appuntamenti nel calendario di un collega (`calendarId` viene forzato).

### Scelte di scope minimo
Alcune rotte richiedono uno scope minimo perché toccano configurazione condivisa e non dati personali:

| Rotta | Permesso | Perché |
|---|---|---|
| `POST/PUT/DELETE /event-type` | `agenda:*:structure` | tipi di appuntamento della sede, non agenda personale |
| `POST/PUT/DELETE /exercises`, `/protocol-templates` | `protocol:*:tenant` | cataloghi nello schema **public**: la scrittura impatta tutti i tenant |
| `POST /questionnaire` e affini | `bodymap:*:structure` | definizione del questionario = configurazione |
| `POST /import-profiles`, `POST /device-catalog` | `measurement:update:tenant` | configurazione di integrazione del tenant |

### Rotte volutamente senza permesso
`login`, `login-premise`, `login-token`, `logout`, `GET /auth/me/permissions`,
`POST /tenant` (registrazione), i flussi pubblici via token in URL (verifica account,
reset password) e le due preferenze di calendario, che sono **self-service**:
`updateUserCalendarVisibility` / `updateUserCalendarColor` consentono la modifica solo
sul proprio utente, salvo possedere `user:update`.

### Assegnazione del ruolo (Fase 2)

| Endpoint | Permesso | Descrizione |
|---|---|---|
| `POST /user` | `user:create` | accetta `role` nel body (validato); default `THERAPIST` |
| `PATCH /user/:userId/role` | `user:update:tenant` | cambia il ruolo BASE nel tenant |
| `PATCH /user/:userId/structure-role` | `user:update:tenant` | override per struttura; `role: null` lo rimuove |
| `GET /auth/roles` | `user:read` | catalogo dei ruoli assegnabili + permessi |
| `GET /auth/me` | solo auth | profilo + ruolo e permessi **riletti dal DB** |
| `GET /auth/me/permissions` | solo auth | ruolo e permessi come stanno nel token |
| `GET /user` | `user:read` | espone `role` in forma piatta per ogni utente |

**Vincoli applicati al cambio ruolo** (`validateRoleChange`):
1. il ruolo deve esistere ed essere `assignable` (`PATIENT` è escluso: nasce dal portale, non dalla UI staff);
2. **nessuno può modificare il proprio ruolo** — impedisce sia l'auto-esclusione sia l'auto-promozione di chi possiede `user:update`;
3. l'utente deve appartenere al tenant di chi effettua la modifica;
4. non si può declassare **l'ultimo `OWNER`** dello studio (409), altrimenti nessuno potrebbe più gestire utenti e fatturazione;
5. per l'override di struttura, la struttura deve appartenere al tenant e l'utente esservi assegnato.

`GET /auth/me` rilegge ruolo e permessi dal database e restituisce `roleChanged: true` quando
il token in mano al client è disallineato: il frontend può così aggiornare i permessi
(`PermissionsService.loadFromProfile()`) senza attendere la scadenza del JWT.

### Assegnazione del ruolo
- `assignBootstrapRoles()` (chiamata all'avvio) promuove a `OWNER` le membership degli utenti con `isTenant = true`, altrimenti tutti resterebbero `THERAPIST` dopo la creazione della colonna.

### Audit automatico (deny-by-default)

```bash
npm run audit:rbac
```

Scansiona tutti i `*.routes.ts` e fallisce (exit 1) se trova una rotta priva di
`requirePermission` / `requireAnyPermission` / `requireSuperAdmin` che non sia nella
allow-list di `scripts/audit-rbac.mjs`. Va inserito in CI: è la rete di sicurezza che
impedisce a una nuova rotta di nascere non protetta.

Stato attuale: **167 rotte analizzate, 0 non protette**.

---

## 10. Roadmap

> Nota storica: la Fase 2 inizialmente prevista ("colonne `role` + permessi nel JWT") è stata
> assorbita dalla Fase 1, perché senza il ruolo nel token `requirePermission` non avrebbe
> avuto nulla da leggere. La Fase 2 è stata poi ridefinita come *gestione* dei ruoli.

- [x] **Fase 1** — Catalogo permessi + ruoli + colonne `role` + claim JWT + middleware `requirePermission` + `PermissionsService`, guard e direttiva FE
- [x] **Fase 2** — API di gestione ruolo (tenant + override struttura), `GET /auth/me`, `RolesService` Angular
- [x] **Fase 3** — `requirePermission` su tutte le rotte dati + `scopeWhere` su patients ed evaluations + `npm run audit:rbac`
- [x] **Fase 3b** — `AgendaEvent.structureId`, `patientScopeWhere`, filtro row-level su tutti i moduli con dati
- [x] **Fase 4** — Access token 15 min + `refresh_tokens` con rotation e reuse detection + refresh trasparente lato Angular
- [x] **Fase 5** — Pagina Team con ruolo e sedi, filtro navigazione, `permissionGuard` sulle rotte
- [ ] **Fase 6** — Principal `patient` e portale paziente
- [ ] **Fase 7** — Audit log accessi ai dati clinici (GDPR / `COMPLIANCE.md`)

### Variabili d'ambiente introdotte
```bash
JWT_EXPIRES_IN=15m           # durata access token (default 15m)
REFRESH_TOKEN_TTL_DAYS=30    # durata refresh token (default 30)
```

> ⚠️ Al deploy, le sessioni esistenti smettono di funzionare: i vecchi token non hanno un
> refresh associato. Gli utenti dovranno rifare il login una volta sola.

### Nota sul backfill di `structureId`

Su `Patient`, `Evaluation` e `AgendaEvent` la colonna `structureId` è **nullable**: i record
creati prima della sua introduzione hanno `NULL`.

Lo scope `structure` filtra con `WHERE "structureId" = <sede>`: applicato così, quei record
sparirebbero dalla UI di chiunque abbia scope `structure` (la segreteria aprirebbe
un'anagrafica vuota). Per questo `scopeWhere()` è configurato con `includeUnassigned: true`,
che aggiunge `OR "structureId" IS NULL`.

**È un cerotto, non una soluzione**: un record senza sede diventa visibile a *tutte* le sedi,
cioè esattamente ciò che lo scope `structure` dovrebbe impedire. Innocuo con una sede sola,
è una falla per gli studi multi-sede.

#### Procedura

**Non serve alcun intervento manuale.** Il backfill viene eseguito **automaticamente a ogni
avvio del server** (`server.ts`), subito dopo `assignBootstrapRoles()`. È sicuro perché:

- tocca **solo** le righe con `structureId IS NULL`, non riscrive mai un valore esistente;
- assegna la sede solo quando è deducibile in modo univoco;
- è idempotente: dal secondo avvio non trova più nulla da fare;
- se fallisce non blocca l'avvio, e `includeUnassigned` continua a tenere i dati visibili.

Al primo deploy comparirà nei log:

```
[rbac] backfill structureId completato: patients=143, evaluations=87, agenda_events=210
```

Esecuzione manuale (utile in locale per una verifica preventiva):

```bash
npm run backfill:structure            # DRY RUN: non scrive nulla
npm run backfill:structure -- --apply
```

Lo script assegna la sede dalla regola più sicura alla più incerta:

| Caso | Regola |
|---|---|
| Tenant con **una sola** sede | tutti i record vanno lì: nessuna ambiguità |
| Tenant multi-sede, pazienti | sede del professionista di riferimento, **solo se** ne ha una sola |
| Valutazioni | ereditano la sede del paziente |
| Appuntamenti | sede del titolare del calendario, se univoca |
| Resto | **non toccato** e segnalato nei log come ambiguo |

#### Dopo il backfill

Quando i log non segnalano più record ambigui, rimuovere `includeUnassigned: true` da:

- `patients/controllers/patient.controller.ts` → `PATIENT_SCOPE_FIELDS`
- `evaluations/controllers/evaluation.controller.ts` → `EVALUATION_SCOPE_FIELDS`
- `agenda/controllers/agenda.controller.ts` → `AGENDA_SCOPE_FIELDS`
- `protocols/controllers/protocolInstance.controller.ts` → `PATIENT_SCOPE_FIELDS`

e la clausola `OR "structureId" IS NULL` in `patientScopeWhere()` (`middleware/rbac.ts`).

Valutare poi se rendere la colonna `NOT NULL`, così il problema non si ripresenta.




