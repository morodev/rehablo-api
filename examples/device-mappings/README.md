# Demo: motore di mappatura dispositivi → modello canonico Rehablo

Esempio **funzionante e auto-contenuto** che mostra come si scrive la *mappatura di un dispositivo*
(dinamometro) e come i dati finiscono, normalizzati, in un modello canonico unico (`Observation`).

Dimostra i tre dubbi tipici:
- **"Come fa a sapere quale dispositivo sto usando?"** → glielo dici tu con il `sourceId` (qui simulato
  scegliendo quale sample importare). Il motore carica **la mappatura di quel `sourceId`**.
- **"La mappatura di A funziona per B?"** → No: ci sono **due mappature diverse** (Kinvent in Newton,
  Biodex in ft-lb, colonne e lati scritti diversamente). Ma producono **le stesse metriche canoniche**.
- **"Dove finiscono i dati?"** → In `Observation` con unità canonica, lato, provenienza e, in più, le
  metriche **derivate** (LSI, calcolato da Rehablo).

## Come eseguirla

Dalla **root del backend** (`rehablo-api`):

```powershell
node_modules\.bin\tsx.cmd examples\device-mappings\run.ts
```

(oppure `npx tsx examples/device-mappings/run.ts`)

## File

| File | Ruolo |
|---|---|
| `types.ts` | I tipi del motore (MetricDefinition, DeviceMapping, MappingRule, Observation…) |
| `metricDictionary.ts` | Il **dizionario metriche** canonico (nel prodotto vero: tabella `metric_definitions`, schema public) |
| `mappings/kinvent.mapping.ts` | **Mappatura Dispositivo A** — Kinvent K-Force (forza in N) |
| `mappings/biodex.mapping.ts` | **Mappatura Dispositivo B** — Biodex isocinetico (momento in ft-lb → Nm) |
| `mappingEngine.ts` | Il motore: parser CSV, conversione unità, aggregazione prova migliore, LSI derivato |
| `samples/kinvent-sample.csv` | Export di esempio del Kinvent |
| `samples/biodex-sample.csv` | Export di esempio del Biodex (formato completamente diverso) |
| `run.ts` | Simula `POST /v1/imports`: sceglie la mappatura dal `sourceId` e stampa le Observation |

## Come si aggiunge un TERZO dinamometro (senza toccare il motore)

1. Se produce metriche nuove, aggiungile a `metricDictionary.ts` (nel prodotto: righe in
   `metric_definitions`).
2. Crea `mappings/<nuovo>.mapping.ts` con `sourceId`, colonne, unità e (se serve) `sideAliases`.
3. Registralo in `run.ts` (nel prodotto: una riga `DeviceSource` + profilo di mappatura, scelti dall'UI).

Il motore, il dizionario e il resto del software **non cambiano**. È esattamente il principio del
documento `docs/REHABLO_OS_GAP_ANALYSIS.md` (§3 e §4).

## Nota

Questa cartella è **solo dimostrativa** e non fa parte del build di produzione: il `tsconfig.json`
principale include solo `src/**`. Il `tsconfig.json` locale serve unicamente all'IDE per valutare questi
file con lo stesso target (ES2022/ESNext) del progetto.

