import { DEVICE_MAPPINGS } from '../mapping/deviceMappings.js';
import type { ImportProfileCreationAttributes } from '../models/catalog/importProfile.model.js';

/**
 * Profili di import iniziali: derivati dalle mappature "di esempio" del motore, ma salvati come DATO
 * nella tabella `import_profiles`. Da qui in poi la fonte di verità è il DB: nuovi device si aggiungono
 * via wizard (POST /import-profiles) SENZA toccare il codice.
 *
 * NOTA: le colonne di questi due profili (Kinvent/Biodex) sono plausibili ma da confermare su file
 * reali. Servono da esempio/base per il wizard.
 */
export const initialImportProfiles: ImportProfileCreationAttributes[] = Object.values(DEVICE_MAPPINGS).map(
    (m) => ({
        sourceId: m.sourceId,
        name: m.label,
        status: 'PUBLISHED',
        definition: {
            patientColumn: m.patientColumn,
            dateColumn: m.dateColumn,
            sideAliases: m.sideAliases,
            rules: m.rules,
            derivations: m.derivations
        }
    })
);

