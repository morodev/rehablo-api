import ImportProfile from '../models/catalog/importProfile.model.js';
import type { ImportProfileDefinition } from '../models/catalog/importProfile.model.js';
import { getDeviceMapping } from './deviceMappings.js';
import type { DeviceMapping } from './types.js';

/**
 * Risolve la mappatura da usare per un `sourceId`.
 * Fonte di verità = tabella `import_profiles` (DATO, riempita dal wizard). Fallback = registro in
 * codice (esempi seed). Così i device mappati via wizard funzionano SENZA deploy.
 */
export async function resolveDeviceMapping(sourceId: string): Promise<DeviceMapping | undefined> {
    const profile = await ImportProfile.findOne({ where: { sourceId, status: 'PUBLISHED' } });
    if (profile) {
        const def = profile.get('definition') as ImportProfileDefinition;
        return {
            sourceId,
            label: profile.get('name') as string,
            vendor: '',
            patientColumn: def.patientColumn,
            dateColumn: def.dateColumn,
            sideAliases: def.sideAliases,
            rules: def.rules,
            derivations: def.derivations
        };
    }
    // Fallback: registro in codice (per retro-compatibilità con gli esempi).
    return getDeviceMapping(sourceId);
}

