/**
 * Catalogo centralizzato dei permessi Rehablo.
 *
 * Formato: `<resource>:<action>:<scope>` (es. `patient:read:structure`).
 *
 * - `manage` è un wildcard di action: soddisfa qualunque altra action sulla stessa resource.
 * - gli scope sono gerarchici: `tenant` implica `structure` che implica `own`.
 *
 * ATTENZIONE: questo file è la fonte di verità. Il mirror frontend si trova in
 * `rehab.io_fe/src/app/core/auth/rbac/permissions.ts` e va tenuto allineato.
 */

// ---------------------------------------------------------------------------
// Resources / Actions / Scopes
// ---------------------------------------------------------------------------

export const RESOURCES = [
    'patient',      // anagrafica pazienti
    'evaluation',   // valutazioni, scale, test
    'protocol',     // protocolli riabilitativi
    'note',         // note cliniche/operative
    'reminder',     // promemoria e attivitÃ  assegnate
    'bodymap',      // human-body: aree, sintomi, questionari
    'measurement',  // device, raw files, misurazioni strumentali
    'agenda',       // appuntamenti ed event types
    'invoice',      // fatturazione
    'product',      // listino prodotti e servizi
    'dashboard',    // dashboard e widget configurabili
    'user',         // utenti del tenant
    'structure',    // strutture / premise
    'tenant',       // dati azienda, licenza, billing
    'maintenance'   // operazioni di piattaforma
] as const;

export type Resource = (typeof RESOURCES)[number];

/**
 * Etichette leggibili delle resource, usate nei messaggi di errore.
 *
 * Serve soprattutto dove il nome tecnico della resource non coincide con l'entità
 * dell'endpoint: es. `POST /service` è governato da `product` perché prodotti e servizi
 * condividono lo stesso listino.
 */
export const RESOURCE_LABELS: Record<Resource, string> = {
    patient: 'anagrafica pazienti',
    evaluation: 'valutazioni',
    protocol: 'protocolli',
    note: 'note',
    reminder: 'promemoria',
    bodymap: 'mappa corporea',
    measurement: 'misurazioni',
    agenda: 'agenda',
    invoice: 'fatturazione',
    product: 'listino prodotti e servizi',
    dashboard: 'dashboard',
    user: 'utenti',
    structure: 'strutture',
    tenant: 'dati azienda',
    maintenance: 'manutenzione piattaforma'
};

export const ACTIONS = ['read', 'create', 'update', 'delete', 'export', 'manage'] as const;
export type Action = (typeof ACTIONS)[number];

export const SCOPES = ['own', 'structure', 'tenant'] as const;
export type PermissionScope = (typeof SCOPES)[number];

/** Ranking degli scope: uno scope più alto soddisfa le richieste di quelli più bassi. */
export const SCOPE_RANK: Record<PermissionScope, number> = {
    own: 1,
    structure: 2,
    tenant: 3
};

export type Permission = `${Resource}:${Action}:${PermissionScope}`;

// ---------------------------------------------------------------------------
// Helpers di costruzione
// ---------------------------------------------------------------------------

/** Costruisce una singola stringa permesso in modo type-safe. */
export function perm(resource: Resource, action: Action, scope: PermissionScope): Permission {
    return `${resource}:${action}:${scope}`;
}

/** Costruisce più permessi sulla stessa resource/scope. Utilizzato nei preset dei ruoli. */
export function perms(resource: Resource, actions: Action[], scope: PermissionScope): Permission[] {
    return actions.map((action) => perm(resource, action, scope));
}

/** Scorciatoia per `read + create + update + delete` su una resource. */
export function crud(resource: Resource, scope: PermissionScope): Permission[] {
    return perms(resource, ['read', 'create', 'update', 'delete'], scope);
}

export interface ParsedPermission {
    resource: Resource;
    action: Action;
    scope: PermissionScope;
}

export function parsePermission(value: string): ParsedPermission | null {
    const [resource, action, scope] = value.split(':');
    if (!resource || !action || !scope) return null;
    if (!RESOURCES.includes(resource as Resource)) return null;
    if (!ACTIONS.includes(action as Action)) return null;
    if (!SCOPES.includes(scope as PermissionScope)) return null;
    return {
        resource: resource as Resource,
        action: action as Action,
        scope: scope as PermissionScope
    };
}

// ---------------------------------------------------------------------------
// Valutazione
// ---------------------------------------------------------------------------

/**
 * Restituisce lo scope PIÙ AMPIO concesso per `resource`/`action`, oppure `null`
 * se l'utente non ha alcun permesso.
 *
 * Tiene conto del wildcard `manage`, che copre tutte le action della resource.
 */
export function resolveGrantedScope(
    granted: readonly string[] | undefined,
    resource: Resource,
    action: Action
): PermissionScope | null {
    if (!granted?.length) return null;

    let best: PermissionScope | null = null;

    for (const raw of granted) {
        const parsed = parsePermission(raw);
        if (!parsed) continue;
        if (parsed.resource !== resource) continue;
        if (parsed.action !== action && parsed.action !== 'manage') continue;

        if (best === null || SCOPE_RANK[parsed.scope] > SCOPE_RANK[best]) {
            best = parsed.scope;
        }
    }

    return best;
}

/**
 * `true` se l'utente ha il permesso almeno allo scope richiesto.
 * Senza `minimumScope` è sufficiente un permesso a qualunque scope.
 */
export function hasPermission(
    granted: readonly string[] | undefined,
    resource: Resource,
    action: Action,
    minimumScope?: PermissionScope
): boolean {
    const scope = resolveGrantedScope(granted, resource, action);
    if (scope === null) return false;
    if (!minimumScope) return true;
    return SCOPE_RANK[scope] >= SCOPE_RANK[minimumScope];
}

