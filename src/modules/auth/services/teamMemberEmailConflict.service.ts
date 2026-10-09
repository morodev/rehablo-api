import { TenantUser } from '../models/index.js';
import { findUserByIdentityEmail } from './identity.service.js';
import { normalizeIdentityEmail } from '../models/userEmail.model.js';

export const TEAM_MEMBER_EMAIL_CONFLICTS = {
    EMAIL_ALREADY_IN_TEAM: 'Questa email appartiene già a un membro del team.',
    EMAIL_MEMBER_DEACTIVATED: 'Questa email appartiene a un membro rimosso dal team. Riattivalo dalla lista.',
    EMAIL_ALREADY_REGISTERED: 'Esiste già un account Rehablo con questa email. Usa un indirizzo diverso.'
} as const;

export type TeamMemberEmailConflictCode = keyof typeof TEAM_MEMBER_EMAIL_CONFLICTS;

export interface TeamMemberEmailConflict {
    code: TeamMemberEmailConflictCode;
    field: 'email';
    message: string;
}

function emailConflict(code: TeamMemberEmailConflictCode): TeamMemberEmailConflict {
    return {code, field: 'email', message: TEAM_MEMBER_EMAIL_CONFLICTS[code]};
}

/**
 * La mail identifica un account globale, mentre la presenza nel team è specifica del tenant.
 * Questo controllo mantiene distinti il duplicato locale, il membro rimosso e un account
 * appartenente a un altro studio, senza esporre dettagli sull'altro tenant.
 */
export async function findTeamMemberEmailConflict(
    tenantId: string,
    rawEmail: unknown
): Promise<TeamMemberEmailConflict | null> {
    const normalizedEmail = normalizeIdentityEmail(rawEmail);
    if (!normalizedEmail) return null;

    const existingUser = await findUserByIdentityEmail(normalizedEmail);
    if (!existingUser) return null;

    const userId = existingUser.get('id') as string;
    const membership = await TenantUser.findOne({where: {tenantId, userId}});
    if (!membership) return emailConflict('EMAIL_ALREADY_REGISTERED');
    if (membership.get('deactivatedAt')) return emailConflict('EMAIL_MEMBER_DEACTIVATED');
    return emailConflict('EMAIL_ALREADY_IN_TEAM');
}

/** Riconosce sia l'indice `users.email` sia l'alias normalizzato creato dall'hook afterCreate. */
export function isEmailUniqueConstraintError(error: any): boolean {
    if (error?.name !== 'SequelizeUniqueConstraintError') return false;

    const fields = new Set<string>([
        ...Object.keys(error?.fields ?? {}),
        ...(Array.isArray(error?.errors)
            ? error.errors.map((item: any) => item?.path).filter((path: unknown): path is string => typeof path === 'string')
            : [])
    ]);
    return fields.has('email') || fields.has('normalizedEmail');
}

export function registeredEmailConflict(): TeamMemberEmailConflict {
    return emailConflict('EMAIL_ALREADY_REGISTERED');
}
