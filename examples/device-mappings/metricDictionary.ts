import type { MetricDefinition } from './types.js';

/**
 * Dizionario metriche (estratto). Nella piattaforma vera vive nella tabella `metric_definitions`
 * (schema public) e vale per TUTTI i dispositivi e centri. Qui ne bastano poche per il ginocchio.
 */
export const METRIC_DICTIONARY: Record<string, MetricDefinition> = {
    KNEE_EXT_PEAK_FORCE: {
        code: 'KNEE_EXT_PEAK_FORCE',
        displayName: 'Forza di picco estensori del ginocchio',
        category: 'STRENGTH',
        unit: 'N',
        higherIsBetter: true,
        physiologicalRange: { min: 0, max: 1500 }
    },
    KNEE_FLEX_PEAK_FORCE: {
        code: 'KNEE_FLEX_PEAK_FORCE',
        displayName: 'Forza di picco flessori del ginocchio',
        category: 'STRENGTH',
        unit: 'N',
        higherIsBetter: true,
        physiologicalRange: { min: 0, max: 1200 }
    },
    KNEE_EXT_PEAK_TORQUE: {
        code: 'KNEE_EXT_PEAK_TORQUE',
        displayName: 'Momento di picco estensori del ginocchio',
        category: 'STRENGTH',
        unit: 'Nm',
        higherIsBetter: true,
        physiologicalRange: { min: 0, max: 400 }
    },
    KNEE_FLEX_PEAK_TORQUE: {
        code: 'KNEE_FLEX_PEAK_TORQUE',
        displayName: 'Momento di picco flessori del ginocchio',
        category: 'STRENGTH',
        unit: 'Nm',
        higherIsBetter: true,
        physiologicalRange: { min: 0, max: 300 }
    },
    // --- Metriche DERIVATE (asimmetria) ---
    KNEE_EXT_FORCE_LSI: {
        code: 'KNEE_EXT_FORCE_LSI',
        displayName: 'LSI forza estensori (simmetria dx/sx)',
        category: 'STRENGTH',
        unit: '%',
        higherIsBetter: true,
        physiologicalRange: { min: 0, max: 100 }
    },
    KNEE_FLEX_FORCE_LSI: {
        code: 'KNEE_FLEX_FORCE_LSI',
        displayName: 'LSI forza flessori (simmetria dx/sx)',
        category: 'STRENGTH',
        unit: '%',
        higherIsBetter: true,
        physiologicalRange: { min: 0, max: 100 }
    },
    KNEE_EXT_TORQUE_LSI: {
        code: 'KNEE_EXT_TORQUE_LSI',
        displayName: 'LSI momento estensori (simmetria dx/sx)',
        category: 'STRENGTH',
        unit: '%',
        higherIsBetter: true,
        physiologicalRange: { min: 0, max: 100 }
    },
    KNEE_FLEX_TORQUE_LSI: {
        code: 'KNEE_FLEX_TORQUE_LSI',
        displayName: 'LSI momento flessori (simmetria dx/sx)',
        category: 'STRENGTH',
        unit: '%',
        higherIsBetter: true,
        physiologicalRange: { min: 0, max: 100 }
    }
};

