import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { Request } from 'express';
import { Op, Transaction } from 'sequelize';
import { env } from '../../../config/env.js';
import { sequelize } from '../../../config/database.js';
import RefreshToken from '../models/refreshToken.model.js';
import User from '../models/user.model.js';
import AccountActionToken from '../models/accountActionToken.model.js';
import { getAuthVersion } from './authState.service.js';

export interface IssuedRefreshToken { token: string; familyId: string; expiresAt: Date; }
export interface RefreshContext {
    tenantId?: string | null;
    structureId?: string | null;
    actor?: 'staff' | 'patient';
    patientAccessId?: string | null;
    /** Versione della credenziale che autorizza l'emissione, non di una lettura successiva. */
    authVersion?: number;
}
function hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }

export async function issueRefreshToken(
    req: Request, userId: string, context: RefreshContext = {}, familyId?: string, transaction?: Transaction
): Promise<IssuedRefreshToken> {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + env.refreshTokenTtlDays);
    const record = await RefreshToken.create({
        userId, tokenHash: hashToken(token), familyId: familyId ?? randomUUID(), expiresAt,
        authVersion: getAuthVersion(context.authVersion),
        tenantId: context.tenantId ?? null, structureId: context.structureId ?? null,
        actor: context.actor ?? 'staff', patientAccessId: context.patientAccessId ?? null,
        userAgent: req.get('user-agent')?.slice(0, 255) ?? null,
        ipAddress: (req.ip ?? req.socket?.remoteAddress ?? null)?.slice(0, 45) ?? null
    }, { transaction });
    return { token, familyId: record.get('familyId'), expiresAt };
}

/** Include i predecessori ruotati: una revoca esplicita non deve lasciare aperta la grace. */
export async function revokeFamily(familyId: string, reason: string, transaction?: Transaction): Promise<void> {
    if (!transaction) {
        const record = await RefreshToken.findOne({ where: { familyId } });
        if (!record) return;
        return withUserLock(record.get('userId'), tx => revokeFamily(familyId, reason, tx));
    }
    await RefreshToken.update({ revokedAt: new Date(), revokedReason: reason }, { where: { familyId }, transaction });
}
export async function revokeAllForUser(userId: string, reason: string, transaction?: Transaction): Promise<number> {
    if (!transaction) return withUserLock(userId, tx => revokeAllForUser(userId, reason, tx));
    const [affected] = await RefreshToken.update({ revokedAt: new Date(), revokedReason: reason }, { where: { userId }, transaction });
    return affected;
}
async function withUserLock<T>(userId: string, action: (transaction: Transaction) => Promise<T>): Promise<T> {
    return sequelize.transaction(async transaction => {
        await User.findByPk(userId, { attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
        return action(transaction);
    });
}

export type RotationFailure = 'not_found' | 'expired' | 'reused' | 'invalid_session';
export interface RotationSuccess {
    ok: true;
    userId: string;
    familyId: string;
    tenantId: string | null;
    structureId: string | null;
    actor: 'staff' | 'patient';
    patientAccessId: string | null;
    authVersion: number;
    refresh: IssuedRefreshToken;
}
export interface RotationError { ok: false; reason: RotationFailure; }

/** Rotazione e reset serializzano sulla stessa riga User prima di bloccare i token. */
export async function rotateRefreshToken(req: Request, presentedToken: string): Promise<RotationSuccess | RotationError> {
    if (typeof presentedToken !== 'string' || !presentedToken) return { ok: false, reason: 'not_found' };
    const tokenHash = hashToken(presentedToken);
    const candidate = await RefreshToken.findOne({ where: { tokenHash } });
    if (!candidate) return { ok: false, reason: 'not_found' };

    return sequelize.transaction(async transaction => {
        const user = await User.findByPk(candidate.get('userId'), { transaction, lock: transaction.LOCK.UPDATE });
        const record = await RefreshToken.findOne({ where: { tokenHash }, transaction, lock: transaction.LOCK.UPDATE });
        if (!record) return { ok: false, reason: 'not_found' };
        if (!user || !user.get('isActive') || user.get('deactivatedAt') ||
            getAuthVersion(record.get('authVersion')) !== getAuthVersion(user.get('authVersion'))) {
            return { ok: false, reason: 'invalid_session' };
        }
        // La scadenza e la versione precedono anche la finestra di tolleranza.
        if (new Date(record.get('expiresAt')).getTime() <= Date.now()) return { ok: false, reason: 'expired' };
        const familyId = record.get('familyId');
        const userId = record.get('userId');
        const context = {
            tenantId: record.get('tenantId') ?? null, structureId: record.get('structureId') ?? null,
            actor: record.get('actor') || 'staff', patientAccessId: record.get('patientAccessId') ?? null,
            authVersion: getAuthVersion(record.get('authVersion'))
        };
        const revokedAt = record.get('revokedAt');
        if (revokedAt) {
            const elapsedMs = Date.now() - new Date(revokedAt).getTime();
            if (record.get('revokedReason') !== 'rotated' || elapsedMs < 0 || elapsedMs > env.refreshTokenGraceSeconds * 1000) {
                await revokeFamily(familyId, 'reuse_detected', transaction);
                return { ok: false, reason: 'reused' };
            }
        } else {
            await record.update({ revokedAt: new Date(), revokedReason: 'rotated' }, { transaction });
        }
        const refresh = await issueRefreshToken(req, userId, context, familyId, transaction);
        return { ok: true, userId, familyId, ...context, refresh };
    });
}

export async function revokeForPatientAccess(patientAccessId: string, reason: string): Promise<number> {
    const record = await RefreshToken.findOne({ where: { patientAccessId } });
    if (!record) return 0;
    return withUserLock(record.get('userId'), async transaction => {
        const [affected] = await RefreshToken.update({ revokedAt: new Date(), revokedReason: reason }, { where: { patientAccessId }, transaction });
        return affected;
    });
}
export async function revokeForTenantMembership(userId: string, tenantId: string, reason: string): Promise<number> {
    return withUserLock(userId, async transaction => {
        const [affected] = await RefreshToken.update({ revokedAt: new Date(), revokedReason: reason }, { where: { userId, tenantId, actor: 'staff' }, transaction });
        return affected;
    });
}

/** La famiglia è la sola sessione corrente; gli altri dispositivi mantengono la loro famiglia. */
export async function revokeRefreshToken(presentedToken: string, reason = 'logout'): Promise<void> {
    if (typeof presentedToken !== 'string' || !presentedToken) return;
    const record = await RefreshToken.findOne({ where: { tokenHash: hashToken(presentedToken) } });
    if (!record) return;
    await sequelize.transaction(async transaction => {
        await User.findByPk(record.get('userId'), { transaction, lock: transaction.LOCK.UPDATE });
        await revokeFamily(record.get('familyId'), reason, transaction);
    });
}

/** Pulizia già schedulata dal bootstrap: comprende anche i link account scaduti. */
export async function purgeExpiredRefreshTokens(): Promise<number> {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - 30);
    const count = await RefreshToken.destroy({ where: {
        [Op.or]: [{ expiresAt: { [Op.lt]: new Date() } }, { revokedAt: { [Op.lt]: threshold } }]
    } });
    await AccountActionToken.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });
    return count;
}
