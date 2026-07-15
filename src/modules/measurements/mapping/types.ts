import type { ObservationProvenance, ObservationSide } from '../models/observation.model.js';

/** Condizione per selezionare a quali righe del file si applica una regola. */
export interface FieldFilter {
    column: string;
    equals: string | string[];
}

/** Una regola di mappatura: "questa colonna del file -> questa metrica del dizionario". */
export interface MappingRule {
    metricCode: string;
    valueColumn: string;
    /** Unità così come esce dal dispositivo (verrà convertita nell'unità canonica del dizionario). */
    fromUnit: string;
    filters?: FieldFilter[];
    side?: { column: string } | { const: ObservationSide };
    factor?: number;
    aggregation?: 'BEST' | 'MEAN' | 'RAW';
}

export type DerivationMethod = 'LSI';

/** Regola per calcolare una metrica DERIVATA (valore aggiunto Rehablo), es. l'asimmetria LSI. */
export interface DerivationRule {
    metricCode: string;
    fromMetric: string;
    method: DerivationMethod;
}

/** La mappatura completa di UN dispositivo (una sorgente = un `sourceId`). */
export interface DeviceMapping {
    sourceId: string;
    label: string;
    vendor: string;
    patientColumn?: string;
    dateColumn: string;
    sideAliases?: Record<string, ObservationSide>;
    rules: MappingRule[];
    derivations?: DerivationRule[];
}

/** Ciò che il motore produce per ogni misura: pronta per l'imbuto di ingestione. */
export interface MappedMeasurement {
    metricCode: string;
    value: number;
    unit: string;
    side: ObservationSide;
    effectiveDateTime: string;
    sourceId: string;
    provenance: ObservationProvenance;
    aggregation: 'BEST' | 'MEAN' | 'RAW' | 'SINGLE';
    calculationMethod?: string;
}

/** Info minima dal dizionario di cui il motore ha bisogno (unità canonica + verso migliore). */
export interface MetricInfo {
    unit: string;
    higherIsBetter: boolean;
}

