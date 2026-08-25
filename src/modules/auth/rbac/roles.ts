/**
 * Ruoli di sistema Rehablo.
 *
 * I ruoli sono FISSI e definiti nel codice (nessuna tabella `roles`): il tenant non può
 * crearne di nuovi. Questo mantiene il modello semplice e i permessi versionati con l'app.
 *
 * Il ruolo NON sta sullo User: vive su `tenant_users.role` (ruolo base nel tenant) con
 * override opzionale su `structure_users.role` (ruolo nella singola struttura).
 */

import { crud, Permission, perm, perms } from './permissions.js';

export enum RoleCode {
    /** Titolare dello studio: pieno controllo del tenant, incluso billing. */
    OWNER = 'OWNER',
    /** Front-office: agenda, anagrafiche e fatturazione. NESSUN accesso ai dati clinici. */
    SECRETARY = 'SECRETARY',
    /** Fisioterapista: cartella clinica e agenda dei propri pazienti. */
    THERAPIST = 'THERAPIST',
    /** Medico fisiatra. */
    PHYSIATRIST = 'PHYSIATRIST',
    /** Medico ortopedico. */
    ORTHOPEDIST = 'ORTHOPEDIST',
    /** Collaboratore esterno / sostituto: accesso ridotto e senza cancellazioni. */
    EXTERNAL_COLLABORATOR = 'EXTERNAL_COLLABORATOR',
    /** Sola lettura (revisore, commercialista, auditor). */
    VIEWER = 'VIEWER',
    /** Portale paziente (roadmap): accesso ai soli dati propri. */
    PATIENT = 'PATIENT'
}

/** Tipo di principal: distingue lo staff dal paziente che accede al portale. */
export type ActorType = 'staff' | 'patient';

export interface RoleDefinition {
    code: RoleCode;
    /** Chiave i18n per la label mostrata in UI. */
    labelKey: string;
    actor: ActorType;
    /** Se true il ruolo è assegnabile dalla UI di gestione utenti del tenant. */
    assignable: boolean;
    permissions: Permission[];
}

// ---------------------------------------------------------------------------
// Preset condivisi
// ---------------------------------------------------------------------------

/** Risorse cliniche: tutto ciò che costituisce cartella clinica del paziente. */
const CLINICAL_RESOURCES = ['evaluation', 'protocol', 'note', 'bodymap', 'measurement'] as const;

const clinicalCrud = (scope: 'own' | 'structure' | 'tenant'): Permission[] =>
    CLINICAL_RESOURCES.flatMap((resource) => crud(resource, scope));

const clinicalRead = (scope: 'own' | 'structure' | 'tenant'): Permission[] =>
    CLINICAL_RESOURCES.map((resource) => perm(resource, 'read', scope));

/** Preset condiviso dai medici specialisti (fisiatra / ortopedico). */
const physicianPermissions = (): Permission[] => [
    // vede tutti i pazienti della struttura, ma non li cancella
    ...perms('patient', ['read'], 'structure'),
    ...perms('patient', ['create', 'update'], 'structure'),
    // legge tutta la clinica della struttura, scrive solo la propria
    ...clinicalRead('structure'),
    ...CLINICAL_RESOURCES.flatMap((resource) => perms(resource, ['create', 'update'], 'own')),
    perm('reminder', 'read', 'structure'),
    ...crud('reminder', 'own'),
    perm('agenda', 'read', 'structure'),
    ...crud('agenda', 'own'),
    perm('product', 'read', 'tenant'),
    perm('user', 'read', 'structure'),
    perm('structure', 'read', 'structure'),
    perm('dashboard', 'read', 'own'),
    perm('evaluation', 'export', 'structure')
];

// ---------------------------------------------------------------------------
// Definizioni
// ---------------------------------------------------------------------------

export const ROLE_DEFINITIONS: Record<RoleCode, RoleDefinition> = {
    [RoleCode.OWNER]: {
        code: RoleCode.OWNER,
        labelKey: 'role-owner',
        actor: 'staff',
        assignable: true,
        permissions: [
            perm('patient', 'manage', 'tenant'),
            ...CLINICAL_RESOURCES.map((resource) => perm(resource, 'manage', 'tenant')),
            perm('reminder', 'manage', 'tenant'),
            perm('agenda', 'manage', 'tenant'),
            perm('invoice', 'manage', 'tenant'),
            perm('product', 'manage', 'tenant'),
            perm('dashboard', 'manage', 'tenant'),
            perm('user', 'manage', 'tenant'),
            perm('structure', 'manage', 'tenant'),
            perm('tenant', 'manage', 'tenant'),
            perm('clinical_content', 'manage', 'tenant')
        ]
    },

    [RoleCode.SECRETARY]: {
        code: RoleCode.SECRETARY,
        labelKey: 'role-secretary',
        actor: 'staff',
        assignable: true,
        permissions: [
            // anagrafica sì, cancellazione no
            ...perms('patient', ['read', 'create', 'update'], 'structure'),
            // NESSUN permesso su evaluation / protocol / bodymap / measurement
            ...crud('reminder', 'structure'),
            ...crud('agenda', 'structure'),
            ...perms('invoice', ['read', 'create', 'update', 'export'], 'structure'),
            // Il front-office gestisce il listino che alimenta fatture e tipi appuntamento.
            perm('product', 'manage', 'tenant'),
            // Le impostazioni amministrative sono gestibili dal titolare e dalla
            // segreteria. Gli altri ruoli conservano soltanto le letture operative.
            perm('user', 'manage', 'tenant'),
            perm('structure', 'manage', 'tenant'),
            ...perms('tenant', ['read', 'update'], 'tenant'),
            perm('clinical_content', 'manage', 'tenant'),
            perm('dashboard', 'read', 'structure')
        ]
    },

    [RoleCode.THERAPIST]: {
        code: RoleCode.THERAPIST,
        labelKey: 'role-therapist',
        actor: 'staff',
        assignable: true,
        permissions: [
            perm('patient', 'read', 'own'),
            perm('patient', 'update', 'own'),
            perm('patient', 'create', 'structure'),
            ...clinicalCrud('own'),
            ...crud('reminder', 'own'),
            // vede l'agenda della struttura (disponibilità) ma gestisce solo la propria
            perm('agenda', 'read', 'structure'),
            ...crud('agenda', 'own'),
            perm('product', 'read', 'tenant'),
            perm('user', 'read', 'structure'),
            perm('structure', 'read', 'structure'),
            perm('dashboard', 'read', 'own'),
            perm('evaluation', 'export', 'own')
        ]
    },

    [RoleCode.PHYSIATRIST]: {
        code: RoleCode.PHYSIATRIST,
        labelKey: 'role-physiatrist',
        actor: 'staff',
        assignable: true,
        permissions: physicianPermissions()
    },

    [RoleCode.ORTHOPEDIST]: {
        code: RoleCode.ORTHOPEDIST,
        labelKey: 'role-orthopedist',
        actor: 'staff',
        assignable: true,
        permissions: physicianPermissions()
    },

    [RoleCode.EXTERNAL_COLLABORATOR]: {
        code: RoleCode.EXTERNAL_COLLABORATOR,
        labelKey: 'role-external-collaborator',
        actor: 'staff',
        assignable: true,
        permissions: [
            perm('patient', 'read', 'own'),
            ...CLINICAL_RESOURCES.flatMap((resource) =>
                perms(resource, ['read', 'create', 'update'], 'own')
            ),
            ...perms('reminder', ['read', 'create', 'update'], 'own'),
            ...perms('agenda', ['read', 'create', 'update'], 'own'),
            perm('product', 'read', 'tenant'),
            // Serve almeno la propria dashboard: è la pagina su cui atterra dopo il login.
            perm('dashboard', 'read', 'own'),
            perm('structure', 'read', 'structure')
        ]
    },

    [RoleCode.VIEWER]: {
        code: RoleCode.VIEWER,
        labelKey: 'role-viewer',
        actor: 'staff',
        assignable: true,
        permissions: [
            perm('patient', 'read', 'tenant'),
            ...clinicalRead('tenant'),
            perm('reminder', 'read', 'tenant'),
            perm('agenda', 'read', 'tenant'),
            perm('invoice', 'read', 'tenant'),
            perm('product', 'read', 'tenant'),
            perm('user', 'read', 'tenant'),
            perm('structure', 'read', 'tenant'),
            perm('dashboard', 'read', 'tenant')
        ]
    },

    [RoleCode.PATIENT]: {
        code: RoleCode.PATIENT,
        labelKey: 'role-patient',
        actor: 'patient',
        // non assegnabile dalla UI staff: nasce dall'attivazione del portale paziente
        assignable: false,
        permissions: [
            perm('patient', 'read', 'own'),
            ...clinicalRead('own'),
            perm('agenda', 'read', 'own'),
            perm('invoice', 'read', 'own')
        ]
    }
};

/** Ruolo assegnato di default a un nuovo utente invitato nel tenant. */
export const DEFAULT_ROLE = RoleCode.THERAPIST;

/** Ruolo dell'utente che crea il tenant in fase di registrazione. */
export const TENANT_OWNER_ROLE = RoleCode.OWNER;

export function isRoleCode(value: unknown): value is RoleCode {
    return typeof value === 'string' && value in ROLE_DEFINITIONS;
}

/** Permessi effettivi di un ruolo (array deduplicato). */
export function getRolePermissions(role: RoleCode | string | null | undefined): Permission[] {
    if (!isRoleCode(role)) return [];
    return [...new Set(ROLE_DEFINITIONS[role].permissions)];
}

/** Ruoli proponibili nella UI di gestione utenti del tenant. */
export function getAssignableRoles(): RoleDefinition[] {
    return Object.values(ROLE_DEFINITIONS).filter((role) => role.assignable);
}

/**
 * Ruolo effettivo dell'utente: l'eventuale override sulla struttura selezionata
 * prevale sul ruolo base nel tenant.
 */
export function resolveEffectiveRole(
    tenantRole: string | null | undefined,
    structureRole?: string | null
): RoleCode | null {
    if (isRoleCode(structureRole)) return structureRole;
    if (isRoleCode(tenantRole)) return tenantRole;
    return null;
}

