import type { DeviceMapping } from '../types.js';

/**
 * MAPPATURA DISPOSITIVO A — Dinamometro Kinvent "K-Force" (esempio).
 * Formato: CSV con forza in NEWTON, lato scritto per esteso ("Left"/"Right"),
 * muscolo nella colonna "Muscle".
 *
 * Questa è ESATTAMENTE "la mappatura del dinamometro" che mi hai chiesto: dati (non codice).
 * Nella piattaforma vera queste righe stanno nella tabella `metric_mappings` legate a `sourceId`.
 */
export const kinventKForceMapping: DeviceMapping = {
    sourceId: 'kinvent-kforce',
    label: 'Kinvent K-Force (dinamometro)',
    vendor: 'Kinvent',
    patientColumn: 'Patient',
    dateColumn: 'Date',
    sideAliases: { Left: 'LEFT', Right: 'RIGHT', L: 'LEFT', R: 'RIGHT' },
    rules: [
        {
            metricCode: 'KNEE_EXT_PEAK_FORCE',
            valueColumn: 'Peak Force (N)',
            fromUnit: 'N', // già in Newton -> nessuna conversione
            filters: [{ column: 'Muscle', equals: 'Knee Extensors' }],
            side: { column: 'Side' },
            aggregation: 'BEST'
        },
        {
            metricCode: 'KNEE_FLEX_PEAK_FORCE',
            valueColumn: 'Peak Force (N)',
            fromUnit: 'N',
            filters: [{ column: 'Muscle', equals: 'Knee Flexors' }],
            side: { column: 'Side' },
            aggregation: 'BEST'
        }
    ],
    derivations: [
        { metricCode: 'KNEE_EXT_FORCE_LSI', fromMetric: 'KNEE_EXT_PEAK_FORCE', method: 'LSI' },
        { metricCode: 'KNEE_FLEX_FORCE_LSI', fromMetric: 'KNEE_FLEX_PEAK_FORCE', method: 'LSI' }
    ]
};

