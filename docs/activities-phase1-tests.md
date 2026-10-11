# Test Attività: contratti e persistenza

Le suite Attività usano `node:test`/`tsx`, come il backend esistente. I test unitari non si connettono al database. I test di integrazione verificano l'API Express e le migrazioni contro PostgreSQL reale.

## Comandi

Da `rehablo-api`, con le dipendenze installate:

```powershell
npm.cmd run lint
npm.cmd run build
npm.cmd run test:activities:unit
npm.cmd run test:activities:integration
```

Il comando di integrazione richiede `TEST_ACTIVITIES_DATABASE_URL`. Non usa `DATABASE_URL` come fallback e non avvia Docker, il server applicativo o scheduler.

## PostgreSQL isolato

Usare esclusivamente un database sacrificabile dedicato, con nome `<prefix>_activities_test` oppure `<prefix>_activities_test_<run>` e privilegi per creare schemi, tabelle, vincoli, funzioni e trigger. Il guard rifiuta nomi ordinari e l'endpoint/database di `DATABASE_URL`, anche con credenziali differenti. L'URL ordinario resta invariato nella shell; il harness imposta quello di test internamente, dopo i controlli e prima di importare i modelli.

Esempio locale con PostgreSQL 16 e credenziali esclusivamente di test:

```powershell
docker run --name rehablo-activities-tests --rm -d -p 127.0.0.1:55432:5432 -e POSTGRES_DB=rehablo_activities_test -e POSTGRES_USER=activities_test -e POSTGRES_PASSWORD=activities-local-tests-only postgres:16-alpine
docker exec rehablo-activities-tests pg_isready -U activities_test -d rehablo_activities_test
$env:TEST_ACTIVITIES_DATABASE_URL = 'postgres://activities_test:activities-local-tests-only@127.0.0.1:55432/rehablo_activities_test'
npm.cmd run test:activities:integration
docker stop rehablo-activities-tests
Remove-Item Env:TEST_ACTIVITIES_DATABASE_URL
```

Attendere l'esito positivo di `pg_isready` prima del test. Il container è rimosso da `--rm` quando viene fermato. Non riutilizzare credenziali reali né un database applicativo per questo esempio. In CI fornire un servizio PostgreSQL dedicato e lo stesso URL esplicito; non serve installare `psql` sull'host.

## Copertura e isolamento

Il harness monta il router Attività e il router Auth completo, inclusi i controller e i middleware reali di accesso, Team e creazione sede, in un'app Express dedicata su una porta locale temporanea. Non importa `server.ts` e non avvia worker, SMTP o push. Esegue il bootstrap reale dei modelli pubblici e tenant e predispone i modelli pubblici necessari al calendario; verifica inoltre `current_database()` dopo la connessione.

Le fixture comprendono due tenant, due sedi nel primo tenant e una nel secondo, con utenti OWNER, THERAPIST e VIEWER. I JWT sono firmati con una chiave casuale del solo processo di test e contengono volutamente claim privilegiati: l'API deve ricontrollare appartenenze e ruolo nel database. Il ruolo calendario dell'assegnatario non determina l'idoneità alle attività.

I test verificano:

- Board univoca per sede, bootstrap nuovo tenant e upgrade additivo che preserva note/promemoria.
- Lock della migrazione tra due connessioni PostgreSQL e rollback reale del DDL.
- CLI reale con `TENANT_SCHEMA_SYNC=off`: check senza scritture, apply, verifica finale, riapplicazione idempotente e rifiuto di schemi inesistenti; HTTP segnala la migrazione mancante senza DDL.
- Isolamento tra tenant/sedi, token paziente, appartenenza mancante, sospensione e policy creator/assignee.
- Creazione atomica dei campi principali, assegnazioni e checklist iniziale; rifiuto di input extra e collegamenti non accessibili.
- Date UTC e civili, scadenze passate, all-day oggi, DST e modifica di un'attività storicamente scaduta.
- Configurazione esplicita dell'avviso, validazioni e disattivazione; nessuna consegna esterna nella fase 1.
- Idempotenza persistente, richieste duplicate concorrenti, conflitti core/ordine e rollback di tutte le scritture quando fallisce la cronologia.
- Spostamenti con anchor, revisioni indipendenti, archivio/ripristino, conteggi e cursori legati a query/sede/snapshot/evaluationAt.
- Compattazione con un gap esaurito, compresa una posizione finale uguale al valore precedente della scheda spostata.
- Creazione sede con board, disponibilità e membership nella stessa transazione; fallimento reale dell'insert board senza record parziali.
- Vincoli PostgreSQL sulle combinazioni di scadenza e sulle posizioni attive.

Ogni esecuzione genera UUID propri e pulisce esclusivamente i relativi schemi e record pubblici. Il test upgrade rimuove e ricrea le sole tabelle Attività del tenant fixture; il test rollback installa temporaneamente un trigger nel relativo schema. Anche se il processo viene interrotto prima della pulizia, il database resta quello sacrificabile di test: eliminarlo insieme al servizio dedicato.

I comandi esistenti `npm.cmd test` e `npm.cmd run test:reminders` restano disponibili per la regressione del backend. La suite DB è separata per richiedere esplicitamente il servizio PostgreSQL; il suo risultato va riportato insieme alla verifica unitaria della fase 1.

## Verifica della fase 1 — 11 ottobre 2026

- `test:activities:unit`: 34 test superati.
- `test:activities:integration`: 28 test superati su PostgreSQL 16 isolato, inclusi CLI manuale, compattazione e rollback della nuova sede con messaggio comprensibile.
- `npm test`: 488 test esistenti superati.
- `test:reminders`: 7 test superati.
- Compilazione backend e build Angular in configurazione development: superate.

Questa verifica riguarda contratti e persistenza. L'interfaccia Attività, le modifiche collaborative e la consegna degli avvisi saranno verificate nelle rispettive fasi.

## Fase 2: metadati dei collegamenti e lookup

La stessa suite PostgreSQL include le verifiche dei metadati `links` restituiti dal dettaglio. Il paziente espone soltanto `id` e `displayName`; l'appuntamento espone `id`, `title`, `start`, `allDay` e `isRecurring`. Il backend rilegge le risorse nello schema tenant e nella sede corrente, con l'ACL della risorsa ricavata dalle appartenenze attuali nel database. Nomi cambiati vengono aggiornati anche quando la versione dell'attività resta invariata. Risorse archiviate, eliminate, spostate o non più accessibili non espongono ID né metadati nel dettaglio.

I lookup `GET /activities/patients` e `GET /activities/agenda-events` sono indipendenti dalla cache dell'anagrafica e dalla finestra caricata in agenda. Accettano `query`, `offset` e `limit` (20 per default, massimo 50); l'agenda accetta anche `patientId`. Restituiscono `{items,total,nextOffset}`, sempre nella sede selezionata e con i permessi correnti. I pazienti sono cercati per nome/cognome, con esclusione degli archiviati. Gli appuntamenti sono cercati per titolo/data e restituiscono soltanto record persistiti: non espandono le ricorrenze in ID virtuali. Una ricerca per data civile segue `Europe/Rome`, compreso il formato `gg/mm/aaaa`. I caratteri `%` e `_` sono interpretati letteralmente.

Per eseguire queste verifiche utilizzare gli stessi comandi precedenti; l'integrazione continua a richiedere esclusivamente `TEST_ACTIVITIES_DATABASE_URL` per un database dedicato. Il harness crea e ripulisce i propri schemi di fixture senza avviare il server applicativo o scheduler.

Verifica del backend della fase 2 — 11 ottobre 2026:

- Compilazione backend con metadati e lookup dedicati: superata.
- `test:activities:integration`: 39 test superati su PostgreSQL 16 isolato, inclusi metadati, lookup e mantenimento dei canali dell'avviso.
- `test:activities:unit`: 34 test superati.
- Regressioni unitarie selezionate: 27 test superati su accesso ai promemoria, policy di consegna, ricerca agenda, helper di ricerca e migrazioni tenant con connessioni simulate.
- Suite frontend combinata: 153 test superati su Attività, guard di accesso/selezione sede, permessi, conferme e regressioni Note/promemoria, incluso il recupero idempotente e il cambio sede dopo commit.

I cinque casi PostgreSQL sui lookup verificano paginazione e DTO minimi, isolamento tenant/sede, ACL calendario `own` aggiornata e sospensione, filtri paziente autorizzati, ricerca letterale/date civili e rifiuto dei parametri malformati. Gli avvisi restano configurati e persistiti: nessun test della fase 2 avvia consegne, scheduler o endpoint feed.

## Fase 3: collaborazione e modifiche del Team

`npm.cmd run test:activities:integration` esegue tutte le suite `*.integration.test.ts` nella directory `src/modules/activities/tests`. Il runner scopre i file con `readdirSync`, li ordina ed esegue `tsx --test --test-concurrency=1`, evitando dipendenze dall'espansione dei glob della shell Windows. Ogni suite crea le proprie fixture e le ripulisce prima della successiva; il guard del database rimane obbligatorio per l'intero comando.

Le verifiche della collaborazione coprono:

- Creazione, aggiornamento, cancellazione e riordino della checklist, con revisione aggregata distinta dalle versioni dei singoli elementi e dalla versione principale dell'attività.
- Aggiornamenti concorrenti di elementi diversi, conflitti sullo stesso elemento e revisioni aggregate obsolete.
- Compattazione con gap esaurito e posizione finale uguale alla precedente del record spostato, senza collisioni del vincolo PostgreSQL.
- Commenti dell'autore e moderazione OWNER/SECRETARY con permessi riletti nel database; attività completate commentabili e attività archiviate protette dalle scritture dei figli.
- Cancellazione dei commenti con `text: null`, conservazione dell'autore e dell'ordine, ricevute e cronologia prive del testo dei figli; replay che restituisce lo stato corrente anche dopo la cancellazione.
- Cursori firmati per commenti e cronologia, finestre da 20 a 40 elementi senza duplicati con timestamp uguali, invalidazione dopo una modifica e compatibilità del vecchio parametro `offset` della cronologia.
- Nomi storici conservati e metadato `eligible` aggiornato per autori e attori della cronologia dopo downgrade del ruolo, sospensione nel tenant o rimozione dalla sede. L'idoneità richiede identità attiva, membership attiva, accesso alla sede e ruolo operativo; la verifica email non equivale a sospensione.
- Rollback atomico di figlio, revisioni, cronologia e ricevuta quando un trigger di test rifiuta l'inserimento della cronologia.

Le verifiche Team coprono preflight per sede, scelte indipendenti per agenda e attività, conservazione degli altri assegnatari idonei, sostituzione delle sole attività orfane, sospensione degli avvisi e cancellazione delle consegne pendenti o in lavorazione. Il gate transazionale tenant e l'ordine dei lock proteggono la gara tra assegnazione e offboarding; fingerprint e permessi sono ricontrollati prima di applicare la modifica. I casi includono ruolo, override locale, sedi, profilo, sospensione e rimozione, replay della rimozione, rifiuto di un amministratore non più autorizzato, rollback della cronologia e tutela dell'ultimo OWNER realmente attivo. I salvataggi che cambiano insieme ruolo e abilitazione del calendario applicano una sola volta le decisioni di riassegnazione già approvate.

La suite Auth usa il router reale: login con password, scelta dello studio, selezione sede, `/auth/me` e accesso alla bacheca; recupero di un token di selezione scaduto; rifiuto del contesto di un tenant estraneo. Il processo rimane l'app Express del harness: non carica l'avvio applicativo e non invoca worker, scheduler o canali di consegna. Le consegne create dalle fixture Team servono esclusivamente a verificare la cancellazione transazionale delle righe persistite.

Verifica del backend della fase 3 — 11 ottobre 2026:

- `test:activities:integration`: 80 test superati su PostgreSQL 16 isolato, comprendenti 39 verifiche delle fasi precedenti, 13 di collaborazione, 25 Team e 3 Auth.
- `test:activities:unit`: 42 test superati, inclusi validazione dei figli, firma, vincoli e durata dei cursori.
- `npm test`: 488 regressioni esistenti superate.
- Verifica TypeScript e compilazione backend: superate.

I risultati dell'interfaccia Angular e delle verifiche nel browser sono riportati nella documentazione del frontend; i comandi qui descritti verificano i contratti e la persistenza del backend.

## Fase 4: consegne, consensi, feed e integrazioni

La suite PostgreSQL comprende le API del feed reale, il riepilogo delle dashboard, i collegamenti contestuali e 17 verifiche dedicate alle consegne. Il harness monta il router delle preferenze prima delle rotte con ID attività, usa le migrazioni pubbliche e tenant effettive ed esegue i worker soltanto attraverso un tick esplicito con trasporto simulato. Nessun test invia email o push reali, né avvia lo scheduler applicativo o si collega al database ordinario.

La baseline tenant è v15. La migrazione pubblica introduce la preferenza personale email Attività, inizialmente disabilitata, e consensi distinti sul dispositivo condiviso: i promemoria esistenti restano abilitati, le Attività partono disabilitate. Il timestamp di adesione impedisce gli invii arretrati dopo un nuovo consenso. I vecchi endpoint promemoria continuano a funzionare e modificano soltanto quel dominio; il logout rimuove entrambi i domini dal proprio dispositivo, anche dopo un cambio profilo.

La migrazione tenant aggiunge il registro di attivazione e ricevute per singolo dispositivo, conservando il registro di consegna già esistente. Le migrazioni non scrivono alcuna attivazione e non materializzano o inviano avvisi. L'istante di attivazione viene stabilito nel runtime prima dell'apertura HTTP, durante il provisioning e prima del primo avviso. Gli avvisi antecedenti a quell'istante richiedono una nuova programmazione; eventuali ricevute ancora pendenti sono annullate. Gli avvisi programmati successivamente restano recuperabili dopo un'interruzione. Un destinatario aggiunto dopo l'istante programmato non viene arruolato retroattivamente.

Il worker usa intervalli di 60 secondi, batch da 50, fino a cinque invii concorrenti, lease da 120 secondi e timeout provider da 20 secondi. Ogni dispositivo rinnova il lease con l'ora corrente prima dell'invio. La scadenza di un lease senza avvio del trasporto consente il recupero; una ricevuta il cui invio è stato avviato conserva l'esito incerto e non viene reinviata automaticamente. Sono previste al massimo cinque prove per errori certamente ripetibili, con attese di 1, 2, 4 e 8 minuti.

Assegnazione, permessi correnti, programmazione, consenso e proprietà del dispositivo sono riletti prima dell'invio. Le chiamate ai provider avvengono fuori dalle transazioni. Le risposte tardive sono subordinate al token del lease: completamento, archivio, nuova programmazione e offboarding possono annullare le ricevute aperte o incerte senza essere sovrascritti da un successivo esito del provider. Le ricevute già consegnate e i dispositivi già raggiunti restano conservati; un dispositivo che fallisce non causa il reinvio agli altri. Le Attività non usano il fallback email dei promemoria.

Il feed in app mantiene gli avvisi effettivamente consegnati anche dopo completamento, archivio o nuova programmazione dell'attività. Lettura e accesso vengono verificati nella sede corrente; il titolo deriva dall'attività corrente e non è memorizzato nei messaggi esterni. Email e push contengono esclusivamente testo generico e una destinazione contestuale. Gli errori registrati sono codici diagnostici, senza testo dell'attività, dati del paziente o errori grezzi dei provider.

Verifica del backend della fase 4 — 11 ottobre 2026:

- `test:activities:integration`: 107 test superati su PostgreSQL 16 isolato, inclusi 17 casi di consegna e le regressioni delle fasi precedenti.
- Suite di consegna ripetuta dopo l'ultimo controllo sul logout: 17 test superati.
- `test:activities:unit`: 46 test superati, inclusa la policy di retry, consensi ed esiti per dispositivo.
- `npm test`: 488 regressioni esistenti superate; 12 casi di migrazione tenant verificati anche separatamente.
- Verifica TypeScript e compilazione backend finale: superate.
- Runner reale `migrate:activities --check`, `--apply`, `--check`: superato nel database isolato, verificando contratti pubblici e tenant e baseline v15. Le righe e gli istanti di attivazione sono rimasti identici; il tenant mai attivato è rimasto privo di attivazione.

La suite include concorrenza tra worker, backlog iniziale con ricevuta pendente, recupero dopo interruzione, timeout ambiguo, revoca di ruolo e consenso, cancellazione durante I/O, riassegnazione dopo l'orario dell'avviso e sette dispositivi con invio simulato superiore a due minuti. Quest'ultimo caso verifica che un secondo worker non recuperi prematuramente un lease ancora rinnovato.

Per gli ambienti con sync tenant disattivato, eseguire prima il runner di migrazione e controllare la disponibilità dello schema; il runner non attiva le consegne. Nel runtime ordinario le consegne sono abilitate per impostazione iniziale e possono essere sospese con `ACTIVITIES_DELIVERY_ENABLED=false`. Nei processi di test sono disabilitate, salvo il tick esplicito e isolato delle fixture. La verifica dei provider riguarda i contratti e i trasporti simulati; l'invio effettivo richiede le configurazioni SMTP/VAPID disponibili nell'ambiente di esecuzione.
