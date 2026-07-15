import type { DeviceMapping } from '../types.js';

/**
 * MAPPATURA DISPOSITIVO B — Dinamometro isocinetico "Biodex" (esempio).
 * Formato COMPLETAMENTE DIVERSO dal Kinvent:
 *  - colonne diverse: "Name", "Movement", "Limb", "Peak Torque (ft-lb)"
 *  - misura il MOMENTO (torque) in ft-lb (piedi-libbra), NON la forza in Newton
 *  - lato scritto come "L"/"R"
 *
 * Eppure, applicando questa mappatura, i dati finiscono nelle STESSE metriche canoniche
 * (con conversione ft-lb -> Nm). => La mappatura di B è diversa da quella di A, ma l'output è
 * omogeneo e confrontabile. Questo è il punto dell'intera architettura.
 */
export const biodexIsoMapping: DeviceMapping = {
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
            fromUnit: 'ft-lb', // -> convertito automaticamente in Nm
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

