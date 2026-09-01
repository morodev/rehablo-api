# Portale paziente multi-centro

## Modello di isolamento

- `users` rappresenta l'identità globale con una sola password.
- `user_emails` contiene gli indirizzi verificati con cui la stessa identità può autenticarsi.
- `patient_portal_accesses` collega un'identità a **una sola cartella locale** tramite
  `(tenantId, patientId)`. Non è una membership staff e non concede permessi sulle API gestionali.
- pazienti, valutazioni, protocolli, appuntamenti, misure, fatture e audit restano nello schema
  PostgreSQL `rehablo_<tenantId>` del centro.
- nessun codice fiscale o dato anagrafico viene usato per un collegamento automatico tra tenant.

Un paziente seguito dai centri A e B vede quindi due contesti dopo il login. I due record paziente
e le relative cartelle restano indipendenti.

## Invito e identità

1. Lo staff salva l'email nella propria anagrafica paziente.
2. `POST /patient/:patientId/portal-invitation` invia un link casuale, monouso e a scadenza.
   Nel database viene conservato solo SHA-256 del token; non viene mai inviata una password.
3. Il destinatario può creare un'identità oppure autenticarsi con un account Rehablo esistente.
4. Nel secondo caso il possesso del link prova l'email dell'invito e le credenziali provano
   l'identità esistente. Solo allora l'email può diventare un alias dello stesso account.
5. Se l'email è già posseduta da un'altra identità, il collegamento viene rifiutato.

## Sessione e autorizzazione

`POST /auth/session` verifica le credenziali e restituisce un selection token di 10 minuti insieme
ai contesti disponibili. `POST /auth/session/context` emette una coppia access/refresh limitata al
contesto scelto. I token paziente contengono `actor=patient`, `tid`, `pid` e `patientAccessId`.

Ogni richiesta del portale rilegge `patient_portal_accesses`: una revoca è quindi immediata anche
prima della scadenza dell'access token. Le rotte staff rifiutano sempre un principal paziente,
indipendentemente dai claim `perms`.

## Visibilità V1

Il portale è esclusivamente in lettura e pubblica DTO dedicati:

- valutazioni con stato `COMPLETED`;
- protocolli assegnati, senza note operative o di progressione;
- misure con qualità `GOOD`, senza file grezzi, metadati o identificativi operatore;
- appuntamenti con un set ristretto di campi;
- fatture già emesse (`documentNumber` valorizzato) e relativi movimenti contabilizzati.

Le note cliniche, i draft e i campi interni vengono esclusi a livello di query e nuovamente rimossi
dalla proiezione ricorsiva. Ogni consultazione riuscita genera un record append-only in
`patient_portal_audit_logs` nello schema del centro.

## Fine trattamento

L'archiviazione dell'anagrafica porta automaticamente l'accesso da `ACTIVE` a `HISTORICAL`.
Il paziente conserva la consultazione in sola lettura. `REVOKED` è un'azione distinta, revoca i
refresh token di quel solo collegamento e non influenza eventuali accessi ad altri centri.

## Rollout

1. Eseguire `migrations/20260901-create-patient-portal.js` prima di distribuire il nuovo backend.
2. Impostare `EMAIL_DOMAIN` sull'origine pubblica del frontend e, se necessario,
   `PATIENT_PORTAL_INVITE_TTL_HOURS` (default 72).
3. Distribuire backend e frontend.
4. Verificare un invito nuovo, il collegamento di un account esistente, il cambio contesto e una
   revoca. Controllare che l'audit venga scritto nello schema tenant corretto.

La migration trasferisce le vecchie sospensioni globali da `users.deactivatedAt` alle membership
`tenant_users.deactivatedAt`: una decisione del centro A non blocca più l'identità nel centro B.
