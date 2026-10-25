# Prezzo della singola seduta e verifica dello storico

PATCH /agenda-event/:agendaEventId/pricing conserva sconto e omaggio e accetta:

- baseAmount (numero opzionale): definisce solo un prezzo mancante, come totale concordato con il paziente. Un prezzo già presente viene protetto da HTTP 409.
- confirmHistory (booleano opzionale): conferma esplicitamente che gli incassi precedenti sono stati verificati. La sua assenza conserva lo storico incerto.

I metadati pricing delle letture dei movimenti e della posizione paziente espongono historyKnown. Il salvataggio del prezzo non crea un incasso e non modifica la presenza. Incassi esistenti, anche annullati, restano autorevoli; le sedute con storico ancora incerto non diventano debiti certi né nuovi obiettivi di incasso.

Gli stessi vincoli valgono per il prezzo incluso negli incassi e nei saldi del paziente. Restano i controlli su permessi, sede, fatture collegate, pacchetti e ricorrenze.

Rilasciare prima il backend e poi il frontend. Non occorrono migrazioni o modifiche massive dei dati.

Verifiche: npm run test:appointment-pricing e npm run test:appointment-pricing:integration. Per la seconda suite impostare TEST_ACTIVITIES_DATABASE_URL su un database PostgreSQL dedicato con nome <prefisso>_activities_test o <prefisso>_activities_test_<esecuzione>, diverso da DATABASE_URL. La suite verifica l'isolamento prima di inizializzare la connessione e rimuove solo il proprio schema temporaneo.
