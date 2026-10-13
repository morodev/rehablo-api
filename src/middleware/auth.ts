import {assertBillingAccess} from '../modules/billing/services/billingAccess.service.js';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { sendErrorResponse } from '../utils/response.js';
import { AuthStateError, resolveApplicationPrincipal } from '../modules/auth/services/authState.service.js';

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

    // --- Claim RBAC (vedi docs/RBAC_DESIGN.md) ---
    /** Id utente (claim standard). Alias di `id` durante la migrazione. */
    sub?: string;
    /** Tipo di principal: staff interno oppure paziente del portale. */
    actor?: 'staff' | 'patient';
    /** Tenant attivo per la sessione corrente. */
    tid?: string;
    /** Struttura (premise) selezionata: determina lo scope `structure`. */
    sid?: string | null;
    /** Ruolo effettivo = override di struttura ?? ruolo del tenant. */
    role?: string | null;
    /** Permessi effettivi nel formato `resource:action:scope`. */
    perms?: string[];
    /** Id della cartella locale selezionata per un principal paziente. */
    pid?: string | null;
    /** Id del collegamento globale account ↔ cartella. */
    patientAccessId?: string | null;
    /** Distingue un token applicativo da un token breve usato solo per scegliere il contesto. */
    tokenUse?: 'application' | 'context_selection';
    authVersion?: number;

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

// Solo request-local: middleware ripetuti sui router condividono la verifica, la richiesta
// successiva rilegge sempre versione, membership e assegnazione correnti dal database.
const principalByRequest = new WeakMap<Request, Map<boolean, Promise<AuthTokenPayload>>>();

function authenticate(identityOnly: boolean) {
    return (req: Request, res: Response, next: NextFunction) => {
        const token = extractToken(req);
        if (!token) return sendErrorResponse(res, 401, 'unauthorized');
        let pending = principalByRequest.get(req)?.get(identityOnly);
        if (!pending) {
            let decoded: AuthTokenPayload;
            try { decoded = jwt.verify(token, env.jwtSecret) as AuthTokenPayload; }
            catch { return sendErrorResponse(res, 401, 'invalid or expired token'); }
            pending = resolveApplicationPrincipal(decoded, { identityOnly });
            const entries = principalByRequest.get(req) ?? new Map();
            entries.set(identityOnly, pending);
            principalByRequest.set(req, entries);
        }
        return pending.then(async principal => {
            req.user = principal;
            // Billing recovery and context selection remain reachable after expiration.
            // Patients retain their portal access; an unpaid staff account cannot call operational APIs.
            if (!identityOnly && principal.actor !== 'patient' && !isBillingRecoveryRequest(req)) {
                const tenantId = principal.tid ?? principal.tenants?.[0]?.id;
                if (tenantId) await assertBillingAccess(tenantId);
            }
            next();
        }).catch(error => {
            if (error instanceof AuthStateError) return sendErrorResponse(res, 401, error.message, { code: error.code });
            // Un guasto del DB non è una credenziale errata: passa al normale error handler.
            return next(error);
        });
    };
}

export const requireAuth = authenticate(false);
/** Permette di scegliere un altro centro anche dopo la revoca della membership selezionata. */
export const requireIdentityAuth = authenticate(true);

/** Use on routes that must be restricted to super-admin users. */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
    if (req.user?.actor === 'patient' || !req.user?.isSuperAdmin) {
        return sendErrorResponse(res, 403, 'forbidden');
    }
    return next();
}

export function getCurrentTenantId(req: Request): string {
    const tenantId = (req.user?.tid as string | undefined) ?? req.user?.tenants?.[0]?.id;
    if (!tenantId) {
        throw new Error('No tenant associated with the authenticated user');
    }
    return tenantId;
}


/** Exact routes needed to authenticate, select a center and pay an outstanding subscription. */
export function isBillingRecoveryRequest(req: Pick<Request, 'path' | 'method'>): boolean {
    const routePath = req.path ?? '';
    if (routePath === '/billing' || routePath.startsWith('/billing/')) return true;
    if (req.method === 'GET' && ['/auth/me', '/auth/me/permissions', '/auth/session/contexts',
        '/structure', '/structure/accessible'].includes(routePath)) return true;
    return req.method === 'POST' && /^\/auth\/login-premise\/[^/]+$/.test(routePath);
}
