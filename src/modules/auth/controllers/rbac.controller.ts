import { Request, Response } from 'express';
import { Op } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { getGrantedPermissions, getUserId } from '../../../middleware/rbac.js';
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

/** Garantisce che un OWNER sia assegnato a tutte le sedi del proprio tenant. */
async function assignOwnerToAllStructures(tenantId: string, userId: string): Promise<void> {
    const structures = await Structure.findAll({ where: { tenantId }, attributes: ['id'] });
    if (!structures.length) return;

    const structureIds = structures.map((structure) => structure.get('id') as string);

    await StructureUser.bulkCreate(
        structureIds.map((structureId) => ({
            structureId,
            userId,
            role: null
        })),
        { ignoreDuplicates: true }
    );

    // Un OWNER non può diventare localmente un ruolo meno privilegiato: il ruolo
    // proprietario è tenant-wide e deve restare effettivo in ogni sede.
    await StructureUser.update(
        { role: null },
        { where: { userId, structureId: { [Op.in]: structureIds } } }
    );
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

    const tenantId = (req.user?.tid as string) ?? req.user?.tenants?.[0]?.id ?? null;
    const structureId = (req.user?.sid as string) ?? null;

    // Il ruolo viene riletto dal DB: se è cambiato dopo l'emissione del token,
    // la risposta riflette la situazione reale.
    const membership = tenantId ? await TenantUser.findOne({ where: { tenantId, userId } }) : null;
    const assignment = structureId
        ? await StructureUser.findOne({ where: { structureId, userId } })
        : null;

    const role = resolveEffectiveRole(
        (membership?.get('role') as string) ?? null,
        (assignment?.get('role') as string) ?? null
    );

    return sendSuccessResponse(
        res,
        200,
        {
            user,
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
async function validateRoleChange(
    req: Request,
    targetUserId: string,
    role: unknown
): Promise<{ status: number; message: string } | null> {
    if (!isRoleCode(role)) {
        return { status: 400, message: 'Ruolo non valido' };
    }

    // I ruoli non assegnabili (es. PATIENT) nascono da altri flussi, non dalla UI staff.
    if (!ROLE_DEFINITIONS[role].assignable) {
        return { status: 400, message: 'Ruolo non assegnabile' };
    }

    // Nessuno può modificare il proprio ruolo: eviterebbe sia l'auto-esclusione
    // sia l'auto-promozione da parte di chi possiede `user:update`.
    if (targetUserId === getUserId(req)) {
        return { status: 403, message: 'Non puoi modificare il tuo ruolo' };
    }

    const tenantId = getCurrentTenantId(req);
    const membership = await TenantUser.findOne({ where: { tenantId, userId: targetUserId } });
    if (!membership) {
        return { status: 404, message: 'Utente non trovato in questo studio' };
    }

    // Il titolare dello studio resta OWNER: è l'intestatario dell'abbonamento e il
    // riferimento amministrativo del tenant. Declassarlo lo priverebbe dell'accesso ai
    // propri dati aziendali senza che nessuno possa più ripristinarlo.
    const targetUser = await User.findByPk(targetUserId, { attributes: ['isTenant'] });
    if (targetUser?.get('isTenant') && role !== RoleCode.OWNER) {
        return { status: 409, message: 'Il ruolo del titolare dello studio non può essere modificato' };
    }

    return null;
}

/** Ruolo BASE dell'utente nel tenant corrente. */
export const updateUserRole = asyncHandler(async (req: Request, res: Response) => {
    const targetUserId = req.params.userId;
    const { role } = req.body as { role?: string };

    const error = await validateRoleChange(req, targetUserId, role);
    if (error) {
        return sendErrorResponse(res, error.status, error.message);
    }

    const tenantId = getCurrentTenantId(req);

    // Uno studio deve sempre avere almeno un titolare, altrimenti nessuno potrebbe più
    // gestire utenti, fatturazione e dati azienda.
    if (role !== RoleCode.OWNER) {
        const current = await TenantUser.findOne({ where: { tenantId, userId: targetUserId } });
        if (current?.get('role') === RoleCode.OWNER) {
            const owners = await TenantUser.count({ where: { tenantId, role: RoleCode.OWNER } });
            if (owners <= 1) {
                return sendErrorResponse(res, 409, 'Lo studio deve avere almeno un titolare');
            }
        }
    }

    await TenantUser.update({ role }, { where: { tenantId, userId: targetUserId } });

    if (role === RoleCode.OWNER) {
        await assignOwnerToAllStructures(tenantId, targetUserId);
    }

    // I permessi viaggiano nell'access token: senza revocare le sessioni, il vecchio ruolo
    // resterebbe valido fino alla scadenza. Così il cambio è effettivo al primo refresh.
    await revokeAllForUser(targetUserId, 'role_changed');

    return sendSuccessResponse(
        res,
        200,
        { userId: targetUserId, tenantId, role },
        'Ruolo aggiornato correttamente'
    );
});

/**
 * Override del ruolo per una singola struttura.
 * `role: null` rimuove l'override e fa tornare valido il ruolo del tenant.
 */
export const updateUserStructureRole = asyncHandler(async (req: Request, res: Response) => {
    const targetUserId = req.params.userId;
    const { structureId, role } = req.body as { structureId?: string; role?: string | null };

    if (!structureId) {
        return sendErrorResponse(res, 400, 'structureId is required');
    }

    const tenantId = getCurrentTenantId(req);

    // La struttura deve appartenere al tenant di chi effettua la modifica.
    const structure = await Structure.findOne({ where: { id: structureId, tenantId } });
    if (!structure) {
        return sendErrorResponse(res, 404, 'Struttura non trovata');
    }

    const assignment = await StructureUser.findOne({
        where: { structureId, userId: targetUserId }
    });
    if (!assignment) {
        return sendErrorResponse(res, 404, 'Utente non assegnato a questa struttura');
    }

    // Rimozione dell'override: torna a valere il ruolo del tenant.
    if (role === null) {
        await StructureUser.update({ role: null }, { where: { structureId, userId: targetUserId } });
        await revokeAllForUser(targetUserId, 'role_changed');
        return sendSuccessResponse(
            res,
            200,
            { userId: targetUserId, structureId, role: null },
            'Override rimosso: vale il ruolo dello studio'
        );
    }

    const membership = await TenantUser.findOne({ where: { tenantId, userId: targetUserId } });
    if (membership?.get('role') === RoleCode.OWNER) {
        return sendErrorResponse(res, 409, 'Il ruolo proprietario vale in tutte le sedi e non ammette override');
    }

    // OWNER è un ruolo del tenant e implica l'accesso a tutte le sedi: non può essere
    // usato come override locale su una singola struttura.
    if (role === RoleCode.OWNER) {
        return sendErrorResponse(res, 400, 'Il ruolo proprietario può essere assegnato solo a livello di studio');
    }

    const error = await validateRoleChange(req, targetUserId, role);
    if (error) {
        return sendErrorResponse(res, error.status, error.message);
    }

    await StructureUser.update({ role }, { where: { structureId, userId: targetUserId } });
    await revokeAllForUser(targetUserId, 'role_changed');

    return sendSuccessResponse(
        res,
        200,
        { userId: targetUserId, structureId, role },
        'Ruolo per la struttura aggiornato correttamente'
    );
});

/**
 * Sincronizza le strutture in cui un utente può operare.
 *
 * Le assegnazioni già esistenti NON vengono ricreate: cancellarle e riscriverle
 * perderebbe gli eventuali override di ruolo per struttura.
 */
export const updateUserStructures = asyncHandler(async (req: Request, res: Response) => {
    const targetUserId = req.params.userId;
    const { structureIds } = req.body as { structureIds?: string[] };

    if (!Array.isArray(structureIds)) {
        return sendErrorResponse(res, 400, 'structureIds deve essere un array');
    }

    const tenantId = getCurrentTenantId(req);

    const membership = await TenantUser.findOne({ where: { tenantId, userId: targetUserId } });
    if (!membership) {
        return sendErrorResponse(res, 404, 'Utente non trovato in questo studio');
    }

    // Si possono assegnare solo strutture del proprio tenant.
    const tenantStructures = await Structure.findAll({ where: { tenantId } });
    const allowedIds = tenantStructures.map((structure) => structure.get('id') as string);
    const requested = [...new Set(structureIds)].filter((id) => allowedIds.includes(id));

    if (requested.length !== new Set(structureIds).size) {
        return sendErrorResponse(res, 400, 'Una o più strutture non appartengono allo studio');
    }

    if (membership.get('role') === RoleCode.OWNER) {
        const ownsEveryStructure = requested.length === allowedIds.length
            && allowedIds.every((id) => requested.includes(id));
        if (!ownsEveryStructure) {
            return sendErrorResponse(res, 409, 'Un proprietario deve essere abilitato a tutte le sedi');
        }
    }

    const current = await StructureUser.findAll({ where: { userId: targetUserId } });
    const currentIds = current
        .map((row) => row.get('structureId') as string)
        .filter((id) => allowedIds.includes(id));

    const toAdd = requested.filter((id) => !currentIds.includes(id));
    const toRemove = currentIds.filter((id) => !requested.includes(id));

    if (toAdd.length > 0) {
        await StructureUser.bulkCreate(
            toAdd.map((structureId) => ({ structureId, userId: targetUserId, role: null }))
        );
    }

    if (toRemove.length > 0) {
        await StructureUser.destroy({
            where: { userId: targetUserId, structureId: { [Op.in]: toRemove } }
        });
    }

    // Le strutture determinano cosa l'utente può vedere: la sessione va riallineata.
    if (toAdd.length > 0 || toRemove.length > 0) {
        await revokeAllForUser(targetUserId, 'structures_changed');
    }

    return sendSuccessResponse(
        res,
        200,
        { userId: targetUserId, structureIds: requested, added: toAdd.length, removed: toRemove.length },
        'Strutture aggiornate correttamente'
    );
});

export default {
    listRoles,
    myPermissions,
    me,
    updateUserRole,
    updateUserStructureRole,
    updateUserStructures
};



