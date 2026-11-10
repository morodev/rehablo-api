# Performance: misurazione locale e telemetria

La telemetria è disattivata per default. Nessuna configurazione Render, dimensione pool, migrazione DB, endpoint esistente o regola di freschezza è cambiata. OpenTelemetry è fissato a versioni compatibili con Node 20.14 dichiarato nel blueprint (SDK 0.208.0 / componenti 2.2.0; API 1.9.0). Il runtime minimo delle nuove dipendenze è Node 18.19 oppure 20.6+.

## Attivazione controllata

In un ambiente di test con dati sintetici:
- `PERFORMANCE_TELEMETRY_ENABLED=true`: raccoglie durate e contatori; nessuna esportazione se manca un endpoint OTLP.
- `PERFORMANCE_LOG_REQUESTS=true`: una riga JSON per richiesta completata, solo se la telemetria è attiva.
- `PERFORMANCE_SERVER_TIMING=true`: aggiunge `Server-Timing` alle risposte solo quando la telemetria è attiva.
- `OTEL_EXPORTER_OTLP_ENDPOINT`: destinazione OTLP HTTP esplicitamente scelta. Alternativamente usare `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` e/o `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`. Un solo endpoint specifico esporta esclusivamente quel segnale; non avvia exporter impliciti per quello assente. Il test usa un collector HTTP temporaneo su localhost per verificare entrambi i casi.
- Per campionare i trace: `OTEL_TRACES_SAMPLER=parentbased_traceidratio` e `OTEL_TRACES_SAMPLER_ARG=0.1`. Metriche e log non sono campionati da questa impostazione.

Il middleware genera sempre `X-Request-Id`; le activities mantengono lo stesso identificativo. L'esportazione è asincrona e ha timeout; nessuna dipendenza dal collector nel percorso della risposta. Un errore iniziale della telemetria non deve impedire l'avvio HTTP.

Le nuove registrazioni contengono solo metodo, template Express della rotta, status, ID di correlazione, durate, numero query e dimensione risposta. Non acquisiscono URL completi, query string, SQL, bind, body, nomi pazienti, token, cookie o identificativi tenant/utente. Non sono abilitate le auto-instrumentation né la raccolta automatica di host/process arguments. I log Morgan esistenti non sono stati modificati: non considerarli automaticamente sanitizzati da questo modulo.

## Cosa misurare

- HTTP p50/p95/p99 per route, status e dimensione dati.
- Query eseguite per richiesta e somma della loro durata.
- Attesa connessione: include timeout/fallimenti di acquisizione, con contatore separato.
- Pool principale e journal billing: size/available/using/waiting, senza cambiarne i limiti.
- Durata fasi auth e billing; memoria RSS/heap, CPU cumulativa user/system, ritardo event loop p95.
- Trace manuali HTTP/query/pool/fasi. Gli errori DB non esportano messaggi o stack potenzialmente sensibili.

`queryMs` e `poolWaitMs` sono somme: con operazioni parallele possono superare il tempo HTTP. `Server-Timing: app` misura fino all'invio degli header; il record finale HTTP include il completamento della risposta. Le query sono contate tramite hook Sequelize, incluse operazioni di transazione e query fallite che raggiungono il driver; la misura non include righe lette o piano SQL. Per questi servono analisi PostgreSQL mirate su un DB isolato.

La baseline locale non dimostra la latenza da una postazione in Italia né il carico della produzione. Non pubblicare obiettivi raggiunti senza la corrispondente misurazione.

## Runner baseline

`scripts/performance-baseline.mjs` accetta esclusivamente origini loopback e scenari GET. Usare un'API locale collegata solo al database sintetico isolato; non usare proxy verso produzione. Alcuni GET dell'applicazione eseguono riconciliazioni: anche il dataset locale deve essere sacrificabile.

Preparare lo scenario partendo da `scripts/performance-scenario.example.json`, scegliendo filtri e date presenti nel dataset. Include soltanto API preesistenti per confronti prima/dopo: agenda con posizione finanziaria del paziente, attività, overview, financial-summary, scadenze e therapy-payments. Le nuove API sono separate in `scripts/performance-scenario.dashboard.example.json`: usarle solo sulla versione che le espone, sostituendo gli ID fattura con quelli delle fixture e controllando che il risultato contenga dati. Non mescolare i loro 404 precedenti alla modifica con le misure di latenza. I nomi scenario devono essere tecnici e non contenere dati paziente. Il token del solo utente sintetico si passa tramite `PERFORMANCE_BEARER_TOKEN`, mai nei file scenario o nei comandi condivisi.

Senza `--rate` resta il carico closed-loop: ogni worker attende il completamento prima di inviare la richiesta successiva. Misura il throughput ottenuto a concorrenza fissa; se il servizio rallenta cala anche il carico offerto. Esempio:

```text
npm run performance:baseline -- --base-url http://127.0.0.1:3000 --scenario scripts/performance-scenario.example.json --requests 300 --concurrency 1 --warmup 5 --correlation
```

Ripetere con concorrenza 5/10/20 solo sul dataset locale e mantenere gli stessi volumi/filtri per il confronto. Questi numeri non rappresentano una previsione di utenti.

Con `--rate R` il runner pianifica R richieste al secondo indipendentemente dai completamenti, distribuendole in modo uniforme fra gli endpoint dello scenario. Accetta valori da 0.1 a 10000; il limite misura la configurazione, non garantisce che il generatore o il servizio sostengano quel carico. `--concurrency` resta il massimo di richieste in volo: un arrivo senza posto libero viene contato come `dropped`, senza accodarlo e senza ridurre gli arrivi successivi. La finestra offerta dura `requests / rate` secondi; dopo l'ultimo arrivo il runner completa la finestra e attende le richieste già inviate. Il warmup è escluso da conteggi e finestra.

Per il collaudo a tre volte il picco misurato, derivare R e il mix da dati reali, poi eseguire 3 × R sul dataset isolato per una durata dichiarata. Se il picco osservato fosse 10 richieste/s, questo esempio offre 30 richieste/s per cinque minuti; è un esempio, non una misura del traffico attuale:

```text
npm run performance:baseline -- --base-url http://127.0.0.1:3000 --scenario scripts/performance-scenario.example.json --rate 30 --requests 9000 --concurrency 20 --warmup 10 --correlation
```

Il JSON contiene `load.offered`, `completed`, `succeeded`, `failed`, `dropped` e `peakInFlight`. `offeredRequestsPerSecond` è il carico pianificato; `achievedRequestsPerSecond` conta soltanto i successi per secondo sul tempo totale, inclusa l'attesa finale; `completedRequestsPerSecond` e il campo compatibile `requestsPerSecond` includono anche gli errori. `failedRequestsPerSecond` distingue gli errori HTTP/rete dai drop del generatore. Vale `offered = completed + dropped` e `completed = succeeded + failed`.

In modalità rate, `allDurationMs`, `successDurationMs` e `firstByteMs` partono dall'istante pianificato: includono il ritardo del generatore, evitando che un invio in ritardo sembri veloce. `requestDurationMs` misura invece dall'invio effettivo; `schedulingLagMs` espone il ritardo. I drop hanno conteggi e lag separati per endpoint, senza inventare una latenza di risposta. Non interpretare i soli percentili delle richieste ammesse come prova di capacità quando esistono drop o lag elevati. Senza rate, le latenze mantengono l'origine all'invio e il lag è zero.

Restano disponibili percentili per endpoint di tutte le risposte e delle sole 2xx, status, byte risposta decodificati, stima byte richiesta, misure Server-Timing e request ID facoltativi. Il runner non stampa URL, token o corpi. Qualunque risposta non 2xx, errore rete/timeout o drop termina il comando con codice 1. Conservare separatamente prove a freddo (warmup 0) e a caldo; per p99 attendibili usare molte osservazioni. Una prova valida a 3 × R richiede assenza di drop/errori, ritardo del generatore compatibile con la frequenza, dati rappresentativi e rispetto degli obiettivi di latenza; gli otto test del runner verificano il generatore con HTTP sintetico locale e non certificano capacità dell'API o latenza dalle postazioni italiane.

## Verifica e limiti attuali

`npm run test:performance:unit` copre deduplicazione billing entro la richiesta, revoca/fallimenti fra richieste, isolamento delle misure concorrenti, privacy, pool fallito, batch attività, filtri note/promemoria e runner sintetico. Le altre suite specifiche restano valide.

La riproduzione billing ha rilevato 12 letture dello stesso account durante 12 guard sulla medesima richiesta; dopo la correzione sono 1. La richiesta successiva rilegge billing e applica la revoca. Questo è un dato di query-count sotto test, non una misura di millisecondi in produzione.

Il summary attività riusa un unico batch di relazioni/utenti per scadute e oggi nella stessa transazione. I filtri assegnati a me di note/promemoria riusano la lettura degli ID senza condividere cache fra richieste; la riconciliazione dei promemoria resta attiva.

Attivare il collector o il logging richiede una configurazione esplicita dell'ambiente: questa modifica non li attiva in produzione. Il rollout deve prima misurare overhead, percentili, pool e correttezza con telemetria attiva/disattiva. Le versioni dipendenze supportano il runtime attuale; un aggiornamento a OTel SDK più recenti va coordinato con il runtime, senza aggiornamenti impliciti di Node.

Riferimenti: [OpenTelemetry JavaScript](https://opentelemetry.io/docs/languages/js/instrumentation/), [pool Sequelize](https://sequelize.org/docs/v6/other-topics/connection-pool/).


## Letture finanziarie correnti e rollback

`REPORTS_LIVE_READS_ENABLED=false` seleziona i percorsi di lettura precedenti per overview, financial-summary, sessions e receivables; il valore predefinito usa i nuovi percorsi. Il rollback non richiede migrazioni, cambio di dati o invalidazione cache. Non viene introdotta alcuna cache fra richieste o finestra di dati obsoleti.

Overview e financial-summary leggono una proiezione finanziaria compatta degli appuntamenti/pacchetti, senza il JSON clinico del paziente. Se non esistono filtri clinici di attribuzione, evitano le query storiche dei collegamenti fattura non necessarie; con quei filtri preservano i legami, inclusi figli fuori sede, per la stessa esclusione dei documenti misti. I residui attuali e gli avvisi restano basati sulla storia necessaria: la proiezione clinica globale non è ancora sostituita interamente da aggregati SQL.

Il financial-summary calcola in PostgreSQL totali tesoreria/spese del periodo e del confronto, restituendo solo righe aggregate. La ricerca delle rettifiche conserva evidenze precedenti o successive al periodo, sempre nel perimetro autorizzato. I test confrontano il risultato con la proiezione precedente, inclusi cambio ora Europe/Rome, storni futuri, trasferimenti, rimborsi, valori legacy null e sede non autorizzata.

Le risposte finanziarie ottimizzate usano una singola transazione `REPEATABLE READ` sul database primario, seguita da `SET TRANSACTION READ ONLY`. L'opzione Sequelize `readOnly: true` da sola non impone sola lettura SQL e può selezionare una replica: non è usata come garanzia di consistenza. Un pagamento committato durante la lettura non spezza lo snapshot; la richiesta successiva lo vede. Questa consistenza non introduce TTL.

## Riprodurre verifiche e benchmark SQL

Eseguire dalla directory del backend, con dipendenze installate. La suite unitaria non richiede un database:

```text
npm run test:performance:unit
npm run build
```

Le quattro integrazioni richiedono un PostgreSQL locale sacrificabile su `127.0.0.1:5548`, database `rehablo_performance_financial_test`. Il ruolo di test deve poter creare/rimuovere schemi. Nessun database applicativo o proxy remoto è ammesso; i test creano fixture sintetiche in schemi temporanei e li eliminano al termine. Le variabili devono essere esplicitamente valorizzate: senza di esse i relativi test risultano skipped, quindi uno skip non prova la correttezza SQL.

Impostare `PERFORMANCE_TEST_DATABASE_URL` alla connessione del database locale di test e `TEST_FINANCIAL_DATABASE_URL` allo stesso valore. Le credenziali restano fuori dai documenti/log. Esempio PowerShell, dopo aver configurato in locale la prima variabile:

```powershell
$env:TEST_FINANCIAL_DATABASE_URL = $env:PERFORMANCE_TEST_DATABASE_URL
npm run test:performance:integration
npm run performance:reporting
```

`test:performance:integration` comprende dashboard compatto (JSON legacy/ricorrenze/scope), summary SQL (oltre 10.000 righe storiche), residui SQL (parità/scope/paginazione) e snapshot finanziario (writer concorrente e rifiuto delle scritture). Durante la verifica del 10 novembre 2026: 4 superati, 0 falliti, 0 skipped, database sintetico isolato.

`performance:reporting` genera 10.000 documenti, 40.000 pagamenti e 500 pazienti sintetici, confronta il risultato dei residui prima/dopo e riporta campioni, mediana, query, righe e byte trasferiti. Include una misura separata del formatter date su 10.000 valori. Il risultato è un benchmark del servizio/query su dati controllati; non misura HTTP, rete italiana, billing/auth, latenza Render o concorrenza reale. Indici creati nelle fixture appartengono soltanto agli schemi temporanei del benchmark; non sono migrazioni applicate al prodotto.

Raccogliere separatamente il benchmark SQL e la baseline HTTP con gli stessi scenari/volumi. Le prove locali non certificano un obiettivo di p95 in produzione; prima di dichiararlo raggiunto servono baseline dal carico osservato, verifica p50/p95/p99 e tasso errori con telemetria disattiva e attiva.