import { createHash, randomBytes } from 'node:crypto';
import { Op, Transaction } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import AccountActionToken, { AccountActionPurpose } from '../models/accountActionToken.model.js';
import User from '../models/user.model.js';
import UserEmail, { normalizeIdentityEmail } from '../models/userEmail.model.js';
import { getAuthVersion } from './authState.service.js';
import { revokeAllForUser } from './refreshToken.service.js';

export const ACCOUNT_ACTION_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
export class AccountActionTokenError extends Error {
    readonly code = 'ACCOUNT_ACTION_TOKEN_INVALID';
    constructor() { super('Link non valido, scaduto o già utilizzato. Richiedi un nuovo link.'); }
}
function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }

export async function issueAccountActionToken(
    userId: string, email: string, purpose: AccountActionPurpose, transaction?: Transaction
): Promise<string> {
    const normalizedEmail = normalizeIdentityEmail(email);
    if (!normalizedEmail) throw new AccountActionTokenError();
    const token = randomBytes(32).toString('hex');
    await AccountActionToken.create({
        userId, normalizedEmail, purpose, tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + ACCOUNT_ACTION_TOKEN_TTL_MS)
    }, { transaction });
    return token;
}

/** Nessun fallback JWT: i vecchi link non distinguono verifica e cambio password. */
export async function consumeAccountActionToken(
    presentedToken: unknown, purpose: AccountActionPurpose, hashedPassword?: string
): Promise<void> {
    if (typeof presentedToken !== 'string' || !/^[a-f0-9]{64}$/.test(presentedToken)) throw new AccountActionTokenError();
    if (purpose === 'reset_password' && !hashedPassword) throw new AccountActionTokenError();
    const hash = tokenHash(presentedToken);
    // Questo lookup individua soltanto il lock: ogni condizione viene ricontrollata in transazione.
    const candidate = await AccountActionToken.findOne({ where: { tokenHash: hash, purpose } });
    if (!candidate) throw new AccountActionTokenError();
    await sequelize.transaction(async transaction => {
        // Ordine condiviso con refresh: User -> token -> altri token. Nessun reset/refresh
        // può emettere una sessione della nuova versione partendo da una vecchia credenziale.
        const user = await User.findByPk(candidate.get('userId'), { transaction, lock: transaction.LOCK.UPDATE });
        if (!user) throw new AccountActionTokenError();
        const record = await AccountActionToken.findOne({
            where: { tokenHash: hash, purpose, userId: user.get('id') }, transaction, lock: transaction.LOCK.UPDATE
        });
        if (!record || record.get('consumedAt') || record.get('invalidatedAt') ||
            new Date(record.get('expiresAt')).getTime() <= Date.now()) throw new AccountActionTokenError();
        const email = record.get('normalizedEmail');
        const alias = await UserEmail.findOne({ where: { normalizedEmail: email }, transaction });
        if (alias ? alias.get('userId') !== user.get('id') : normalizeIdentityEmail(user.get('email')) !== email) {
            throw new AccountActionTokenError();
        }
        const now = new Date();
        await record.update({ consumedAt: now }, { transaction });
        if (purpose === 'verify_email') {
            // Verificare una email non revoca la sospensione dell'identità o della membership.
            await user.update({ isActive: true }, { transaction });
            if (alias && !alias.get('verifiedAt')) await alias.update({ verifiedAt: now }, { transaction });
            return;
        }
        await user.update({ password: hashedPassword!, authVersion: getAuthVersion(user.get('authVersion')) + 1 }, { transaction });
        await AccountActionToken.update({ invalidatedAt: now }, { where: {
            userId: user.get('id'), purpose: 'reset_password', consumedAt: null, invalidatedAt: null
        }, transaction });
        await revokeAllForUser(user.get('id'), 'password_changed', transaction);
    });
}

export async function purgeExpiredAccountActionTokens(): Promise<number> {
    return AccountActionToken.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });
}
