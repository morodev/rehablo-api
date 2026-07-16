import Observation from './observation.model.js';
import DeviceConnection from './deviceConnection.model.js';
import RawFile from './rawFile.model.js';

/**
 * Associazioni tenant-scoped del modulo measurements. Per ora `Observation`, `DeviceConnection` e
 * `RawFile` non hanno FK relazionali (riferiscono `patientId`/`metricCode`/`sourceId`/`rawFileId` come
 * colonne logiche, stesso pattern degli altri moduli che evitano FK cross-schema). La funzione esiste
 * per coerenza col registry.
 */
export function registerMeasurementAssociations(): void {
    // Nessuna associazione per ora.
}

export { Observation, DeviceConnection, RawFile };

