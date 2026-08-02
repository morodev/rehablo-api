import { NextFunction, Request, Response } from 'express';
import { literal, Op } from 'sequelize';
import { sendErrorResponse } from '../utils/response.js';
import {
    Action,
    PermissionScope,
    Resource,
    resolveGrantedScope,
    SCOPE_RANK
} from '../modules/auth/rbac/permissions.js';

export interface AccessContext {
    resource: Resource;
    action: Action;
    /** Ampiezza dei dati che l'utente può toccare per questa richiesta. */
    scope: PermissionScope;
    /** Id dell'utente autenticato, per i filtri `own`. */
    userId: string;
    /** Struttura selezionata, per i filtri `structure`. */
    structureId: string | null;
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            access?: AccessContext;
        }
    }
}

// ---------------------------------------------------------------------------
// Estrazione dal token (compatibile con il payload attuale e con quello nuovo)
// ---------------------------------------------------------------------------

export function getUserId(req: Request): string {
    return (req.user?.sub as string) ?? (req.user?.id as string);
}

export function getSelectedStructureId(req: Request): string | null {
    const fromClaim = req.user?.sid as string | undefined;
    if (fromClaim) return fromClaim;
    const premise = req.user?.selectedPremise as { id?: string } | null | undefined;
    return premise?.id ?? null;
}

export function getGrantedPermissions(req: Request): string[] {
    const perms = req.user?.perms ?? req.user?.permissions;
    return Array.isArray(perms) ? (perms as string[]) : [];
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Autorizza la richiesta se l'utente possiede `resource:action` a un qualunque scope
 * (oppure allo scope minimo indicato). Popola `req.access` con lo scope risolto, che i
 * controller usano per filtrare i dati.
 *
 * Da usare SEMPRE dopo `requireAuth`. Una rotta senza `requirePermission` è un bug.
 */
export function requirePermission(
    resource: Resource,
    action: Action,
    minimumScope?: PermissionScope
) {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!req.user) {
            return sendErrorResponse(res, 401, 'unauthorized');
        }

        // Il super admin di piattaforma bypassa il controllo.
        if (req.user.isSuperAdmin) {
            req.access = {
                resource,
                action,
                scope: 'tenant',
                userId: getUserId(req),
                structureId: getSelectedStructureId(req)
            };
            return next();
        }

        const scope = resolveGrantedScope(getGrantedPermissions(req), resource, action);

        if (scope === null || (minimumScope && SCOPE_RANK[scope] < SCOPE_RANK[minimumScope])) {
            return sendErrorResponse(res, 403, `forbidden: missing ${resource}:${action}`);
        }

        req.access = {
            resource,
            action,
            scope,
            userId: getUserId(req),
            structureId: getSelectedStructureId(req)
        };

        return next();
    };
}

/** Autorizza se l'utente possiede ALMENO UNO dei permessi indicati. */
export function requireAnyPermission(...required: Array<[Resource, Action]>) {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!req.user) {
            return sendErrorResponse(res, 401, 'unauthorized');
        }
        if (req.user.isSuperAdmin) return next();

        const granted = getGrantedPermissions(req);

        for (const [resource, action] of required) {
            const scope = resolveGrantedScope(granted, resource, action);
            if (scope !== null) {
                req.access = {
                    resource,
                    action,
                    scope,
                    userId: getUserId(req),
                    structureId: getSelectedStructureId(req)
                };
                return next();
            }
        }

        return sendErrorResponse(res, 403, 'forbidden');
    };
}

// ---------------------------------------------------------------------------
// Filtri row-level
// ---------------------------------------------------------------------------

export interface ScopeFields {
    /** Colonna che identifica l'owner del record (es. `userId`). */
    ownerField?: string;
    /** Colonna che identifica la struttura del record (es. `structureId`). */
    structureField?: string;
    /**
     * Se `true`, con scope `structure` restano visibili anche i record con struttura NULL.
     *
     * Serve sui modelli dove `structureId` è nullable e non è ancora stato fatto il backfill:
     * senza questa opzione i record storici sparirebbero dalla UI. Da disattivare
     * una volta che tutti i record hanno una struttura assegnata.
     */
    includeUnassigned?: boolean;
}

/**
 * Costruisce il frammento di `where` Sequelize corrispondente allo scope risolto.
 *
 * ```ts
 * const where = { ...filtriApplicativi, ...scopeWhere(req, { ownerField: 'referentUserId' }) };
 * ```
 *
 * - `tenant`    → `{}` (lo schema Postgres isola già il tenant)
 * - `structure` → `{ structureId: <premise selezionato> }`
 * - `own`       → `{ ownerField: <userId> }`
 */
export function scopeWhere(req: Request, fields: ScopeFields): Record<string, unknown> {
    const access = req.access;
    if (!access) {
        throw new Error('scopeWhere() richiede requirePermission() sulla rotta');
    }

    if (access.scope === 'tenant') {
        return {};
    }

    if (access.scope === 'structure') {
        if (!fields.structureField) return {};
        if (!access.structureId) {
            // Nessun premise selezionato: nessun dato visibile a scope struttura.
            return { [fields.structureField]: null };
        }
        if (fields.includeUnassigned) {
            return {
                [Op.or]: [
                    { [fields.structureField]: access.structureId },
                    { [fields.structureField]: null }
                ]
            } as Record<string, unknown>;
        }
        return { [fields.structureField]: access.structureId };
    }

    if (!fields.ownerField) {
        throw new Error(`scopeWhere(): ownerField mancante per ${access.resource}`);
    }
    return { [fields.ownerField]: access.userId };
}

/**
 * Verifica che il singolo record ricadesse nello scope concesso.
 * Da usare dopo una `findByPk` per non esporre record altrui.
 */
export function canAccessRecord(
    req: Request,
    record: Record<string, any> | null | undefined,
    fields: ScopeFields
): boolean {
    if (!record) return false;

    const access = req.access;
    if (!access) {
        throw new Error('canAccessRecord() richiede requirePermission() sulla rotta');
    }

    if (access.scope === 'tenant') return true;

    const value = (key?: string) =>
        key ? (typeof record.get === 'function' ? record.get(key) : record[key]) : undefined;

    if (access.scope === 'structure') {
        if (!fields.structureField) return true;
        const recordStructure = value(fields.structureField);
        if (fields.includeUnassigned && (recordStructure === null || recordStructure === undefined)) {
            return true;
        }
        return !!access.structureId && recordStructure === access.structureId;
    }

    return value(fields.ownerField) === access.userId;
}

/** Variante che risponde 403 e interrompe il flusso. Ritorna `true` se l'accesso è consentito. */
export function assertCanAccessRecord(
    req: Request,
    res: Response,
    record: Record<string, any> | null | undefined,
    fields: ScopeFields
): boolean {
    if (canAccessRecord(req, record, fields)) return true;
    sendErrorResponse(res, 403, 'forbidden');
    return false;
}

// ---------------------------------------------------------------------------
// Scope derivato dal paziente
// ---------------------------------------------------------------------------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEMA_REGEX = /^[a-z0-9_]+$/i;

/**
 * Filtro per le risorse che non hanno un proprietario proprio ma appartengono a un paziente
 * (fatture, osservazioni, protocolli...): l'ampiezza si eredita da quella sui pazienti.
 *
 * ```ts
 * const where = { ...filtri, ...patientScopeWhere(req, schema, 'patientID') };
 * ```
 *
 * Genera una sotto-query invece di caricare in memoria gli id dei pazienti, così resta
 * efficiente anche con anagrafiche grandi. I valori interpolati sono UUID validati e il
 * nome dello schema è ristretto a `[a-z0-9_]`: nessun input utente finisce nell'SQL.
 */
export function patientScopeWhere(
    req: Request,
    schema: string,
    patientField = 'patientId'
): Record<string, unknown> {
    const access = req.access;
    if (!access) {
        throw new Error('patientScopeWhere() richiede requirePermission() sulla rotta');
    }

    if (access.scope === 'tenant') {
        return {};
    }

    if (!SCHEMA_REGEX.test(schema)) {
        throw new Error(`patientScopeWhere(): nome schema non valido "${schema}"`);
    }

    let condition: string;

    if (access.scope === 'own') {
        if (!UUID_REGEX.test(access.userId)) {
            throw new Error('patientScopeWhere(): userId non valido');
        }
        condition = `"userId" = '${access.userId}'`;
    } else {
        if (!access.structureId) {
            // Nessuna struttura selezionata: nessun paziente visibile.
            return { [patientField]: null };
        }
        if (!UUID_REGEX.test(access.structureId)) {
            throw new Error('patientScopeWhere(): structureId non valido');
        }
        // `structureId IS NULL` copre i pazienti non ancora assegnati a una sede
        // (coerente con ScopeFields.includeUnassigned usato su Patient).
        condition = `("structureId" = '${access.structureId}' OR "structureId" IS NULL)`;
    }

    return {
        [patientField]: {
            [Op.in]: literal(`(SELECT "id" FROM "${schema}"."patients" WHERE ${condition})`)
        }
    };
}

