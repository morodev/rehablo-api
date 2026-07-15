import type { DeviceSourceCreationAttributes } from '../models/catalog/deviceSource.model.js';

/**
 * Seed iniziale del catalogo dispositivi. NOMI reali; l'elenco crescerà (VALD ForceDecks/NordBord,
 * Hawkin, Delsys, Noraxon…) man mano che si aggiungono le relative metriche al dizionario.
 *
 * `producesMetrics` = le metriche del dizionario che il device produce → alimenta i CAMPI del
 * form MANUALE nel frontend. `channels` = come può conferire dati. `importProfileId` = la mappatura
 * CSV da usare (per ora coincide col sourceId, vedi mapping/deviceMappings.ts).
 */
export const initialDeviceSources: DeviceSourceCreationAttributes[] = [
    {
        sourceId: 'generic-manual-dynamometer',
        vendor: 'Generico',
        model: 'Dinamometro manuale',
        displayName: 'Dinamometro (inserimento manuale)',
        deviceType: 'dynamometer',
        channels: ['MANUAL'],
        integrationLevel: 'MANUAL',
        producesMetrics: ['KNEE_EXT_PEAK_FORCE', 'KNEE_FLEX_PEAK_FORCE'],
        notes: 'Fallback universale: qualsiasi dinamometro i cui valori vengono digitati a mano.'
    },
    {
        sourceId: 'kinvent-kforce',
        vendor: 'Kinvent',
        model: 'K-Force',
        displayName: 'Kinvent K-Force',
        deviceType: 'dynamometer',
        channels: ['MANUAL', 'IMPORT'],
        integrationLevel: 'IMPORT',
        producesMetrics: [
            'KNEE_EXT_PEAK_FORCE',
            'KNEE_FLEX_PEAK_FORCE',
            'KNEE_EXT_FORCE_LSI',
            'KNEE_FLEX_FORCE_LSI'
        ],
        importProfileId: 'kinvent-kforce',
        notes: 'Export CSV. Mappatura in mapping/deviceMappings.ts (colonne da confermare su file reale).'
    },
    {
        sourceId: 'biodex-iso',
        vendor: 'Biodex',
        model: 'System 4 Pro',
        displayName: 'Biodex System 4 (isocinetico)',
        deviceType: 'isokinetic',
        channels: ['MANUAL', 'IMPORT'],
        integrationLevel: 'IMPORT',
        producesMetrics: [
            'KNEE_EXT_PEAK_TORQUE',
            'KNEE_FLEX_PEAK_TORQUE',
            'KNEE_EXT_TORQUE_LSI',
            'KNEE_FLEX_TORQUE_LSI'
        ],
        importProfileId: 'biodex-iso',
        notes: 'Export in ft-lb, convertito in Nm dal motore di mappatura.'
    },
    {
        sourceId: 'vald-dynamo',
        vendor: 'VALD',
        model: 'DynaMo',
        displayName: 'VALD DynaMo',
        deviceType: 'dynamometer',
        channels: ['MANUAL', 'API_PULL'],
        integrationLevel: 'NATIVE',
        producesMetrics: ['KNEE_EXT_PEAK_FORCE', 'KNEE_FLEX_PEAK_FORCE'],
        apiDocsUrl: 'https://vald.com',
        notes: 'API ufficiale (connettore pull da implementare in Fase 1). Credenziali per-tenant in DeviceConnection.'
    }
];

