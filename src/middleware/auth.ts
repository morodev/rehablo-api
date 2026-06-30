import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { sendErrorResponse } from '../utils/response.js';

export interface TenantRef {
    id: string;
}

export interface AuthTokenPayload {
    id: string;
    name?: string;
    surname?: string;
    email: string;
    isActive: boolean;
    isSuperAdmin: boolean;
    isTenant?: boolean;
    isPremium?: boolean;
    tenants: TenantRef[];
    selectedPremise?: { id: string } | null;

    [key: string]: unknown;
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            user?: AuthTokenPayload;
        }
    }
}

export function extractToken(req: Request): string | undefined {
    const header = req.header('authorization') || req.header('Authorization');
    if (!header) return undefined;
    const parts = header.split(' ');
    return parts.length > 1 ? parts[1] : parts[0];
}

/**
 * Stateless JWT authentication middleware.
 * Replaces the previous Redis-backed token whitelist (which was also affected by a bug:
 * `redisClient.get(token)` was never awaited, making the check always truthy).
 * Here the token signature/expiration is the single source of truth.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
    const token = extractToken(req);

    if (!token) {
        return sendErrorResponse(res, 401, 'unauthorized');
    }

    try {
        const decoded = jwt.verify(token, env.jwtSecret) as AuthTokenPayload;
        req.user = decoded;
        return next();
    } catch (err) {
        return sendErrorResponse(res, 401, 'invalid or expired token');
    }
}

/** Use on routes that must be restricted to super-admin users. */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
    if (!req.user?.isSuperAdmin) {
        return sendErrorResponse(res, 403, 'forbidden');
    }
    return next();
}

export function getCurrentTenantId(req: Request): string {
    const tenantId = req.user?.tenants?.[0]?.id;
    if (!tenantId) {
        throw new Error('No tenant associated with the authenticated user');
    }
    return tenantId;
}

