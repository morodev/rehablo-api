import jwt from 'jsonwebtoken';
import { env } from '../../../config/env.js';
import { getAuthVersion } from './authState.service.js';

/** Profile data belongs in the response, never in a bearer token or HTTP header. */
function authenticationClaims(payload: Record<string, unknown>): Record<string, unknown> {
    const claims: Record<string, unknown> = {};
    for (const field of [
        'id', 'sub', 'email', 'isActive', 'isSuperAdmin', 'isTenant', 'isPremium',
        'actor', 'tid', 'sid', 'role', 'perms', 'permissions', 'pid', 'patientAccessId',
        'contextStatus', 'tokenUse', 'authVersion', 'iat', 'exp', 'nbf', 'iss', 'aud', 'jti'
    ]) {
        if (payload[field] !== undefined) claims[field] = payload[field];
    }
    // Keep legacy identity references without copying names, schedules or metadata.
    if (Array.isArray(payload.tenants)) {
        claims.tenants = payload.tenants.filter(tenant => typeof tenant?.id === 'string')
            .map(tenant => ({id: tenant.id}));
    }
    const premise = payload.selectedPremise as {id?: unknown} | null | undefined;
    if (premise === null) claims.selectedPremise = null;
    else if (typeof premise?.id === 'string') claims.selectedPremise = {id: premise.id};
    return claims;
}

export function signApplicationToken(payload: Record<string, unknown>): string {
    return jwt.sign({ ...authenticationClaims(payload), authVersion: getAuthVersion(payload.authVersion), tokenUse: 'application' }, env.jwtSecret, {
        expiresIn: env.jwtExpiresIn
    } as jwt.SignOptions);
}

/** Caller must verify first. Preserve the original expiration and authentication claims. */
export function compactVerifiedApplicationToken(payload: Record<string, unknown>): string {
    return jwt.sign(authenticationClaims(payload), env.jwtSecret);
}
