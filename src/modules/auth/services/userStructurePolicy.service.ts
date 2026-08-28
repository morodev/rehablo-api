import { RoleCode } from '../rbac/roles.js';

/**
 * Regola di dominio per le sedi assegnate ai membri del team.
 *
 * - OWNER: tutte le sedi del tenant;
 * - SECRETARY: una o piÃ¹ sedi, perchÃ© puÃ² lavorare anche da remoto;
 * - ruoli operativi: una sola sede di lavoro.
 */
export function validateUserStructureSelection(
    role: RoleCode,
    requestedStructureIds: readonly string[],
    tenantStructureIds: readonly string[]
): string | null {
    const requested = [...new Set(requestedStructureIds)];

    if (requested.some((id) => !tenantStructureIds.includes(id))) {
        return 'Una o piÃ¹ strutture non appartengono allo studio';
    }

    if (role === RoleCode.OWNER) {
        const ownsEveryStructure = requested.length === tenantStructureIds.length
            && tenantStructureIds.every((id) => requested.includes(id));
        return ownsEveryStructure
            ? null
            : 'Un proprietario deve essere abilitato a tutte le sedi';
    }

    if (role === RoleCode.SECRETARY) {
        return requested.length > 0
            ? null
            : 'La segreteria deve essere abilitata ad almeno una sede';
    }

    return requested.length === 1
        ? null
        : 'Ogni operatore deve avere una sola sede operativa';
}

