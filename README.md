# rehablo-api

Monolite Node.js/TypeScript che sostituisce la precedente architettura a microservizi di Rehablo
(`rehablo-authentication`, `rehablo-patient-registry`, `rehablo-invoice`, `rehablo-invoice-service`,
`rehablo-productions-services-service`, `rehablo-agenda-service`, `rehablo-configuration`,
`rehablo-human-body`). I gateway (`rehablo-gateway`, `rehablo-gateway-v2`) non servono più: questo
servizio espone direttamente tutte le API.

## Decisioni architetturali

- **Linguaggio**: TypeScript (ESM), Express 4, Sequelize 6.
- **Database**: un solo Postgres per tutto il monolite.
  - Schema `public`: dati globali (tenant, utenti, strutture, disponibilità).
  - Schema dinamico `rehablo_<tenantId>` per tenant: dati di business (pazienti, fatture, agenda,
    prodotti/servizi, configurazione dashboard). Pattern già usato nei vecchi microservizi,
    mantenuto e centralizzato in `src/utils/tenantSchema.ts`.
- **Autenticazione**: JWT stateless (nessun Redis). Il vecchio controllo `validToken()` aveva un bug
  (la Promise di `redisClient.get()` non veniva mai attesa, rendendo il controllo sempre vero):
  con `requireAuth` la verifica della firma/scadenza del JWT è l'unica fonte di verità.
- **Niente Kafka**: la sincronizzazione tra `patient-registry`/`prod-serv-service` e
  `invoice-service` via Kafka non serve più: tutto avviene tramite chiamate dirette in-process.

## Struttura

```
src/
  config/        env, connessione Sequelize singola
  middleware/     requireAuth, resolveTenantSchema, error handler
  services/       email.service.ts (nodemailer, template centralizzati)
  utils/          response helper, tenant-schema registry/sync
  modules/
    auth/             tenant, utenti, strutture, login (schema public)
    patients/         anagrafica pazienti (schema per tenant)
    products-services/ prodotti e servizi (schema per tenant)
    invoice/          fatturazione unificata (schema per tenant)
    agenda/           agenda eventi + tipi evento (schema per tenant)
    configuration/    dashboard/widget (schema per tenant)
  server.ts       bootstrap dell'app
```

## Fatturazione: fusione dei due vecchi servizi

`rehablo-invoice` (v2) aveva il modello fiscale più completo (rivalsa INPS, ritenuta d'acconto,
marca da bollo, sconti, calcolo totali in `evalTotals.js`) ma prodotti/servizi erano JSON embedded.
`rehablo-invoice-service` (v1) aveva CRUD completo e relazioni reali M2M con Product/Service, ma
modello fiscale più povero e sincronizzazione fragile via Kafka.

Il modulo `invoice` di questo monolite unisce: modello fiscale di v2 + relazioni reali (via
`InvoiceProduct`/`InvoiceService`) e CRUD completo di v1, eliminando Kafka.

## Stato della migrazione

| Dominio | Stato |
|---|---|
| Auth / Tenant / Strutture | ✅ Portato |
| Pazienti | ✅ Portato |
| Prodotti / Servizi | ✅ Portato |
| Fatturazione | ✅ Portato (unificato) |
| Agenda | ✅ Portato |
| Configurazione (dashboard/widget) | ✅ Portato |
| **Human Body** (punti corpo, questionari, scale, test) | ⏳ Da portare — dominio più vasto, richiede una sessione dedicata |
| Payment method / Subscription plan / License manager | ⏳ Stub nel vecchio codice, da progettare da zero |
| Gateway / Gateway v2 | ❌ Non più necessari, dismessi |

## Setup locale

```bash
cp .env.example .env   # configura DATABASE_URL, JWT_SECRET, SMTP, Stripe
npm install
npm run build           # compila anche le implementazioni delle migrazioni
npm run db:migrate      # applica le migrazioni al database configurato in .env
npm run dev             # tsx watch
# In alternativa, avvio dalla build: npm start
```

Ripetere build e migrazione dopo un pull che introduce migrazioni pendenti: i file già
eseguiti vengono saltati. `npm run dev` controlla lo stato del database all'avvio e non
applica migrazioni automaticamente. Dettagli in [Database migrations](docs/DATABASE_MIGRATIONS.md).

## Avvio e health check su Render

Il servizio con disco persistente usa **Pre-Deploy Command vuoto** e **Start Command `npm start`**.
Render ferma la vecchia istanza prima del nuovo avvio; `npm start` esegue Sequelize CLI e,
solo se le migrazioni riescono, avvia l'API. Il fermo include il tempo delle migrazioni.
Per i servizi configurati manualmente, svuotare il Pre-Deploy Command anche nel pannello Render.

Dopo le migrazioni il listener apre su `0.0.0.0` alla porta indicata da `PORT`. Durante il bootstrap,
`GET /health` restituisce `503 {"status":"starting"}` e tutte le rotte applicative,
compresi webhook Stripe e link pubblici, rispondono `503` senza eseguire i controller.
Dopo connessione al database, verifica delle migrazioni e attivazioni obbligatorie, il servizio
abilita le API e `/health` restituisce `200 {"status":"ok"}`. Un errore obbligatorio
chiude il listener e termina il processo con codice 1.

In Render, verificare che **Settings > Health Checks > Health Check Path** sia `/health`,
come in `render.yaml`: il solo controllo TCP non verifica il completamento del bootstrap.
La finestra per superare gli health check di un nuovo deploy è di 15 minuti.
I log `[startup]` e `[tenant-schema]` indicano fase, tenant, modello o migrazione e durata;
l'ultima fase avviata senza completamento identifica il passaggio da indagare.

Verifiche locali: `npm run build` e `npm run test:startup`. Dopo il deploy, verificare
nei log il completamento della CLI, la successiva apertura della porta e il messaggio
`bootstrap complete; accepting application traffic`.

## Da fare prima del go-live

1. Portare il dominio `human-body`.
2. Scrivere uno script di migrazione dati dai vecchi database separati al nuovo DB unico
   (per ogni tenant: copiare i dati di ogni vecchio schema `rehablo_<tenantId>` nel nuovo schema
   con lo stesso nome, più i dati pubblici di tenant/user/structure).
3. Sostituire i segreti hardcoded (JWT, Stripe, SMTP) con variabili d'ambiente reali in produzione.
4. Valutare se reintrodurre rate-limiting/RBAC (la dipendenza `accesscontrol` era installata ma
   mai realmente utilizzata nei vecchi servizi).
5. Aggiornare il frontend per puntare a questo servizio unico invece che al gateway.

