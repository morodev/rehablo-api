import jwt from 'jsonwebtoken';
import { env } from '../../../config/env.js';
import { getAuthVersion } from './authState.service.js';

/** Availability is response data. Including its seven rows in a JWT can overflow HTTP headers. */
function withoutCalendarProfile(payload: Record<string, unknown>): Record<string, unknown> {
    const { calendarEnabled, availabilityMode, userAvailabilities, ...claims } = payload;
    return claims;
}

export function signApplicationToken(payload: Record<string, unknown>): string {
    return jwt.sign({ ...withoutCalendarProfile(payload), authVersion: getAuthVersion(payload.authVersion), tokenUse: 'application' }, env.jwtSecret, {
        expiresIn: env.jwtExpiresIn
    } as jwt.SignOptions);
}

/** Caller must verify first. Preserve the original expiration and every authentication claim. */
export function compactVerifiedApplicationToken(payload: Record<string, unknown>): string {
    return jwt.sign(withoutCalendarProfile(payload), env.jwtSecret);
}
