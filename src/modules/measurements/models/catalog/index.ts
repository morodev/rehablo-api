import MetricDefinition from './metricDefinition.model.js';
import DeviceSource from './deviceSource.model.js';
import ImportProfile from './importProfile.model.js';
import { initialMetrics } from '../../data/initialMetrics.js';
import { initialDeviceSources } from '../../data/initialDeviceSources.js';
import { initialImportProfiles } from '../../data/initialImportProfiles.js';

/**
 * Sincronizza i cataloghi public del modulo measurements (dizionario metriche + catalogo dispositivi +
 * profili di import), condivisi da tutti i tenant. Chiamata una volta al boot.
 */
export async function syncMeasurementCatalogModels(): Promise<void> {
    await MetricDefinition.sync({ alter: true });
    await DeviceSource.sync({ alter: true });
    await ImportProfile.sync({ alter: true });
}

/** Seed idempotente dei cataloghi (findOrCreate per chiave). */
export async function seedMeasurementCatalogData(): Promise<void> {
    for (const metric of initialMetrics) {
        await MetricDefinition.findOrCreate({
            where: { code: metric.code },
            defaults: metric as any
        });
    }
    for (const device of initialDeviceSources) {
        await DeviceSource.findOrCreate({
            where: { sourceId: device.sourceId },
            defaults: device as any
        });
    }
    for (const profile of initialImportProfiles) {
        await ImportProfile.findOrCreate({
            where: { sourceId: profile.sourceId },
            defaults: profile as any
        });
    }
    console.log('[measurements] metric dictionary + device catalog + import profiles seed completed');
}

export { MetricDefinition, DeviceSource, ImportProfile };

