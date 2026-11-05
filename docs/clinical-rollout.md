# Modulo clinico condiviso

Il contratto HTTP è in [clinical-api.openapi.json](clinical-api.openapi.json). Il modulo è aggiuntivo: `Tenant.featureFlags.clinical.enabled`, `medicalEnabled` e `trainingEnabled` sono falsi in assenza di configurazione. L'abilitazione è esplicita da parte del titolare del centro; i flag non modificano selezioni, bozze o flussi delle valutazioni ordinarie senza percorso.

## Regole applicate

- Ogni richiesta staff verifica utente attivo, appartenenza attuale a tenant e sede selezionata, ruolo e membership esplicita al percorso. Essere titolare non dà accesso automatico a tutti i percorsi. La revoca della membership vale anche per i contributi propri; il livello operativo non legge contenuti clinici propri precedenti.
- I contributi di altri professionisti sono leggibili se confermati o appartenenti a una valutazione completata, nei limiti della visibilità. Il PT usa il livello operativo. `clinicalVisibility` conserva il livello della valutazione: dopo un downgrade, una valutazione clinica precedente non diventa operativa.
- I risultati giornalieri richiedono una valutazione propria, `DRAFT`, creata oggi. Conferma e passaggio di giornata mantengono il blocco esistente. La rivalutazione crea una nuova valutazione con riferimenti e configurazione, senza copiare risultati, attività eseguite o allegati. Il clone ordinario rimane distinto.
- Problemi e obiettivi sono longitudinali; gli altri contributi iniziano in bozza. Programmi, referti e prescrizioni confermati richiedono una nuova revisione. Una seduta conserva lo snapshot della versione programmata; alla conferma le attività senza risultato restano `NOT_RECORDED`.
- `expectedVersion` evita sovrascritture concorrenti. Le creazioni e i comandi con `operationId` UUID conservano una ricevuta nella stessa transazione: lo stesso comando non duplica dati, un payload differente con la stessa chiave produce conflitto.
- Una rilevazione non raccolta non crea una misura. Uno zero esplicito è distinto dall'assenza. I valori quantitativi sono `Observation` canoniche, collegate al finding. Correzioni di bozze conservano la misura precedente, marcandola non valida con motivo di sostituzione. Un'osservazione importata collegata non viene duplicata o sovrascritta.
- Il lato non specificato usa `UNSPECIFIED` solo per le nuove misure cliniche; il lato originale resta nei metadata. I default e i dati storici delle misure ordinarie restano invariati. Il confronto separa parametro, unità, lato, metodo, protocollo/versione e provenienza.
- Documenti e media restano privati, con verifica del contenuto e download autenticato. La revisione documentale conserva i metadata del file originale. La pubblicazione al paziente è un'azione esplicita sulla versione confermata di programma, documento o referto. Il feedback a domicilio è dichiarato dal paziente e non diventa un risultato professionale.
- Con il flag disabilitato le scritture cliniche cessano e lo storico autorizzato resta consultabile. Revocare una membership rimane possibile anche con percorso concluso o modulo disabilitato, per rimuovere l'accesso allo storico.

## Migrazione e distribuzione

La release `202611050001-clinical-workspace.js` aggiunge nove tabelle tenant, colonne nullable di collegamento sulle valutazioni, `human_body_areas.evaluationId/symptom`, `user_scale_instances.humanBodyPointId`, `test_instances.humanBodyPointId/testSnapshot`, l'etichetta `UNSPECIFIED` dell'enum Observation e il ruolo `PERSONAL_TRAINER` agli enum pubblici. La gravità dei sintomi può essere null; non vengono aggiornati i valori storici. Le nuove relazioni conservano i dati e non introducono cancellazioni a cascata. Provisioning dei nuovi tenant e riconciliazione dei tenant creati dalla versione precedente usano la stessa migrazione.

La normale procedura di distribuzione del repository richiede build, `db:migrate`, controllo readiness e avvio. Questa implementazione non ha eseguito migrazioni sull'ambiente corrente. Prima della distribuzione verificare la release su un PostgreSQL isolato, con dati fittizi: migrazione ripetuta, nuovo tenant, riconciliazione, concorrenza, isolamento fra sedi, passaggio di giornata e pubblicazione/revoca. Il test runner esistente accetta soltanto `TEST_MIGRATIONS_DATABASE_URL` locale dedicato e non ripiega sul database ordinario.

Il ritorno operativo è la disabilitazione dei flag. La migration `down` rifiuta di eliminare dati clinici; la versione precedente del backend deve essere valutata rispetto alle regole di readiness e provisioning, non avviata forzando i controlli.

## Verifica automatica

I test in `src/modules/clinical/tests` verificano policy, ACL correnti, lock giornaliero, snapshot delle sedute, versioni dei programmi, idempotenza, assenza/zero, riuso delle misure importate, revisione documentale, flag on/off e query di migrazione. I test di migrazione senza PostgreSQL verificano sequenza, marcatori, idempotenza, provisioning e rifiuto di schemi invalidi; non sostituiscono l'esecuzione reale del DDL.

Comandi: `npm run lint`, `npm run test:clinical`, `npm run test:database`, `npm run build`. I test legacy dedicati a valutazioni, misure e body map restano separati. La verifica visuale del frontend e i test E2E con un ambiente migrato sono controlli distinti dai test unitari.

## Integrazioni successive: piano separato

Le capability `ai`, `dictation` e `directDevices` restano false. Le interfacce `ClinicalExtractionAdapter`, `ClinicalIntegrationProposal` e `ClinicalDeviceAdapter` descrivono il confine futuro, senza attivare provider, chiamate esterne o completamenti clinici automatici.

1. **Importazione assistita di documenti e referti.** Definire formati e provider, conservare originale e versione dell'estrattore, proporre campi con fonte e stato `PENDING`. La revisione umana accetta o rifiuta ogni proposta prima di creare dati clinici. Una proposta non completa una diagnosi o una misurazione.
2. **Dettatura e sintesi.** Definire consenso, registrazione, conservazione e trattamento dei dati. Mostrare trascrizione e modifiche proposte prima della conferma. Non trasformare omissioni o negazioni in risultati precompilati.
3. **Dispositivi diretti.** Definire contratto per dispositivo, mapping unità/lati/protocolli, credenziali tenant, deduplicazione dell'acquisizione e test con payload reali anonimizzati. Ogni risultato entra nell'ingestion canonica `Observation`, con file e provenienza verificabili.
4. **Abilitazione controllata.** Ogni connettore richiede flag dedicato, test di autorizzazione/revoca, osservabilità priva di contenuto clinico nei log e percorso di disattivazione che lasci consultabile lo storico.

Prescrizioni elettroniche pubbliche, telemedicina, elaborazione video automatica, OCR e diagnosi automatica non sono implementati da questo rilascio.