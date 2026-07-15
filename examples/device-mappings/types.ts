// Tipi del "motore di mappatura" dispositivi -> modello canonico Rehablo.
// (Versione dimostrativa e auto-contenuta: nessuna dipendenza esterna, gira con `tsx`.)

export type Side = 'LEFT' | 'RIGHT' | 'BILATERAL';

export type MetricCategory =
    | 'STRENGTH'
    | 'ROM'
    | 'NEUROMUSCULAR'
    | 'MOVEMENT'
    | 'EMG'
    | 'QUESTIONNAIRE'
    | 'SYMPTOM'
    | 'VITAL';

/** Voce del dizionario dei dati (Clinical Data Dictionary). Definita UNA volta, condivisa da tutti. */
export interface MetricDefinition {
    code: string;
    displayName: string;
    category: MetricCategory;
    /** Unità canonica in cui il dato viene SEMPRE salvato in `observations`. */
    unit: string;
    higherIsBetter: boolean;
    physiologicalRange?: { min: number; max: number };
}

/** Condizione per selezionare a quali righe del file si applica una regola. */
export interface FieldFilter {
    column: string;
    equals: string | string[];
}

/** Una regola di mappatura: "questa colonna del file -> questa metrica del dizionario". */
export interface MappingRule {
    metricCode: string;
    /** Colonna del file che contiene il valore numerico. */
    valueColumn: string;
    /** Unità così come esce dal dispositivo (verrà convertita nell'unità canonica). */
    fromUnit: string;
    /** Filtri per capire di quale metrica si tratta (es. Muscolo = "Knee Extensors"). */
    filters?: FieldFilter[];
    /** Da dove viene il lato: una colonna del file, oppure un valore fisso. */
    side?: { column: string } | { const: Side };
    /** Moltiplicatore extra dopo la conversione di unità (di solito 1). */
    factor?: number;
    /** Come aggregare più prove sullo stesso lato: prova migliore (default) o media. */
    aggregation?: 'BEST' | 'MEAN' | 'RAW';
}

export type DerivationMethod = 'LSI';

/** Regola per calcolare una metrica DERIVATA (valore aggiunto Rehablo), es. l'asimmetria LSI. */
export interface DerivationRule {
    metricCode: string; // metrica prodotta
    fromMetric: string; // metrica base (serve LEFT e RIGHT)
    method: DerivationMethod;
}

/** La mappatura completa di UN dispositivo (una sorgente = un `sourceId`). */
export interface DeviceMapping {
    sourceId: string;
    label: string;
    vendor: string;
    /** Colonna con l'identificativo del paziente nel file. */
    patientColumn: string;
    /** Colonna con la data del test nel file. */
    dateColumn: string;
    /** Come questo dispositivo scrive il lato: "Left"/"L"/"Sinistro" -> LEFT, ecc. */
    sideAliases?: Record<string, Side>;
    rules: MappingRule[];
    derivations?: DerivationRule[];
}

/** Misurazione canonica: è ciò che finisce nella tabella `observations`. */
export interface Observation {
    patientRef: string;
    metricCode: string;
    value: number;
    unit: string;
    side: Side;
    effectiveDateTime: string;
    sourceId: string;
    provenance: 'IMPORT' | 'DERIVED' | 'MANUAL' | 'DEVICE_API';
    calculationMethod?: string;
}

