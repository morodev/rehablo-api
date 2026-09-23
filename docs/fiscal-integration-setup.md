# Integrazione fiscale SDI / Sistema TS — guida all'attivazione

Questo documento descrive **cosa è già implementato nel codice**, **cosa funziona subito senza
alcuna configurazione esterna** e **cosa serve procurarsi dall'esterno** per attivare la
trasmissione reale a SDI (fattura elettronica) e al Sistema Tessera Sanitaria.

> Regola di sicurezza: con `FISCAL_TRANSMISSION_ENABLED=false` (DEFAULT) il sistema usa
> esclusivamente il gateway **MOCK/sandbox**. **Nessun dato reale** viene trasmesso a SDI o
> Sistema TS finché non si completa la checklist di attivazione.

---

## 1. Cosa è già implementato (codice completo, provider-neutral)

Pipeline fiscale interamente costruita e testata (~90 test dedicati):

| Componente | File | Stato |
| --- | --- | --- |
| Motore di instradamento (SDI vs TS vs escluso) | `src/modules/administration/services/fiscalRouting.service.ts` | ✅ |
| Snapshot destinatario congelato sul documento | `src/modules/invoice/utils/recipient.ts` | ✅ |
| Generatore FatturaPA (FPR12) + validazione strutturale | `src/modules/invoice/utils/fatturaPa.ts` | ✅ |
| Mapper fattura → FatturaPA + endpoint download | `src/modules/invoice/utils/invoiceFatturaPa.ts` | ✅ |
| Generatore tracciato Sistema TS + validazione | `src/modules/invoice/utils/sistemaTsTracciato.ts` | ✅ |
| Macchina a stati delle submission | `src/modules/administration/services/fiscalSubmissionState.ts` | ✅ |
| Builder payload reale (SDI/TS) | `src/modules/administration/services/fiscalPayload.ts` | ✅ |
| Contratto gateway v2 + MOCK + StsDirect (guardato) | `src/modules/administration/services/fiscalTransmissionGateway.ts` | ✅ |
| Orchestratore di trasmissione | `src/modules/administration/services/fiscalTransmission.service.ts` | ✅ |
| Factory gateway (env-driven) | `src/modules/administration/services/fiscalGatewayFactory.ts` | ✅ |
| Servizio + endpoint di trasmissione reale (persistenza) | `src/modules/administration/services/fiscalTransmissionRun.service.ts` | ✅ |

Endpoint disponibili:

- `GET  /invoice/:id/fiscal-routing` — anteprima instradamento (canale, motivo, blocchi).
- `GET  /invoice/:id/fattura-pa` — download XML FatturaPA (solo documenti destinati allo SDI).
- `GET  /invoice/export/sistema-ts?year=YYYY` — bozza XML Sistema TS (draft interna).
- `POST /administration/fiscal-submissions/preview` — anteprima simulazione.
- `POST /administration/fiscal-submissions` — simulazione MOCK (registra un esito, nessun invio).
- `POST /administration/fiscal-submissions/transmit` — **trasmissione reale** (gateway pilotato
  dalla configurazione: MOCK finché non abilitata).

## 2. Cosa funziona SUBITO senza configurazione esterna

Con la configurazione di default (`FISCAL_TRANSMISSION_ENABLED=false`):

- generazione e **download dell'XML FatturaPA** dei documenti destinati allo SDI;
- generazione della **bozza XML Sistema TS**;
- **anteprima di instradamento** su ogni fattura;
- **trasmissione end-to-end in modalità MOCK**: la submission viene creata e fatta avanzare nella
  macchina a stati (`QUEUED → VALIDATING → SUBMITTED → ACCEPTED/REJECTED`), con protocollo
  sandbox, visibile nella dashboard Invii fiscali. Nessun dato lascia il gestionale.

Questo permette di collaudare l'intero flusso (interfaccia, permessi, stati, idempotenza) senza
credenziali reali.

## 3. Cosa serve DALL'ESTERNO per l'invio reale

Queste cose **non sono producibili via codice**: vanno procurate.

### 3.1 Sistema Tessera Sanitaria (obbligo per prestazioni sanitarie a persone fisiche)

1. **Credenziali del portale Sistema TS** dello studio/professionista (username, password) e il
   **PINCODE** di autenticazione — si ottengono accreditandosi su
   <https://sistemats1.sanita.finanze.it> con la P.IVA/CF del soggetto.
2. **Tracciato record e XSD ufficiali** dell'anno fiscale di competenza (scaricabili dal portale):
   i codici "Tipologia di spesa" e la struttura possono cambiare ogni anno.
3. **Endpoint del web service** di invio/esito dell'anno vigente.

Cosa resta da completare nel codice una volta ottenute:
- corpo di `StsDirectGateway.transmit` (firma/autenticazione del pacchetto e chiamata HTTP reale)
  in `fiscalTransmissionGateway.ts` — il descrittore di richiesta è già costruito;
- adattamento di `parseStsResponse` al tracciato di esito ufficiale;
- validazione dell'XML generato contro l'XSD ufficiale (vedi §3.3);
- affinamento di **data pagamento** e **tracciabilità** per il tracciato TS: oggi il servizio usa
  la data di emissione e `tracciabile=true` come segnaposto (vedi `fiscalTransmissionRun.service.ts`),
  vanno aggregati i movimenti reali (`InvoicePayment`).

### 3.2 SDI / Fattura elettronica (per B2B, o B2C di sole voci NON sanitarie)

Due strade alternative:

- **Provider/intermediario** (Aruba, TeamSystem/Agyo, Fatture in Cloud, Namirial, InfoCert…):
  serve un **account** con **endpoint API** e **API key/credenziali**. Il provider gestisce firma,
  canale accreditato, ricezione ricevute (RC/MC/NS/NE) e **conservazione a norma**.
  Cosa resta da fare nel codice: implementare l'adapter provider al posto del segnaposto
  `UnavailableGateway` in `fiscalGatewayFactory.ts` (canale `SDI`, `sdiProvider='PROVIDER'`).
- **Canale proprio accreditato** (SDICoop/SDIFTP): richiede accreditamento presso l'Agenzia delle
  Entrate, un **certificato di firma** da una CA/QTSP, un **endpoint web service pubblico** per
  ricevere le notifiche e la **conservazione a norma**. Più oneroso, ma senza fee a fattura.

In entrambi i casi serve comunque un **certificato di firma digitale** (CAdES `.p7m`) emesso da un
prestatore qualificato.

### 3.3 Validazione XSD ufficiale (entrambi i canali)

La validazione attuale è **strutturale interna** (obbligatorietà/formati). Per la produzione va
aggiunta la validazione contro gli XSD ufficiali:
- FatturaPA: `Schema_VFPR12.xsd` (specifiche tecniche Agenzia delle Entrate);
- Sistema TS: XSD del tracciato "Spese Sanitarie" dell'anno.

Va scelto un validatore XSD (es. `libxmljs`); attenzione alle build native su Windows.

## 4. Variabili d'ambiente

| Variabile | Default | Significato |
| --- | --- | --- |
| `FISCAL_TRANSMISSION_ENABLED` | `false` | Interruttore generale. `false` = solo MOCK/sandbox, nessun invio reale. |
| `FISCAL_SDI_PROVIDER` | `MOCK` | Canale SDI: `MOCK` (sandbox) o `PROVIDER` (intermediario reale). |
| `FISCAL_SDI_ENDPOINT` | _(vuoto)_ | Endpoint API del provider SDI. |
| `FISCAL_SDI_API_KEY` | _(vuoto)_ | API key/credenziale del provider SDI. |
| `FISCAL_STS_ENDPOINT` | _(vuoto)_ | Endpoint del web service Sistema TS. |
| `FISCAL_STS_USERNAME` | _(vuoto)_ | Username del portale Sistema TS dello studio. |
| `FISCAL_STS_PASSWORD` | _(vuoto)_ | Password del portale Sistema TS. |
| `FISCAL_STS_PINCODE` | _(vuoto)_ | PINCODE di autenticazione Sistema TS. |
| `FISCAL_STS_LIVE` | `false` | Abilita l'invio reale al Sistema TS (richiede credenziali complete). |

> Nota sicurezza: le credenziali Sistema TS sono **per-studio**. In un ambiente multi-tenant di
> produzione vanno spostate dalle variabili globali a **impostazioni per-tenant cifrate**
> (esiste già `src/modules/measurements/utils/credentialCrypto.ts`, AES-256-GCM, riusabile).
> I valori globali qui servono per un **singolo tenant pilota**.

## 5. Checklist di attivazione

1. **Fase 0 — Compliance/provider:** scegliere il provider SDI (o il canale proprio) e verificare i
   requisiti Sistema TS con il consulente fiscale.
2. Procurarsi credenziali sandbox e i **tracciati/XSD ufficiali** dell'anno.
3. Implementare gli adapter reali mancanti (`StsDirectGateway.transmit`, adapter provider SDI) e la
   validazione XSD.
4. Spostare le credenziali TS su **impostazioni per-tenant cifrate**.
5. Collaudare in **sandbox** end-to-end (invio, ricevute, scarti, retry, idempotenza).
6. Attivare su un **tenant pilota**: `FISCAL_TRANSMISSION_ENABLED=true`, credenziali reali,
   `FISCAL_STS_LIVE=true` (e/o `FISCAL_SDI_PROVIDER=PROVIDER`).
7. Monitorare esiti, audit e riconciliazioni; poi estendere agli altri tenant.

Finché la checklist non è completa, il sistema resta operativo in modalità MOCK/sandbox senza
alcun rischio di trasmissioni reali involontarie.
