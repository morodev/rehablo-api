import {Request} from 'express';
import {literal, Op} from 'sequelize';
import {getCurrentTenantId} from '../../../middleware/auth.js';
import {getGrantedPermissions, getSelectedStructureId, getUserId} from '../../../middleware/rbac.js';
import {Structure, StructureUser, TenantUser} from '../../auth/models/index.js';
import {Action, hasPermission, PermissionScope, Resource, resolveGrantedScope, SCOPE_RANK} from '../../auth/rbac/permissions.js';
import {getRolePermissions, resolveEffectiveRole, RoleCode} from '../../auth/rbac/roles.js';

export interface ReportScope {
    tenantId: string;
    userId: string;
    allowedStructureIds: string[];
    selectedStructureIds: string[];
    structures: Array<{id: string; name: string}>;
    scope: 'tenant' | 'assigned' | 'own';
    operatorId?: string;
}
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const fail = (statusCode: number, message: string): never => {throw Object.assign(new Error(message), {statusCode});};

export function parseReportStructureIds(query: Request['query']): string[] | null {
    const normalize = (value: unknown): string[] => {
        const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
        if ((!Array.isArray(value) && typeof value !== 'string') || values.some(id => typeof id !== 'string' || !UUID.test(id))) {
            return fail(400, 'Selezione delle sedi non valida');
        }
        return [...new Set(values as string[])].map(id => id.toLowerCase()).sort();
    };
    const single = query.structureId == null || query.structureId === '' ? null : normalize(query.structureId);
    const multiple = query.structureIds == null || query.structureIds === '' ? null : normalize(query.structureIds);
    if (single && single.length !== 1) fail(400, 'Sede non valida');
    if (single && multiple && JSON.stringify(single) !== JSON.stringify(multiple)) fail(400, 'Filtri delle sedi discordanti');
    if (multiple && !multiple.length) fail(400, 'Seleziona almeno una sede');
    return multiple ?? single;
}

/** Database-derived report boundary; never widens the selected-site CRUD access context. */
export async function resolveReportScope(req: Request, permission: {resource: Resource; action: Action}): Promise<ReportScope> {
    if (!req.user || req.user.actor === 'patient') return fail(403, 'Report riservato allo staff');
    const {resource, action} = permission;
    if (!req.user.isSuperAdmin && !hasPermission(getGrantedPermissions(req), resource, action)) return fail(403, 'Permesso di consultazione mancante');
    const tenantId = getCurrentTenantId(req), userId = getUserId(req);
    const membership = await TenantUser.findOne({where: {tenantId, userId, deactivatedAt: null}});
    if (!membership) return fail(403, 'Accesso allo studio revocato');
    const [sites, assignments] = await Promise.all([
        Structure.findAll({where: {tenantId}, attributes: ['id', 'name']}),
        StructureUser.findAll({where: {userId}, attributes: ['structureId', 'role']})
    ]);
    const bySite = new Map(assignments.map(row => [String(row.get('structureId')), row.get('role') as string | null]));
    const baseRole = membership.get('role') as string;
    // A local VIEWER override cannot grant tenant-wide reports to an administrative secretary.
    const tenantWide = baseRole === RoleCode.OWNER || (baseRole === RoleCode.VIEWER && req.user.role === RoleCode.VIEWER);
    const structures = sites.filter(site => {
        const id = String(site.get('id'));
        if (!tenantWide && !bySite.has(id)) return false;
        const effective = resolveEffectiveRole(baseRole, bySite.get(id));
        return hasPermission(getRolePermissions(effective), resource, action);
    }).map(site => ({id: String(site.get('id')), name: String(site.get('name') ?? 'Sede')}));
    const allowedStructureIds = structures.map(site => site.id).sort();
    if (!allowedStructureIds.length) return fail(403, 'Nessuna sede autorizzata per questo report');
    const selectedStructureIds = parseReportStructureIds(req.query) ?? allowedStructureIds;
    if (selectedStructureIds.some(id => !allowedStructureIds.includes(id))) return fail(403, 'Una sede selezionata non è autorizzata per questo report');
    return {tenantId, userId, allowedStructureIds, selectedStructureIds, structures, scope: tenantWide ? 'tenant' : 'assigned'};
}

export async function resolvePersonalReportScope(req: Request): Promise<ReportScope> {
    if (!req.user || req.user.actor === 'patient' || (!req.user.isSuperAdmin && !hasPermission(getGrantedPermissions(req), 'dashboard', 'read'))) return fail(403, 'Riepilogo non disponibile');
    const tenantId = getCurrentTenantId(req), userId = getUserId(req), structureId = getSelectedStructureId(req);
    if (!structureId) return fail(403, 'Seleziona una sede');
    const [membership, assignment, site] = await Promise.all([
        TenantUser.findOne({where: {tenantId, userId, deactivatedAt: null}}),
        StructureUser.findOne({where: {userId, structureId}}),
        Structure.findOne({where: {id: structureId, tenantId}, attributes: ['id', 'name']})
    ]);
    if (!membership || !assignment || !site) return fail(403, 'Sede non disponibile');
    const selected = parseReportStructureIds(req.query);
    if (selected && (selected.length !== 1 || selected[0] !== structureId)) return fail(403, 'Il riepilogo personale è limitato alla sede corrente');
    if (req.query.operatorId && req.query.operatorId !== userId) return fail(403, 'Il riepilogo personale è limitato al tuo calendario');
    return {tenantId, userId, allowedStructureIds: [structureId], selectedStructureIds: [structureId], structures: [{id: structureId, name: String(site.get('name') ?? 'Sede')}], scope: 'own', operatorId: userId};
}

export function reportStructureWhere(scope: ReportScope, field = 'structureId'): Record<string | symbol, unknown> {
    return scope.selectedStructureIds.length ? {[field]: {[Op.in]: scope.selectedStructureIds}} : {[Op.and]: literal('1=0')};
}

export async function getReportAccess(req: Request) {
    const scope = await resolveReportScope(req, {resource: 'analytics', action: 'read'});
    const canExport = !!req.user?.isSuperAdmin || hasPermission(getGrantedPermissions(req), 'analytics', 'export');
    // Context switching remains assignment-based even for a tenant-wide read-only viewer.
    const assignments = await StructureUser.findAll({where: {userId: scope.userId}, attributes: ['structureId']});
    const operationalStructureIds = [...new Set(assignments.map(row => String(row.get('structureId'))))]
        .filter(id => scope.allowedStructureIds.includes(id)).sort();
    return {...scope, operationalStructureIds, capabilities: {canRead: true, canExport}};
}

/** Optional report evidence requires its own permission in every selected site. */
export async function resolveOptionalReportScope(
    req: Request, reportScope: ReportScope, resource: 'protocol' | 'quote'
): Promise<PermissionScope | null> {
    if (!req.user || req.user.actor === 'patient' || !reportScope.selectedStructureIds.length
        || getCurrentTenantId(req) !== reportScope.tenantId || getUserId(req) !== reportScope.userId) return null;
    let minimum: PermissionScope | null = req.user.isSuperAdmin ? 'tenant'
        : resolveGrantedScope(getGrantedPermissions(req), resource, 'read');
    if (!minimum) return null;
    const [membership, assignments] = await Promise.all([
        TenantUser.findOne({where: {tenantId: reportScope.tenantId, userId: reportScope.userId, deactivatedAt: null}}),
        StructureUser.findAll({where: {userId: reportScope.userId}, attributes: ['structureId', 'role']})
    ]);
    if (!membership) return null;
    const baseRole = membership.get('role') as string;
    const tenantWide = baseRole === RoleCode.OWNER || (baseRole === RoleCode.VIEWER && req.user.role === RoleCode.VIEWER);
    const bySite = new Map(assignments.map(row => [String(row.get('structureId')), row.get('role') as string | null]));
    for (const structureId of reportScope.selectedStructureIds) {
        if (!reportScope.allowedStructureIds.includes(structureId) || (!tenantWide && !bySite.has(structureId))) return null;
        const effective = resolveEffectiveRole(baseRole, bySite.get(structureId));
        const granted = resolveGrantedScope(getRolePermissions(effective), resource, 'read');
        if (!granted) return null;
        if (SCOPE_RANK[granted] < SCOPE_RANK[minimum]) minimum = granted;
    }
    return minimum;
}
