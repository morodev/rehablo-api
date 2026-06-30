import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../../../config/env.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { Tenant, User, Structure, StructureAvailability } from '../models/index.js';
import { findStructureById } from './structure.controller.js';

/**
 * Builds the JWT payload (kept compatible with the previous microservice shape:
 * `tenants: [{id}]`, `selectedPremise`, etc.) so that the frontend doesn't need changes.
 */
function buildTokenPayload(userInstance: any) {
    const payload = { ...userInstance.get({ plain: true }) };
    delete payload.password;
    payload.tenants = (payload.tenants || []).map((t: any) => ({ id: t.id, ...t }));
    payload.selectedPremise = payload.selectedPremise ?? null;
    return payload;
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

    const payload = buildTokenPayload(user);
    const token = signToken(payload);

    return sendSuccessResponse(
        res,
        200,
        { accessToken: token, userId: payload.id, user: payload },
        'Login successful'
    );
});

/** Stateless logout: with JWT-only auth, invalidation is delegated to the client (token deletion). */
export const logout = asyncHandler(async (_req: Request, res: Response) => {
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

    const newToken = signToken(payload);

    return sendSuccessResponse(
        res,
        200,
        {
            accessToken: newToken,
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
        data: decoded
    };

    if (decoded.selectedPremise) {
        const selectedPremise = await findStructureById(decoded.selectedPremise.id);
        return res.status(200).json({ accessToken: token, user: { ...base, selectedPremise } });
    }

    return res.status(200).json({ accessToken: token, user: { ...base, selectedPremise: null } });
});

export default { login, logout, loginPremise, loginWithToken };

