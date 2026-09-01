import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Op } from 'sequelize';
import { env } from '../../../config/env.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import {
    PatientPortalAccess,
    Structure,
    StructureAvailability,
    StructureUser,
    Tenant,
    TenantUser,
    User
} from '../models/index.js';
import { findUserByIdentityEmail } from '../services/identity.service.js';
import { getRolePermissions, RoleCode } from '../rbac/roles.js';
import { issueRefreshToken, revokeRefreshToken } from '../services/refreshToken.service.js';

export interface SessionContextSummary {
    id: string;
    actor: 'staff' | 'patient';
    tenantId: string;
    tenantName: string;
    status: 'ACTIVE' | 'HISTORICAL';
    requiresPremise: boolean;
}

function signSelectionToken(user: User): string {
    return jwt.sign(
        {
            sub: user.get('id'),
            id: user.get('id'),
            email: user.get('email'),
            isActive: user.get('isActive'),
            isSuperAdmin: user.get('isSuperAdmin'),
            tenants: [],
            tokenUse: 'context_selection'
        },
        env.jwtSecret,
        { expiresIn: '10m' }
    );
}

function signApplicationToken(payload: Record<string, unknown>): string {
    return jwt.sign({ ...payload, tokenUse: 'application' }, env.jwtSecret, {
        expiresIn: env.jwtExpiresIn
    } as jwt.SignOptions);
}

async function contextsForUser(userId: string): Promise<SessionContextSummary[]> {
    const [staffMemberships, patientAccesses] = await Promise.all([
        TenantUser.findAll({ where: { userId, deactivatedAt: { [Op.is]: null } } }),
        PatientPortalAccess.findAll({
            where: { userId, status: { [Op.in]: ['ACTIVE', 'HISTORICAL'] } }
        })
    ]);

    const tenantIds = [
        ...staffMemberships.map((membership) => membership.get('tenantId') as string),
        ...patientAccesses.map((access) => access.get('tenantId') as string)
    ];
    const tenants = tenantIds.length
        ? await Tenant.findAll({ where: { id: { [Op.in]: [...new Set(tenantIds)] } } })
        : [];
    const tenantById = new Map(tenants.map((tenant) => [tenant.get('id') as string, tenant]));

    const staffContexts = staffMemberships
        .flatMap<SessionContextSummary>((membership) => {
            const tenantId = membership.get('tenantId') as string;
            const tenant = tenantById.get(tenantId);
            if (!tenant) return [];
            return [{
                id: `staff:${tenantId}`,
                actor: 'staff' as const,
                tenantId,
                tenantName: (tenant.get('businessName') as string | null) || 'Centro Rehablo',
                status: 'ACTIVE' as const,
                requiresPremise: true
            }];
        });

    const patientContexts = patientAccesses
        .flatMap<SessionContextSummary>((access) => {
            const tenantId = access.get('tenantId') as string;
            const tenant = tenantById.get(tenantId);
            if (!tenant) return [];
            return [{
                id: `patient:${access.get('id') as string}`,
                actor: 'patient' as const,
                tenantId,
                tenantName: (tenant.get('businessName') as string | null) || 'Centro Rehablo',
                status: access.get('status') as 'ACTIVE' | 'HISTORICAL',
                requiresPremise: false
            }];
        });

    return [...staffContexts, ...patientContexts].sort((a, b) =>
        a.tenantName.localeCompare(b.tenantName, 'it')
    );
}

export const createSession = asyncHandler(async (req: Request, res: Response) => {
    const user = await findUserByIdentityEmail(req.body?.email);
    const password = req.body?.password;
    if (!user || typeof password !== 'string') {
        return sendErrorResponse(res, 401, 'Email o password errati');
    }
    const validPassword = await bcrypt.compare(password, user.get('password') as string);
    if (!validPassword) return sendErrorResponse(res, 401, 'Email o password errati');
    if (!user.get('isActive')) {
        return sendErrorResponse(res, 403, 'Account non ancora verificato');
    }
    if (user.get('deactivatedAt')) {
        return sendErrorResponse(res, 403, 'Account non disponibile');
    }

    const contexts = await contextsForUser(user.get('id') as string);
    if (contexts.length === 0) {
        return sendErrorResponse(res, 403, 'Nessun centro disponibile per questo account');
    }

    return sendSuccessResponse(res, 200, {
        selectionToken: signSelectionToken(user),
        contexts,
        user: {
            id: user.get('id'),
            name: user.get('name'),
            surname: user.get('surname'),
            email: user.get('email')
        }
    }, 'Contesti disponibili');
});

export const listSessionContexts = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user?.sub as string | undefined) ?? req.user?.id;
    const user = userId ? await User.findByPk(userId) : null;
    if (!user) return sendErrorResponse(res, 401, 'Utente non trovato');

    return sendSuccessResponse(res, 200, {
        selectionToken: signSelectionToken(user),
        contexts: await contextsForUser(userId!)
    }, 'Contesti disponibili');
});

export const selectSessionContext = asyncHandler(async (req: Request, res: Response) => {
    const { selectionToken, contextId, refreshToken: previousRefreshToken } = req.body ?? {};
    let decoded: any;
    try {
        decoded = jwt.verify(selectionToken, env.jwtSecret);
    } catch {
        return sendErrorResponse(res, 401, 'Selezione contesto scaduta');
    }
    if (decoded?.tokenUse !== 'context_selection' || !decoded?.sub || typeof contextId !== 'string') {
        return sendErrorResponse(res, 401, 'Selezione contesto non valida');
    }

    const user = await User.findByPk(decoded.sub);
    if (!user || !user.get('isActive') || user.get('deactivatedAt')) {
        return sendErrorResponse(res, 403, 'Account non disponibile');
    }

    const basePayload: Record<string, unknown> = {
        ...user.get({ plain: true }),
        password: undefined,
        sub: user.get('id'),
        id: user.get('id'),
        selectedPremise: null
    };
    delete basePayload.password;

    if (contextId.startsWith('staff:')) {
        const tenantId = contextId.slice('staff:'.length);
        const membership = await TenantUser.findOne({
            where: { tenantId, userId: user.get('id'), deactivatedAt: { [Op.is]: null } }
        });
        const tenant = membership ? await Tenant.findByPk(tenantId) : null;
        if (!membership || !tenant) return sendErrorResponse(res, 403, 'Contesto non disponibile');

        const assignments = await StructureUser.findAll({
            where: { userId: user.get('id') },
            attributes: ['structureId']
        });
        const structureIds = assignments.map((assignment) => assignment.get('structureId') as string);
        const structures = structureIds.length
            ? await Structure.findAll({
                where: { tenantId, id: { [Op.in]: structureIds } },
                include: [{ model: StructureAvailability }],
                order: [[StructureAvailability, 'day', 'ASC']]
            })
            : [];
        const role = membership.get('role') as RoleCode;
        const payload = {
            ...basePayload,
            actor: 'staff',
            tid: tenantId,
            sid: null,
            role,
            perms: getRolePermissions(role),
            tenants: [tenant.get({ plain: true })],
            structures: structures.map((structure) => structure.get({ plain: true }))
        };
        const refresh = await issueRefreshToken(req, user.get('id') as string, {
            tenantId,
            structureId: null,
            actor: 'staff'
        });
        if (previousRefreshToken) await revokeRefreshToken(previousRefreshToken, 'context_switch');

        return sendSuccessResponse(res, 200, {
            accessToken: signApplicationToken(payload),
            refreshToken: refresh.token,
            user: payload,
            context: { id: contextId, actor: 'staff', tenantId, requiresPremise: true }
        }, 'Contesto selezionato');
    }

    if (contextId.startsWith('patient:')) {
        const accessId = contextId.slice('patient:'.length);
        const access = await PatientPortalAccess.findOne({
            where: {
                id: accessId,
                userId: user.get('id'),
                status: { [Op.in]: ['ACTIVE', 'HISTORICAL'] }
            }
        });
        const tenantId = access?.get('tenantId') as string | undefined;
        const tenant = tenantId ? await Tenant.findByPk(tenantId) : null;
        if (!access || !tenant || !tenantId) {
            return sendErrorResponse(res, 403, 'Contesto non disponibile');
        }

        const payload = {
            ...basePayload,
            isSuperAdmin: false,
            isTenant: false,
            actor: 'patient',
            tid: tenantId,
            sid: null,
            pid: access.get('patientId'),
            patientAccessId: access.get('id'),
            contextStatus: access.get('status'),
            role: RoleCode.PATIENT,
            perms: getRolePermissions(RoleCode.PATIENT),
            tenants: [{ id: tenantId, businessName: tenant.get('businessName') }],
            structures: []
        };
        const refresh = await issueRefreshToken(req, user.get('id') as string, {
            tenantId,
            structureId: null,
            actor: 'patient',
            patientAccessId: access.get('id') as string
        });
        if (previousRefreshToken) await revokeRefreshToken(previousRefreshToken, 'context_switch');

        return sendSuccessResponse(res, 200, {
            accessToken: signApplicationToken(payload),
            refreshToken: refresh.token,
            user: payload,
            context: {
                id: contextId,
                actor: 'patient',
                tenantId,
                status: access.get('status'),
                requiresPremise: false
            }
        }, 'Contesto selezionato');
    }

    return sendErrorResponse(res, 400, 'Tipo di contesto non valido');
});

export default { createSession, listSessionContexts, selectSessionContext };
