# Regime fiscale (Italia) e impatti sulla fatturazione

> Ricerca di dominio propedeutica all'introduzione del campo **regime fiscale** nei dati aziendali
> (`tenants`) e alle regole che ne derivano in fase di emissione documento.
>
> Ambito: fisioterapisti e altri professionisti sanitari, studi associati/STP, centri e poliambulatori
> privati che operano in Italia. **Non è consulenza fiscale**: le regole vanno confermate dal
> commercialista dello studio e verificate a ogni legge di bilancio.

---

## 1. Perché serve il campo "regime fiscale"

Il regime fiscale del soggetto emittente **non è un dato anagrafico decorativo**: determina, in modo
deterministico, come deve essere costruito il documento. In particolare decide:

| Cosa determina | Esempio pratico |
| --- | --- |
| Se in fattura si espone l'IVA | Un forfettario non addebita **mai** IVA, nemmeno sulla vendita di un tutore |
| Quale "natura" indicare al posto dell'aliquota | `N2.2` (forfettario) vs `N4` (esente art. 10) |
| Se è ammessa la ritenuta d'acconto | Il forfettario **non subisce** ritenuta |
| Se scatta la marca da bollo da 2,00 € | Dovuta su documenti senza IVA sopra 77,47 € |
| Quali diciture obbligatorie stampare | Richiamo a L. 190/2014 c. 54-89 e c. 67 |
| Il codice `RegimeFiscale` (1.2.1.8) della FatturaPA | `RF01`, `RF19`, … obbligatorio nell'XML |

Senza questo dato il software può solo indovinare, e ogni "indovinato" produce un documento
fiscalmente sbagliato che il paziente ha già in mano.

---

## 2. I codici regime fiscale (tabella FatturaPA)

Sono i valori ammessi dal tracciato della fattura elettronica (blocco `CedentePrestatore /
DatiAnagrafici / RegimeFiscale`). Quelli realisticamente incontrati nel settore riabilitativo sono
evidenziati.

| Codice | Descrizione | Rilevanza settore |
| --- | --- | --- |
| **RF01** | Ordinario | ★ Il caso più comune: studi strutturati, SRL, STP, poliambulatori |
| RF02 | Contribuenti minimi (art. 1, c. 96-117, L. 244/2007) | Residuale, regime chiuso alle nuove adesioni |
| RF04 | Agricoltura e attività connesse e pesca | — |
| RF05 | Vendita sali e tabacchi | — |
| RF06 | Commercio dei fiammiferi | — |
| RF07 | Editoria | — |
| RF08 | Gestione di servizi di telefonia pubblica | — |
| RF09 | Rivendita di documenti di trasporto pubblico e di sosta | — |
| RF10 | Intrattenimenti, giochi e altre attività (tariffa allegata al DPR 640/72) | — |
| RF11 | Agenzie di viaggi e turismo (art. 74-ter DPR 633/72) | — |
| RF12 | Agriturismo | — |
| RF13 | Vendite a domicilio | — |
| RF14 | Rivendita di beni usati, oggetti d'arte, d'antiquariato o da collezione | — |
| RF15 | Agenzie di vendite all'asta di oggetti d'arte, antiquariato o da collezione | — |
| RF16 | IVA per cassa P.A. (art. 6, c. 5, DPR 633/72) | Raro: centri convenzionati con enti pubblici |
| RF17 | IVA per cassa (art. 32-bis DL 83/2012) | ★ Possibile: l'IVA diventa esigibile all'incasso |
| RF18 | Altro | Usato da enti non commerciali / ASD-SSD in regime L. 398/1991 |
| **RF19** | Regime forfettario (art. 1, c. 54-89, L. 190/2014) | ★★ Diffusissimo tra i liberi professionisti |

Il software deve permettere di selezionare almeno **RF01, RF02, RF16, RF17, RF18, RF19** e memorizzare
il codice così com'è, perché è il valore che finirà nell'XML se e quando si attiverà la fatturazione
elettronica per le righe non sanitarie.

---

## 3. I due scenari che coprono il 95% dei casi

### 3.1 Regime ordinario (RF01) + prestazione sanitaria

Il fisioterapista **iscritto all'albo** (Ordine TSRM-PSTRP) che eroga prestazioni di diagnosi, cura e
riabilitazione alla persona rientra nell'**esenzione IVA dell'art. 10, n. 18, DPR 633/1972**.

- IVA in fattura: **nessuna**, ma l'operazione è "esente", non "fuori campo".
- Natura da indicare: **`N4` – operazioni esenti**.
- Dicitura consigliata: *"Operazione esente da IVA ai sensi dell'art. 10, n. 18, DPR 633/1972"*.
- Marca da bollo **2,00 €** se il totale del documento senza IVA supera **77,47 €**.
- Ritenuta d'acconto **20%** (art. 25 DPR 600/1973) **solo** se il committente è sostituto d'imposta
  (azienda, ente, altro professionista) — quindi **quasi mai** quando si fattura a un paziente privato.

> ⚠️ Attenzione al perimetro dell'esenzione: sono esenti le prestazioni con **finalità di cura**.
> Massaggi benessere, personal training, corsi di ginnastica posturale "wellness", noleggio
> attrezzature e **vendita di prodotti** (tutori, plantari, integratori) seguono le regole ordinarie
> e scontano l'IVA (22%, o 4%/10% per specifici dispositivi/ausili). Una fattura può quindi essere
> **mista**: righe esenti N4 + righe con IVA. Il software deve gestire il caso per riga, come già fa
> con `productVat`.

Conseguenza gestionale del "misto": chi effettua sia operazioni esenti sia imponibili subisce il
**pro-rata di detraibilità IVA** (art. 19-bis DPR 633/72). Non impatta il documento emesso, ma è un
motivo in più per tenere separate le righe sanitarie da quelle commerciali.

### 3.2 Regime forfettario (RF19)

Regime naturale per molti liberi professionisti sotto la soglia di ricavi/compensi (85.000 € dal
2023, con uscita immediata oltre 100.000 €). Coefficiente di redditività per le professioni: 78%.

- IVA in fattura: **mai**, in nessun caso, nemmeno sui prodotti.
- Natura da indicare: **`N2.2` – non soggette / altri casi**. **Non** `N4`: il forfettario è "non
  soggetto" per effetto del regime, e questo prevale sull'esenzione art. 10.
- Dicitura obbligatoria: *"Operazione effettuata ai sensi dell'art. 1, commi 54-89, della Legge n.
  190/2014 e successive modificazioni/integrazioni"*.
- Ritenuta d'acconto: **non si applica**. Dicitura: *"Operazione non soggetta a ritenuta d'acconto ai
  sensi dell'art. 1, comma 67, della Legge n. 190/2014"*. Il forfettario, inoltre, **non è sostituto
  d'imposta**.
- Marca da bollo **2,00 €** oltre 77,47 €: dovuta (è documento senza IVA).
- Rivalsa INPS 4% (Gestione Separata): **addebitabile**, e concorre al reddito imponibile forfettario.

### 3.3 Centri, poliambulatori, STP e società

- Forma societaria (SRL/SRLS/STP/SNC) ⇒ **RF01**: il forfettario è precluso alle società.
- Le prestazioni sanitarie restano esenti IVA (art. 10 n. 18 per la prestazione professionale;
  art. 10 n. 19 per ricovero e cura da parte di enti ospedalieri, cliniche e case di cura
  convenzionate).
- **Riscossione accentrata (art. 2, c. 38-39, DL 248/2007)**: la struttura sanitaria privata che
  ospita professionisti deve **riscuotere il compenso in nome e per conto** del professionista,
  registrarlo e comunicarlo telematicamente. Dal punto di vista software significa poter emettere un
  documento in cui **l'emittente è il professionista** ma **l'incasso è della struttura**: è una
  configurazione da tenere presente in roadmap (oggi `issuer` è sempre il tenant).
- **Split payment (art. 17-ter DPR 633/72)**: se il committente è una P.A. o una società inclusa
  nell'elenco MEF, l'IVA è versata dal committente. Si applica **solo alle operazioni imponibili**:
  su una fattura tutta esente N4 non si presenta mai. Non si applica ai forfettari.
- Enti non commerciali / ASD-SSD in **L. 398/1991** ⇒ `RF18`, con forfetizzazione dell'IVA (50% di
  detrazione forfettaria) sulle attività commerciali.

---

## 4. Regole operative derivate (quelle che il software deve applicare)

Riassunto in forma di tabella decisionale, implementata in
`src/modules/invoice/utils/fiscalRegime.ts`.

| Regime | Espone IVA | Natura forzata | Ritenuta ammessa | Bollo > 77,47 € | Diciture |
| --- | --- | --- | --- | --- | --- |
| RF01 ordinario | Sì (per riga) | — (N4 sulle righe sanitarie) | Sì | Sì, sulla quota senza IVA | Art. 10 n. 18 sulle righe esenti |
| RF02 minimi | No | N2.2 | No | Sì | L. 244/2007 art. 1 c. 96-117 |
| RF16 / RF17 IVA per cassa | Sì | — | Sì | Sì | "IVA per cassa art. 32-bis DL 83/2012" |
| RF18 altro | Sì | — | Sì | Sì | — |
| RF19 forfettario | **No** | **N2.2** | **No** | Sì | L. 190/2014 c. 54-89 **e** c. 67 |

### Marca da bollo: la regola esatta

- **Presupposto**: documento **senza IVA** (esente art. 10, non soggetto, fuori campo, non imponibile)
  di importo **superiore a 77,47 €**. La soglia si valuta sulla **somma delle sole righe senza IVA**.
- **Importo**: 2,00 € (DPR 642/1972, Tariffa Parte I art. 13).
- **Soggetto obbligato**: l'emittente. Il **riaddebito al cliente è facoltativo**; se effettuato, la
  somma è **esclusa dalla base imponibile IVA** ex art. 15, c. 1, n. 3, DPR 633/72 e **aumenta il
  totale a pagare**. Se non riaddebitato, il bollo **non** entra nel totale documento.
- Su una fattura mista (righe esenti + righe con IVA), il bollo è dovuto se la sola quota **senza IVA**
  supera 77,47 €.

> Nota implementativa: oggi il calcolo backend (`evalTotals.ts`) **non** somma il bollo al totale,
> mentre il mirror frontend (`invoice-totals.util.ts`) **lo somma sempre**. Le due logiche vanno
> allineate sul criterio corretto (somma **solo se riaddebitato**).

### Rivalsa previdenziale: due casi da non confondere

| Tipo | Chi | Base IVA | Ritenuta d'acconto |
| --- | --- | --- | --- |
| **Rivalsa INPS Gestione Separata 4%** | Professionisti senza cassa (è il caso del fisioterapista) | Concorre all'imponibile | **Sì**, è soggetta |
| **Contributo integrativo cassa (2%/4%)** | Iscritti a casse professionali (es. ENPAPI per infermieri) | Concorre all'imponibile IVA | **No**, escluso da IRPEF |

È esattamente la distinzione che nel form fattura è resa dai flag `isRivals` e `isCashPro`, i quali
oggi si escludono a vicenda: `isCashPro` esclude la rivalsa dalla base della ritenuta.

### Ritenuta d'acconto: quando proporla

Va proposta **solo** se ricorrono contemporaneamente:
1. l'emittente è un **lavoratore autonomo** in regime **non** forfettario/minimi; **e**
2. il committente è **sostituto d'imposta** (azienda, ente, altro professionista con P. IVA).

Fatturando a un **paziente privato** la ritenuta non si applica mai. Il default sensato è quindi
"disattivata", con attivazione manuale sui casi B2B.

---

## 5. Fattura elettronica e Sistema Tessera Sanitaria

- **Divieto di fatturazione elettronica** (art. 10-bis DL 119/2018 e proroghe successive) per i
  soggetti tenuti all'invio dei dati al **Sistema TS**, limitatamente alle **prestazioni sanitarie
  rese a persone fisiche**. Questi documenti vanno emessi **fuori SdI** (cartaceo/PDF) e i dati
  trasmessi al Sistema TS. Il divieto è stato prorogato di anno in anno: **va verificato ogni anno**.
- Le righe **non sanitarie** (vendita prodotti, prestazioni wellness) e le fatture verso soggetti
  **non persone fisiche** seguono le regole ordinarie ⇒ fattura elettronica via SdI ⇒ serve il
  `RegimeFiscale` nell'XML, cioè proprio il campo oggetto di questo documento.
- L'invio al Sistema TS alimenta il 730 precompilato ed è soggetto all'eventuale **opposizione del
  paziente** (già gestita da `patient.stsOppositionToDataSending`).

### Dispensa dagli adempimenti (art. 36-bis DPR 633/72)

Chi effettua **esclusivamente** operazioni esenti può optare per la dispensa da fatturazione e
registrazione (salvo richiesta del cliente e salvo l'obbligo Sistema TS, che resta). È un'opzione
poco usata da chi lavora con software gestionale, ma spiega perché alcuni studi "non emettono
fattura se non richiesta". Non implementata: se ne prende atto.

---

## 6. Impatto sul modello dati

Campi aggiunti a `tenants` (dati aziendali):

| Campo | Tipo | Default | Motivo |
| --- | --- | --- | --- |
| `taxRegime` | `STRING(4)` | `RF01` | Codice regime FatturaPA, guida tutte le regole sopra |
| `socialSecurityFund` | `STRING` | `NONE` | `NONE` / `INPS_GS` / `CASSA`: distingue rivalsa e contributo integrativo |
| `socialSecurityRate` | `DECIMAL(5,2)` | `4.00` | Aliquota da proporre in fattura |
| `withholdingRate` | `DECIMAL(5,2)` | `20.00` | Aliquota ritenuta d'acconto da proporre |
| `stampDutyAmount` | `DECIMAL(10,2)` | `2.00` | Importo bollo: è di legge ma storicamente variato |
| `stampChargedToPatient` | `BOOLEAN` | `true` | Se il bollo va riaddebitato e quindi sommato al totale |

Campi aggiunti a `invoices`:

| Campo | Tipo | Motivo |
| --- | --- | --- |
| `stampChargedToPatient` | `BOOLEAN` | Il riaddebito incide sul totale: va congelato sul documento |
| `fiscalNotes` | `JSONB` | Diciture obbligatorie **congelate** all'emissione, come già `issuer` |

`InvoiceIssuerSnapshot` viene esteso con `taxRegime`: una fattura del 2025 emessa in forfettario deve
continuare a mostrare le diciture del forfettario anche dopo il passaggio a regime ordinario.

---

## 7. Fonti normative citate

- DPR 633/1972 — artt. 10 (n. 18 e n. 19), 15 c. 1 n. 3, 17-ter, 19-bis, 21 c. 2, 36-bis
- DPR 600/1973 — art. 25 (ritenuta su redditi di lavoro autonomo)
- DPR 642/1972 — Tariffa Parte I, art. 13 (imposta di bollo)
- L. 190/2014 — art. 1, commi 54-89 (regime forfettario) e comma 67 (esclusione ritenuta)
- L. 197/2022 — innalzamento soglia forfettario a 85.000 €
- L. 244/2007 — art. 1, commi 96-117 (ex contribuenti minimi)
- L. 398/1991 — regime forfetario enti non commerciali / ASD-SSD
- DL 83/2012 — art. 32-bis (IVA per cassa)
- DL 248/2007 — art. 2, commi 38-39 (riscossione accentrata strutture sanitarie)
- DL 119/2018 — art. 10-bis (divieto e-fattura per prestazioni sanitarie a persone fisiche)
- D.Lgs. 175/2014 e D.M. 31/07/2015 — Sistema Tessera Sanitaria
- Specifiche tecniche FatturaPA — tabelle `RegimeFiscale` (RF01-RF19) e `Natura` (N1-N7)

