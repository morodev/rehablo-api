import type { MetricDefinitionCreationAttributes } from '../models/catalog/metricDefinition.model.js';

/**
 * Seed iniziale del dizionario metriche (slice verticale: distretto ginocchio).
 * Nella roadmap (docs/REHABLO_OS_GAP_ANALYSIS.md §6, Fase 0) si arriverà a ~120-150 metriche del
 * core clinico. Qui bastano quelle che i dinamometri producono per validare l'intera catena.
 */
export const initialMetrics: MetricDefinitionCreationAttributes[] = [
    {
        code: 'KNEE_EXT_PEAK_FORCE',
        displayName: 'Forza di picco estensori del ginocchio',
        category: 'STRENGTH',
        unit: 'N',
        higherIsBetter: true,
        physiologicalMin: 0,
        physiologicalMax: 1500,
        applicableDistricts: ['knee'],
        applicableSides: ['LEFT', 'RIGHT']
    },
    {
        code: 'KNEE_FLEX_PEAK_FORCE',
        displayName: 'Forza di picco flessori del ginocchio',
        category: 'STRENGTH',
        unit: 'N',
        higherIsBetter: true,
        physiologicalMin: 0,
        physiologicalMax: 1200,
        applicableDistricts: ['knee'],
        applicableSides: ['LEFT', 'RIGHT']
    },
    {
        code: 'KNEE_EXT_PEAK_TORQUE',
        displayName: 'Momento di picco estensori del ginocchio',
        category: 'STRENGTH',
        unit: 'Nm',
        higherIsBetter: true,
        physiologicalMin: 0,
        physiologicalMax: 400,
        applicableDistricts: ['knee'],
        applicableSides: ['LEFT', 'RIGHT']
    },
    {
        code: 'KNEE_FLEX_PEAK_TORQUE',
        displayName: 'Momento di picco flessori del ginocchio',
        category: 'STRENGTH',
        unit: 'Nm',
        higherIsBetter: true,
        physiologicalMin: 0,
        physiologicalMax: 300,
        applicableDistricts: ['knee'],
        applicableSides: ['LEFT', 'RIGHT']
    },
    {
        code: 'KNEE_EXT_FORCE_LSI',
        displayName: 'LSI forza estensori (simmetria dx/sx)',
        category: 'STRENGTH',
        unit: '%',
        dataType: 'RATIO',
        higherIsBetter: true,
        physiologicalMin: 0,
        physiologicalMax: 100,
        mcid: 10,
        applicableDistricts: ['knee'],
        applicableSides: ['BILATERAL']
    },
    {
        code: 'KNEE_FLEX_FORCE_LSI',
        displayName: 'LSI forza flessori (simmetria dx/sx)',
        category: 'STRENGTH',
        unit: '%',
        dataType: 'RATIO',
        higherIsBetter: true,
        physiologicalMin: 0,
        physiologicalMax: 100,
        mcid: 10,
        applicableDistricts: ['knee'],
        applicableSides: ['BILATERAL']
    },
    {
        code: 'KNEE_EXT_TORQUE_LSI',
        displayName: 'LSI momento estensori (simmetria dx/sx)',
        category: 'STRENGTH',
        unit: '%',
        dataType: 'RATIO',
        higherIsBetter: true,
        physiologicalMin: 0,
        physiologicalMax: 100,
        mcid: 10,
        applicableDistricts: ['knee'],
        applicableSides: ['BILATERAL']
    },
    {
        code: 'KNEE_FLEX_TORQUE_LSI',
        displayName: 'LSI momento flessori (simmetria dx/sx)',
        category: 'STRENGTH',
        unit: '%',
        dataType: 'RATIO',
        higherIsBetter: true,
        physiologicalMin: 0,
        physiologicalMax: 100,
        mcid: 10,
        applicableDistricts: ['knee'],
        applicableSides: ['BILATERAL']
    }
];

