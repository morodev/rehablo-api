import { defaultCalendarEnabled, projectStructureCalendar } from '../services/structureCalendar.service.js';
import { Request, Response } from 'express';
import { Op } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { getGrantedPermissions, getSelectedStructureId, getUserId } from '../../../middleware/rbac.js';
import {
    getAssignableRoles,
    getRolePermissions,
    isRoleCode,
    resolveEffectiveRole,
    RoleCode,
    ROLE_DEFINITIONS
} from '../rbac/roles.js';
import { Structure, StructureUser, TenantUser, User } from '../models/index.js';
import { revokeAllForUser } from '../services/refreshToken.service.js';
import {applyTeamMembershipChange, parseTeamChange, runTeamMutation, sendTeamOffboardingError, type TeamChange} from '../services/teamOffboarding.service.js';
import {FutureAppointmentsRequireReplacementError, InvalidReplacementOperatorError} from '../../agenda/services/operatorReassignment.service.js';
import { validateUserStructureSelection } from '../services/userStructurePolicy.service.js';
import { assertCurrentIdentity } from '../services/authState.service.js';

async function syncUserStructureAssignments(
    userId: string,
    tenantStructureIds: readonly string[],
    requestedStructureIds: readonly string[],
    role: RoleCode
): Promise<{ added: number; removed: number }> {
    const requested = [...new Set(requestedStructureIds)];
    const current = await StructureUser.findAll({ where: { userId } });
    const currentIds = current
        .map((row) => row.get('structureId') as string)
        .filter((id) => tenantStructureIds.includes(id));

    const toAdd = requested.filter((id) => !currentIds.includes(id));
    const toRemove = currentIds.filter((id) => !requested.includes(id));

    if (toAdd.length > 0) {
        await StructureUser.bulkCreate(
            toAdd.map((structureId) => ({ structureId, userId, role: null, calendarEnabled: defaultCalendarEnabled(role) }))
        );
    }
    if (toRemove.length > 0) {
        await StructureUser.destroy({
            where: { userId, structureId: { [Op.in]: toRemove } }
        });
    }

    return { added: toAdd.length, removed: toRemove.length };
}

/**
 * Catalogo dei ruoli assegnabili + relativi permessi.
 * Serve alla UI di gestione utenti per popolare la select del ruolo e mostrare
 * cosa comporta ciascuna scelta.
 */
export const listRoles = asyncHandler(async (_req: Request, res: Response) => {
    const roles = getAssignableRoles().map((role) => ({
        code: role.code,
        labelKey: role.labelKey,
        actor: role.actor,
        permissions: [...new Set(role.permissions)]
    }));

    return sendSuccessResponse(res, 200, { roles }, 'Roles retrieved');
});

/** Ruolo e permessi effettivi della sessione corrente (utile per debug e per il frontend). */
export const myPermissions = asyncHandler(async (req: Request, res: Response) => {
    const role = (req.user?.role as string) ?? null;

    return sendSuccessResponse(
        res,
        200,
        {
            role,
            labelKey: isRoleCode(role) ? ROLE_DEFINITIONS[role].labelKey : null,
            isSuperAdmin: !!req.user?.isSuperAdmin,
            tenantId: (req.user?.tid as string) ?? null,
            structureId: (req.user?.sid as string) ?? null,
            permissions: getGrantedPermissions(req)
        },
        'Permissions retrieved'
    );
});

/**
 * Profilo della sessione corrente: dati utente freschi dal DB + ruolo e permessi.
 *
 * Il frontend lo usa per riallineare i permessi senza rifare il login (es. dopo che un
 * amministratore ha cambiato il ruolo) e per non fidarsi solo del token in cache.
 */
export const me = asyncHandler(async (req: Request, res: Response) => {
    const userId = getUserId(req);

    const user = await User.findByPk(userId, { attributes: { exclude: ['password'] } });
    if (!user) {
        return sendErrorResponse(res, 404, 'User not found');
    }
    assertCurrentIdentity(user, req.user?.authVersion);

    const tenantId = (req.user?.tid as string) ?? req.user?.tenants?.[0]?.id ?? null;
    const structureId = getSelectedStructureId(req);

    // requireAuth ha già risolto lo stato corrente, incluso l'eventuale principal paziente.
    const role = isRoleCode(req.user?.role) ? req.user.role : null;

    return sendSuccessResponse(
        res,
        200,
        {
            user: await projectStructureCalendar({ ...user.get({plain: true}), isSuperAdmin: !!req.user?.isSuperAdmin }, tenantId, structureId),
            tenantId,
            structureId,
            role,
            labelKey: role ? ROLE_DEFINITIONS[role].labelKey : null,
            isSuperAdmin: !!req.user?.isSuperAdmin,
            permissions: getRolePermissions(role),
            /** `true` se il token in mano al client riporta un ruolo ormai superato. */
            roleChanged: ((req.user?.role as string) ?? null) !== role
        },
        'Profile retrieved'
    );
});

// ---------------------------------------------------------------------------
// Assegnazione dei ruoli
// ---------------------------------------------------------------------------

/**
 * Controlli comuni a ogni cambio di ruolo.
 * Restituisce un errore da inoltrare al client, oppure `null` se l'operazione è consentita.
 */
async function writeMembership(req: Request, res: Response, change: TeamChange) {
    try {
        const result = await runTeamMutation(req, req.params.userId, change, applyTeamMembershipChange);
        if (result.replayed) res.setHeader('X-Operation-Replayed', 'true');
        await revokeAllForUser(req.params.userId, change.kind === 'structures' ? 'structures_changed' : 'role_changed');
        return sendSuccessResponse(res, 200, result.data, 'Membro del team aggiornato');
    } catch (error) {
        if (sendTeamOffboardingError(res, error)) return;
        if (error instanceof FutureAppointmentsRequireReplacementError) return sendErrorResponse(res, 409, error.message, {code: 'FUTURE_APPOINTMENTS_REQUIRE_REASSIGNMENT', impact: error.impact});
        if (error instanceof InvalidReplacementOperatorError) return sendErrorResponse(res, 409, error.message, {code: 'INVALID_REPLACEMENT_OPERATOR'});
        throw error;
    }
}
export const updateUserRole = asyncHandler(async (req: Request, res: Response) => {
    try {
        return await writeMembership(req, res, parseTeamChange({kind: 'role', role: req.body.role,
            ...(req.body.structureIds !== undefined ? {structureIds: req.body.structureIds} : {})}));
    } catch (error) { if (sendTeamOffboardingError(res, error)) return; throw error; }
});
export const updateUserStructureRole = asyncHandler(async (req: Request, res: Response) => {
    try { return await writeMembership(req, res, parseTeamChange({kind: 'structureRole', structureId: req.body.structureId, role: req.body.role})); }
    catch (error) { if (sendTeamOffboardingError(res, error)) return; throw error; }
});
export const updateUserStructures = asyncHandler(async (req: Request, res: Response) => {
    try { return await writeMembership(req, res, parseTeamChange({kind: 'structures', structureIds: req.body.structureIds})); }
    catch (error) { if (sendTeamOffboardingError(res, error)) return; throw error; }
});

export default {
    listRoles,
    myPermissions,
    me,
    updateUserRole,
    updateUserStructureRole,
    updateUserStructures
};


