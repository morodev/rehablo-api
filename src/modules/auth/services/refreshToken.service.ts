import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { Request } from 'express';
import { Op } from 'sequelize';
import { env } from '../../../config/env.js';
import RefreshToken from '../models/refreshToken.model.js';

/** Numero di byte casuali del token opaco: 256 bit, non indovinabile per forza bruta. */
const TOKEN_BYTES = 32;

export interface IssuedRefreshToken {
    /** Valore in chiaro: consegnato al client UNA sola volta, mai più recuperabile. */
    token: string;
    familyId: string;
    expiresAt: Date;
}

export interface RefreshContext {
    tenantId?: string | null;
    structureId?: string | null;
    actor?: 'staff' | 'patient';
    patientAccessId?: string | null;
}

function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

function expiryDate(): Date {
    const date = new Date();
    date.setDate(date.getDate() + env.refreshTokenTtlDays);
    return date;
}

function clientInfo(req: Request) {
    return {
        userAgent: req.get('user-agent')?.slice(0, 255) ?? null,
        ipAddress: (req.ip ?? req.socket?.remoteAddress ?? null)?.slice(0, 45) ?? null
    };
}

/**
 * Emette un nuovo refresh token, aprendo una nuova famiglia (tipicamente: al login).
 * Passando `familyId` si prosegue invece una catena esistente (rotazione).
 */
export async function issueRefreshToken(
    req: Request,
    userId: string,
    context: RefreshContext = {},
    familyId?: string
): Promise<IssuedRefreshToken> {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    const expiresAt = expiryDate();

    const record = await RefreshToken.create({
        userId,
        tokenHash: hashToken(token),
        familyId: familyId ?? randomUUID(),
        expiresAt,
        tenantId: context.tenantId ?? null,
        structureId: context.structureId ?? null,
        actor: context.actor ?? 'staff',
        patientAccessId: context.patientAccessId ?? null,
        ...clientInfo(req)
    });

    return { token, familyId: record.get('familyId') as string, expiresAt };
}

/** Revoca ogni token ancora attivo di una famiglia: usata su riuso sospetto e al logout. */
export async function revokeFamily(familyId: string, reason: string): Promise<void> {
    await RefreshToken.update(
        { revokedAt: new Date(), revokedReason: reason },
        { where: { familyId, revokedAt: { [Op.is]: null } } }
    );
}

/** Revoca tutte le sessioni di un utente (cambio password, disattivazione, cambio ruolo). */
export async function revokeAllForUser(userId: string, reason: string): Promise<number> {
    const [affected] = await RefreshToken.update(
        { revokedAt: new Date(), revokedReason: reason },
        { where: { userId, revokedAt: { [Op.is]: null } } }
    );
    return affected;
}

export type RotationFailure =
    | 'not_found'
    | 'expired'
    /** Token già usato: probabile furto, la famiglia è stata revocata per precauzione. */
    | 'reused';

export interface RotationSuccess {
    ok: true;
    userId: string;
    familyId: string;
    tenantId: string | null;
    structureId: string | null;
    actor: 'staff' | 'patient';
    patientAccessId: string | null;
    refresh: IssuedRefreshToken;
}

export interface RotationError {
    ok: false;
    reason: RotationFailure;
}

/**
 * Valida un refresh token e lo ruota.
 *
 * Il vecchio token viene invalidato subito: se qualcuno lo ripresenta (perché lo ha copiato),
 * il tentativo cade nel ramo `reused` e l'intera famiglia viene revocata — il legittimo
 * proprietario dovrà rifare il login, ma l'attaccante resta tagliato fuori.
 *
 * ECCEZIONE (finestra di tolleranza, `REFRESH_TOKEN_GRACE_SECONDS`): la rotazione revoca il
 * token PRIMA che il client possa aver salvato il successore. Se la risposta non arriva a
 * destinazione — F5 durante la chiamata, connessione che cade, due tab che rinnovano nello
 * stesso istante — il client resta legittimamente in mano un token già `rotated`. Trattarlo
 * come furto significa revocare la famiglia e sbattere l'utente sulla pagina di login senza
 * possibilità di rientrare: era esattamente il sintomo "il refresh non rientra più".
 * Dentro la finestra, quindi, si riemette semplicemente un token nella stessa famiglia.
 */
export async function rotateRefreshToken(
    req: Request,
    presentedToken: string
): Promise<RotationSuccess | RotationError> {
    if (!presentedToken) {
        return { ok: false, reason: 'not_found' };
    }

    const record = await RefreshToken.findOne({ where: { tokenHash: hashToken(presentedToken) } });

    if (!record) {
        return { ok: false, reason: 'not_found' };
    }

    const familyId = record.get('familyId') as string;
    const userId = record.get('userId') as string;
    const tenantId = (record.get('tenantId') as string) ?? null;
    const structureId = (record.get('structureId') as string) ?? null;
    const actor = ((record.get('actor') as string) || 'staff') as 'staff' | 'patient';
    const patientAccessId = (record.get('patientAccessId') as string) ?? null;

    const revokedAt = record.get('revokedAt') as Date | null;

    if (revokedAt) {
        const revokedReason = (record.get('revokedReason') as string) ?? null;
        const elapsedMs = Date.now() - new Date(revokedAt).getTime();
        const withinGrace = elapsedMs <= env.refreshTokenGraceSeconds * 1000;

        // Solo una ROTAZIONE recente è compatibile con una risposta persa. Logout, cambio sede
        // e reuse detection sono revoche volontarie: lì il rifiuto deve restare secco.
        if (revokedReason === 'rotated' && withinGrace) {
            const refresh = await issueRefreshToken(
                req,
                userId,
                { tenantId, structureId, actor, patientAccessId },
                familyId
            );
            return { ok: true, userId, familyId, tenantId, structureId, actor, patientAccessId, refresh };
        }

        await revokeFamily(familyId, 'reuse_detected');
        return { ok: false, reason: 'reused' };
    }

    if ((record.get('expiresAt') as Date).getTime() <= Date.now()) {
        return { ok: false, reason: 'expired' };
    }


    // Rotazione: prima invalido il token presentato, poi ne emetto uno nuovo nella stessa famiglia.
    await record.update({ revokedAt: new Date(), revokedReason: 'rotated' });
    const refresh = await issueRefreshToken(
        req,
        userId,
        { tenantId, structureId, actor, patientAccessId },
        familyId
    );

    return { ok: true, userId, familyId, tenantId, structureId, actor, patientAccessId, refresh };
}

/** Revoca soltanto le sessioni del collegamento paziente indicato. */
export async function revokeForPatientAccess(patientAccessId: string, reason: string): Promise<number> {
    const [affected] = await RefreshToken.update(
        { revokedAt: new Date(), revokedReason: reason },
        { where: { patientAccessId, revokedAt: { [Op.is]: null } } }
    );
    return affected;
}

/** Revoca le sessioni staff di un solo tenant senza interrompere gli altri centri. */
export async function revokeForTenantMembership(userId: string, tenantId: string, reason: string): Promise<number> {
    const [affected] = await RefreshToken.update(
        { revokedAt: new Date(), revokedReason: reason },
        { where: { userId, tenantId, actor: 'staff', revokedAt: { [Op.is]: null } } }
    );
    return affected;
}

/** Revoca il singolo token presentato (logout della sola sessione corrente). */
export async function revokeRefreshToken(presentedToken: string, reason = 'logout'): Promise<void> {
    if (!presentedToken) return;
    await RefreshToken.update(
        { revokedAt: new Date(), revokedReason: reason },
        { where: { tokenHash: hashToken(presentedToken), revokedAt: { [Op.is]: null } } }
    );
}

/**
 * Rimuove i token scaduti o revocati da oltre 30 giorni: senza questa pulizia la tabella
 * cresce indefinitamente (un refresh a ogni 15 minuti di utilizzo).
 */
export async function purgeExpiredRefreshTokens(): Promise<number> {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - 30);

    return RefreshToken.destroy({
        where: {
            [Op.or]: [{ expiresAt: { [Op.lt]: new Date() } }, { revokedAt: { [Op.lt]: threshold } }]
        }
    });
}




