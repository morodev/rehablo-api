import type { DeviceMapping } from './types.js';

/**
 * MAPPATURA DISPOSITIVO A — Kinvent K-Force (forza in Newton, lato "Left/Right").
 * Nel prodotto finale queste righe vivranno in una tabella `metric_mappings` legata al `sourceId`
 * ed editabili da un "mapping wizard". Qui sono codice per la slice verticale.
 */
const kinventKForce: DeviceMapping = {
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
            fromUnit: 'N',
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

/**
 * MAPPATURA DISPOSITIVO B — Biodex isocinetico (momento in ft-lb -> Nm, lato "L/R", colonne diverse).
 * Dimostra che una mappatura diversa produce comunque le stesse metriche canoniche.
 */
const biodexIso: DeviceMapping = {
    sourceId: 'biodex-iso',
    label: 'Biodex System 4 (isocinetico)',
    vendor: 'Biodex',
    patientColumn: 'Name',
    dateColumn: 'Test Date',
    sideAliases: { L: 'LEFT', R: 'RIGHT', Left: 'LEFT', Right: 'RIGHT' },
    rules: [
        {
            metricCode: 'KNEE_EXT_PEAK_TORQUE',
            valueColumn: 'Peak Torque (ft-lb)',
            fromUnit: 'ft-lb',
            filters: [{ column: 'Movement', equals: 'Knee Extension' }],
            side: { column: 'Limb' },
            aggregation: 'BEST'
        },
        {
            metricCode: 'KNEE_FLEX_PEAK_TORQUE',
            valueColumn: 'Peak Torque (ft-lb)',
            fromUnit: 'ft-lb',
            filters: [{ column: 'Movement', equals: 'Knee Flexion' }],
            side: { column: 'Limb' },
            aggregation: 'BEST'
        }
    ],
    derivations: [
        { metricCode: 'KNEE_EXT_TORQUE_LSI', fromMetric: 'KNEE_EXT_PEAK_TORQUE', method: 'LSI' },
        { metricCode: 'KNEE_FLEX_TORQUE_LSI', fromMetric: 'KNEE_FLEX_PEAK_TORQUE', method: 'LSI' }
    ]
};

/** Registro delle mappature disponibili, indicizzate per `sourceId`. */
export const DEVICE_MAPPINGS: Record<string, DeviceMapping> = {
    [kinventKForce.sourceId]: kinventKForce,
    [biodexIso.sourceId]: biodexIso
};

export function getDeviceMapping(sourceId: string): DeviceMapping | undefined {
    return DEVICE_MAPPINGS[sourceId];
}

export function listDeviceSources(): { sourceId: string; label: string; vendor: string }[] {
    return Object.values(DEVICE_MAPPINGS).map((m) => ({
        sourceId: m.sourceId,
        label: m.label,
        vendor: m.vendor
    }));
}

