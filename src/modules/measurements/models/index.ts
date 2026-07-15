import Observation from './observation.model.js';
import DeviceConnection from './deviceConnection.model.js';

/**
 * Associazioni tenant-scoped del modulo measurements. Per ora `Observation` e `DeviceConnection` non
 * hanno FK relazionali (riferiscono `patientId`/`metricCode`/`sourceId` come colonne logiche, stesso
 * pattern degli altri moduli che evitano FK cross-schema). La funzione esiste per coerenza col registry.
 */
export function registerMeasurementAssociations(): void {
    // Nessuna associazione per ora.
}

export { Observation, DeviceConnection };

