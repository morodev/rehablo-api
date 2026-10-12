import { Op } from 'sequelize';
import type { AuthTokenPayload } from '../../../middleware/auth.js';
import User from '../models/user.model.js';
import TenantUser from '../models/tenantUser.model.js';
import StructureUser from '../models/structureUser.model.js';
import Structure from '../models/structure.model.js';
import PatientPortalAccess from '../models/patientPortalAccess.model.js';
import { getRolePermissions, resolveEffectiveRole, RoleCode } from '../rbac/roles.js';

export class AuthStateError extends Error {
    readonly statusCode = 401;
    readonly code = 'AUTH_SESSION_INVALID';
    constructor(message = 'Sessione non valida: effettua nuovamente il login') { super(message); }
}

/** I JWT precedenti alla migrazione appartengono soltanto alla versione iniziale. */
export function getAuthVersion(value: unknown): number {
    if (value === undefined) return 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new AuthStateError();
    return value;
}

export function assertCurrentIdentity(user: User | null, version: unknown): asserts user is User {
    if (!user || !user.get('isActive') || user.get('deactivatedAt') ||
        getAuthVersion(user.get('authVersion')) !== getAuthVersion(version)) throw new AuthStateError();
}

/** Il flag del titolare vale solo in una sua membership OWNER attiva, mai in altri centri. */
export function isTenantAdministrator(user: User, membership: TenantUser | null, actor = 'staff'): boolean {
    return actor === 'staff' && user.get('isSuperAdmin') === true && !!membership &&
        !membership.get('deactivatedAt') && membership.get('role') === RoleCode.OWNER;
}

export async function resolveApplicationPrincipal(
    claims: AuthTokenPayload,
    options: { identityOnly?: boolean; user?: User } = {}
): Promise<AuthTokenPayload> {
    if (!claims || typeof claims !== 'object' ||
        (claims.tokenUse !== undefined && claims.tokenUse !== 'application')) throw new AuthStateError();
    const userId = claims.sub ?? claims.id;
    if (typeof userId !== 'string' || !userId || (claims.id && claims.id !== userId)) throw new AuthStateError();
    if (claims.actor !== undefined && claims.actor !== 'staff' && claims.actor !== 'patient') throw new AuthStateError();
    const user = options.user ?? await User.findByPk(userId, {
        attributes: ['id', 'email', 'isActive', 'deactivatedAt', 'isSuperAdmin', 'authVersion']
    });
    assertCurrentIdentity(user, claims.authVersion);
    const principal: AuthTokenPayload = {
        ...claims,
        id: userId, sub: userId, email: user.get('email'), isActive: true,
        authVersion: getAuthVersion(claims.authVersion), actor: claims.actor ?? 'staff',
        isSuperAdmin: false, role: null, perms: [], tenants: [],
        tokenUse: 'application'
    };
    const tenantId = claims.tid ?? claims.tenants?.[0]?.id;
    if (options.identityOnly || !tenantId) {
        delete principal.tid;
        principal.sid = null;
        principal.selectedPremise = null;
        principal.structures = [];
        delete principal.pid;
        delete principal.patientAccessId;
        return principal;
    }
    if (typeof tenantId !== 'string') throw new AuthStateError();
    principal.tid = tenantId;
    principal.tenants = [{ ...claims.tenants?.find(tenant => tenant.id === tenantId), id: tenantId }];

    if (principal.actor === 'patient') {
        const access = typeof claims.patientAccessId === 'string'
            ? await PatientPortalAccess.findOne({ where: {
                id: claims.patientAccessId, userId, tenantId,
                status: { [Op.in]: ['ACTIVE', 'HISTORICAL'] }
            } }) : null;
        if (!access) throw new AuthStateError('Accesso al centro revocato');
        principal.pid = access.get('patientId') as string;
        principal.patientAccessId = access.get('id') as string;
        principal.contextStatus = access.get('status');
        principal.isTenant = false;
        principal.sid = null;
        principal.selectedPremise = null;
        principal.structures = [];
        principal.role = RoleCode.PATIENT;
        principal.perms = getRolePermissions(RoleCode.PATIENT);
        return principal;
    }

    const membership = await TenantUser.findOne({ where: { userId, tenantId, deactivatedAt: null } });
    if (!membership || membership.get('deactivatedAt')) throw new AuthStateError('Accesso al centro disattivato');
    const structureId = claims.sid ?? claims.selectedPremise?.id ?? null;
    let structureRole: string | null = null;
    if (structureId) {
        if (typeof structureId !== 'string') throw new AuthStateError();
        const [assignment, structure] = await Promise.all([
            StructureUser.findOne({ where: { userId, structureId } }),
            Structure.findOne({ where: { id: structureId, tenantId }, attributes: ['id'] })
        ]);
        if (!assignment || !structure) throw new AuthStateError('Sede non disponibile: seleziona nuovamente il contesto');
        structureRole = assignment.get('role') as string | null;
    }
    principal.sid = structureId;
    principal.selectedPremise = structureId ? { ...claims.selectedPremise, id: structureId } : null;
    principal.role = resolveEffectiveRole(membership.get('role') as string, structureRole);
    principal.perms = getRolePermissions(principal.role);
    principal.isSuperAdmin = isTenantAdministrator(user, membership);
    delete principal.pid;
    delete principal.patientAccessId;
    return principal;
}
