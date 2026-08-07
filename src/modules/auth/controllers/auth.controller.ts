import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../../../config/env.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { Tenant, User, Structure, StructureAvailability, TenantUser, StructureUser } from '../models/index.js';
import { findStructureById } from './structure.controller.js';
import { getRolePermissions, resolveEffectiveRole } from '../rbac/roles.js';
import {
    issueRefreshToken,
    revokeFamily,
    revokeRefreshToken,
    rotateRefreshToken
} from '../services/refreshToken.service.js';

/**
 * Builds the JWT payload (kept compatible with the previous microservice shape:
 * `tenants: [{id}]`, `selectedPremise`, etc.) so that the frontend doesn't need changes.
 */
function buildTokenPayload(userInstance: any) {
    const payload = { ...userInstance.get({ plain: true }) };
    delete payload.password;
    payload.tenants = (payload.tenants || []).map((t: any) => ({ id: t.id, ...t }));
    payload.selectedPremise = payload.selectedPremise ?? null;
    payload.sub = payload.id;
    payload.actor = 'staff';
    return payload;
}

/**
 * Calcola i claim RBAC della sessione (vedi docs/RBAC_DESIGN.md).
 *
 * Il ruolo effettivo è l'override sulla struttura selezionata, con fallback
 * sul ruolo base che l'utente ha nel tenant.
 */
async function buildRbacClaims(userId: string, tenantId?: string | null, structureId?: string | null) {
    let tenantRole: string | null = null;
    if (tenantId) {
        const membership = await TenantUser.findOne({ where: { tenantId, userId } });
        tenantRole = (membership?.get('role') as string) ?? null;
    }

    let structureRole: string | null = null;
    if (structureId) {
        const assignment = await StructureUser.findOne({ where: { structureId, userId } });
        structureRole = (assignment?.get('role') as string) ?? null;
    }

    const role = resolveEffectiveRole(tenantRole, structureRole);

    return {
        tid: tenantId ?? null,
        sid: structureId ?? null,
        role,
        perms: getRolePermissions(role)
    };
}

function signToken(payload: object) {
    return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as jwt.SignOptions);
}

export const login = asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body;

    const user = await User.findOne({
        where: { email },
        include: [
            { model: Structure, include: [{ model: StructureAvailability }] },
            Tenant
        ],
        order: [[Structure, StructureAvailability, 'day', 'ASC']]
    });

    if (!user) {
        return sendErrorResponse(res, 401, 'Wrong password!');
    }

    const isEqual = await bcrypt.compare(password, user.get('password') as string);
    if (!isEqual) {
        return sendErrorResponse(res, 401, 'Wrong password!');
    }

    if (!user.get('isActive')) {
        return sendErrorResponse(res, 403, 'User not active!');
    }

    // Account sospeso da un amministratore: distinto dalla mancata verifica dell'email,
    // così il messaggio è comprensibile e reinviare la verifica non riapre l'accesso.
    if (user.get('deactivatedAt')) {
        return sendErrorResponse(res, 403, 'Account disattivato. Contatta il titolare dello studio.');
    }

    const payload = buildTokenPayload(user);
    const tenantId = payload.tenants?.[0]?.id ?? null;
    Object.assign(payload, await buildRbacClaims(payload.id, tenantId, null));
    const token = signToken(payload);

    // Sessione lunga garantita dal refresh token: l'access token dura pochi minuti.
    const refresh = await issueRefreshToken(req, payload.id, { tenantId, structureId: null });

    return sendSuccessResponse(
        res,
        200,
        {
            accessToken: token,
            refreshToken: refresh.token,
            expiresIn: env.jwtExpiresIn,
            userId: payload.id,
            user: payload
        },
        'Login successful'
    );
});

/**
 * Scambia un refresh token valido con una nuova coppia access+refresh.
 *
 * Ruolo e permessi vengono RICALCOLATI dal database a ogni refresh: è il motivo per cui
 * l'access token può restare breve senza penalizzare l'esperienza, e per cui una modifica
 * di ruolo diventa effettiva entro pochi minuti invece che a fine sessione.
 */
export const refresh = asyncHandler(async (req: Request, res: Response) => {
    const presented = req.body?.refreshToken;

    const result = await rotateRefreshToken(req, presented);

    if (!result.ok) {
        // `reused` indica un token già ruotato: la famiglia è stata revocata per precauzione.
        const message =
            result.reason === 'reused'
                ? 'Sessione compromessa: effettua nuovamente il login'
                : 'Refresh token non valido o scaduto';
        return sendErrorResponse(res, 401, message);
    }

    const user = await User.findOne({
        where: { id: result.userId },
        attributes: { exclude: ['password'] },
        include: [{ model: Structure, include: [{ model: StructureAvailability }] }, Tenant],
        order: [[Structure, StructureAvailability, 'day', 'ASC']]
    });

    if (!user) {
        return sendErrorResponse(res, 401, 'Utente non trovato');
    }

    if (!user.get('isActive')) {
        // Utente disattivato mentre la sessione era attiva: la catena va chiusa subito.
        await revokeFamily(result.familyId, 'user_inactive');
        return sendErrorResponse(res, 403, 'User not active!');
    }

    if (user.get('deactivatedAt')) {
        // Sospensione decisa dopo il login: la sessione non deve poter essere rinnovata.
        await revokeFamily(result.familyId, 'user_deactivated');
        return sendErrorResponse(res, 403, 'Account disattivato. Contatta il titolare dello studio.');
    }

    const payload = buildTokenPayload(user);

    if (result.structureId) {
        const premise = await Structure.findOne({
            where: { id: result.structureId },
            include: [{ model: StructureAvailability }],
            order: [[StructureAvailability, 'day', 'ASC']]
        });
        payload.selectedPremise = premise ? premise.get({ plain: true }) : null;
    }

    Object.assign(payload, await buildRbacClaims(payload.id, result.tenantId, result.structureId));

    return sendSuccessResponse(
        res,
        200,
        {
            accessToken: signToken(payload),
            refreshToken: result.refresh.token,
            expiresIn: env.jwtExpiresIn,
            userId: payload.id,
            user: payload
        },
        'Token refreshed'
    );
});

/**
 * Logout: revoca il refresh token presentato nel body.
 *
 * Non richiede un access token valido: deve funzionare anche a sessione scaduta, altrimenti
 * il refresh token resterebbe attivo per giorni dopo che l'utente ha lasciato l'applicazione.
 * Conoscere il refresh token è di per sé la prova di possesso della sessione.
 * L'access token, essendo stateless, resta valido fino alla naturale scadenza (pochi minuti).
 */
export const logout = asyncHandler(async (req: Request, res: Response) => {
    await revokeRefreshToken(req.body?.refreshToken, 'logout');
    return sendSuccessResponse(res, 200, {}, 'Logout successful');
});

export const loginPremise = asyncHandler(async (req: Request, res: Response) => {
    const structureId = req.params.premiseId;
    const tenantId = req.user!.tenants[0].id;
    const email = req.user!.email;

    const premise = await Structure.findOne({
        where: { id: structureId, tenantId },
        include: [{ model: StructureAvailability }],
        order: [[StructureAvailability, 'day', 'ASC']]
    });

    if (!premise) {
        return sendErrorResponse(res, 404, 'Structure not found');
    }

    const user = await User.findOne({
        where: { email },
        attributes: { exclude: ['password'] },
        include: [
            { model: Structure, include: [{ model: StructureAvailability }] },
            Tenant
        ],
        order: [[Structure, StructureAvailability, 'day', 'ASC']]
    });

    if (!user) {
        return sendErrorResponse(res, 404, 'User not found');
    }

    const payload = buildTokenPayload(user);
    payload.selectedPremise = premise.get({ plain: true });
    // Il ruolo può essere sovrascritto per struttura: i permessi vanno ricalcolati.
    Object.assign(payload, await buildRbacClaims(payload.id, tenantId, structureId));

    const newToken = signToken(payload);

    // La struttura selezionata cambia i permessi effettivi: il refresh token la memorizza,
    // così anche i rinnovi successivi restano coerenti con il premise scelto.
    const refresh = await issueRefreshToken(req, payload.id, { tenantId, structureId });

    return sendSuccessResponse(
        res,
        200,
        {
            accessToken: newToken,
            refreshToken: refresh.token,
            expiresIn: env.jwtExpiresIn,
            selectedPremises: premise,
            userId: payload.id,
            tenantId,
            user: payload
        },
        'Login successful'
    );
});

export const loginWithToken = asyncHandler(async (req: Request, res: Response) => {
    const token = req.body.accessToken;
    const decoded = jwt.verify(token, env.jwtSecret) as any;

    const base = {
        id: decoded.id,
        name: decoded.name,
        surname: decoded.surname,
        email: decoded.email,
        isActive: decoded.isActive,
        isSuperAdmin: decoded.isSuperAdmin,
        role: decoded.role ?? null,
        perms: decoded.perms ?? [],
        data: decoded
    };

    if (decoded.selectedPremise) {
        const selectedPremise = await findStructureById(decoded.selectedPremise.id);
        return res.status(200).json({ accessToken: token, user: { ...base, selectedPremise } });
    }

    return res.status(200).json({ accessToken: token, user: { ...base, selectedPremise: null } });
});

export default { login, logout, loginPremise, loginWithToken, refresh };

