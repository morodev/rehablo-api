import type {Request} from 'express';
import {Op, Transaction, type WhereOptions} from 'sequelize';
import {getCurrentTenantId} from '../../../middleware/auth.js';
import {getSelectedStructureId, getUserId} from '../../../middleware/rbac.js';
import {getTenantSchemaName} from '../../../utils/tenantSchema.js';
import {hasPermission, resolveGrantedScope} from '../../auth/rbac/permissions.js';
import {getRolePermissions, resolveEffectiveRole, RoleCode} from '../../auth/rbac/roles.js';
import User from '../../auth/models/user.model.js';
import TenantUser from '../../auth/models/tenantUser.model.js';
import StructureUser from '../../auth/models/structureUser.model.js';
import Structure from '../../auth/models/structure.model.js';
import Patient from '../../patients/models/patient.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import {agendaDateBoundary} from '../../agenda/services/agendaSearch.service.js';
import {textSearchWhere} from '../../../utils/search.js';
import {
    ACTIVITY_TIMEZONE, ActivityAgendaLinkDto, ActivityAgendaLookupQuery, ActivityCapabilities,
    ActivityContext, ActivityLinksDto, ActivityLookupQuery, ActivityPatientLinkDto, ActivityUserSummary
} from '../activities.types.js';
import {ActivityError} from '../utils/activityErrors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATIONAL_ROLES = new Set<RoleCode>([
    RoleCode.OWNER, RoleCode.SECRETARY, RoleCode.ADMIN_SECRETARY, RoleCode.THERAPIST,
    RoleCode.PHYSIATRIST, RoleCode.ORTHOPEDIST, RoleCode.EXTERNAL_COLLABORATOR
]);

/** Recheck inside mutation transactions. A signed but stale JWT is not current membership. */
export async function resolveActivityContext(req: Request, transaction?: Transaction): Promise<ActivityContext> {
    if (!req.user) throw new ActivityError('ACTIVITY_CONTEXT_REQUIRED', 401, 'Accedi prima di aprire le attività.');
    if (req.user.actor === 'patient') throw new ActivityError('ACTIVITY_FORBIDDEN', 403, 'Le attività sono riservate al team.');
    const userClaim = getUserId(req);
    const structureClaim = getSelectedStructureId(req);
    let tenantId: string;
    try { tenantId = getCurrentTenantId(req); }
    catch { throw new ActivityError('ACTIVITY_CONTEXT_REQUIRED', 403, 'Seleziona uno studio e una sede prima di aprire le attività.'); }
    if (typeof userClaim !== 'string' || typeof structureClaim !== 'string' || typeof tenantId !== 'string'
        || !UUID.test(userClaim) || !UUID.test(tenantId) || !UUID.test(structureClaim)) {
        throw new ActivityError('ACTIVITY_CONTEXT_REQUIRED', 403, 'Seleziona una sede prima di aprire le attività.');
    }
    const userId = userClaim.toLowerCase();
    const structureId = structureClaim.toLowerCase();
    tenantId = tenantId.toLowerCase();
    const schema = getTenantSchemaName(tenantId);
    if (req.tenantSchema && req.tenantSchema !== schema) {
        throw new ActivityError('ACTIVITY_FORBIDDEN', 403, 'Il contesto della sede non è più valido. Seleziona nuovamente la sede.');
    }
    const options = {transaction};
    // Membership and effective role are read in the same transaction as the caller.
    const user = await User.findOne({where: {id: userId, deactivatedAt: null}, attributes: ['id'], ...options});
    const membership = await TenantUser.findOne({where: {tenantId, userId, deactivatedAt: null}, attributes: ['role'], ...options});
    const structure = await Structure.findOne({where: {id: structureId, tenantId}, attributes: ['id'], ...options});
    const structureMembership = await StructureUser.findOne({where: {structureId, userId}, attributes: ['role'], ...options});
    if (!user || !membership || !structure || !structureMembership) {
        throw new ActivityError('ACTIVITY_FORBIDDEN', 403, 'Non hai più accesso alle attività di questa sede.');
    }
    // User.isActive means verified email; suspension lives on the two deactivatedAt fields.
    const role = resolveEffectiveRole(membership.role, structureMembership.role);
    const permissions = getRolePermissions(role);
    if (!role || role === RoleCode.PATIENT || !hasPermission(permissions, 'activity', 'read', 'structure')) {
        throw new ActivityError('ACTIVITY_FORBIDDEN', 403, 'Non hai il permesso di consultare le attività di questa sede.');
    }
    return {tenantId, structureId, userId, schema, role, permissions, timezone: ACTIVITY_TIMEZONE};
}

export function isEligibleActivityRole(role: RoleCode | null | undefined): boolean {
    return !!role && OPERATIONAL_ROLES.has(role)
        && hasPermission(getRolePermissions(role), 'activity', 'read', 'structure');
}

export async function assignableActivityUsers(context: ActivityContext, transaction?: Transaction): Promise<ActivityUserSummary[]> {
    const structure = await Structure.findOne({where: {id: context.structureId, tenantId: context.tenantId}, transaction});
    if (!structure) throw new ActivityError('ACTIVITY_FORBIDDEN', 403, 'La sede selezionata non è più disponibile.');
    const [structureRows, tenantRows] = await Promise.all([
        StructureUser.findAll({where: {structureId: context.structureId}, raw: true, transaction}),
        TenantUser.findAll({where: {tenantId: context.tenantId, deactivatedAt: null}, raw: true, transaction})
    ]);
    const memberships = new Map((tenantRows as Array<{userId: string; role: RoleCode}>).map(row => [row.userId, row]));
    const roles = new Map<string, RoleCode>();
    for (const row of structureRows as Array<{userId: string; role: RoleCode | null}>) {
        const membership = memberships.get(row.userId);
        const role = membership ? resolveEffectiveRole(membership.role, row.role) : null;
        if (isEligibleActivityRole(role)) roles.set(row.userId, role!);
    }
    if (!roles.size) return [];
    const people = await User.findAll({
        where: {id: {[Op.in]: [...roles.keys()]}, deactivatedAt: null},
        attributes: ['id', 'name', 'surname'], raw: true, transaction
    });
    return (people as Array<{id: string; name: string | null; surname: string | null}>)
        .map(user => ({id: user.id, name: user.name ?? null, surname: user.surname ?? null, role: roles.get(user.id)!, eligible: true}))
        .sort((left, right) => ((left.name ?? '') + ' ' + (left.surname ?? '')).localeCompare(
            (right.name ?? '') + ' ' + (right.surname ?? ''), 'it'));
}

export async function validateActivityAssignees(
    context: ActivityContext, userIds: readonly string[], transaction?: Transaction
): Promise<ActivityUserSummary[]> {
    if (!userIds.length) return [];
    const available = new Map((await assignableActivityUsers(context, transaction)).map(user => [user.id, user]));
    if (userIds.some(id => !available.has(id))) {
        throw new ActivityError('INVALID_ASSIGNEE', 422,
            'Uno degli operatori selezionati non è più disponibile in questa sede. Aggiorna gli assegnatari.',
            {assigneeIds: 'Seleziona soltanto operatori attivi e autorizzati della sede.'});
    }
    return [...new Set(userIds)].map(id => available.get(id)!);
}

export interface ActivityAccessRecord {
    createdByUserId: string;
    status: string;
    archivedAt?: Date | string | null;
}

export function activityCapabilities(
    context: ActivityContext, activity: ActivityAccessRecord, assigneeIds: readonly string[]
): ActivityCapabilities {
    const canRead = hasPermission(context.permissions, 'activity', 'read', 'structure') && context.role !== RoleCode.PATIENT;
    const operational = isEligibleActivityRole(context.role);
    const scope = resolveGrantedScope(context.permissions, 'activity', 'update');
    const owned = activity.createdByUserId === context.userId
        || (operational && assigneeIds.includes(context.userId));
    const canUpdate = canRead && operational && !!scope && (scope !== 'own' || owned);
    const archived = !!activity.archivedAt;
    return {
        canEdit: canUpdate && !archived,
        canMove: canUpdate && !archived,
        canAssign: canUpdate && !archived,
        canManageChecklist: canUpdate && !archived && activity.status !== 'COMPLETED',
        canComment: canRead && operational && !archived && hasPermission(context.permissions, 'activity', 'create'),
        canArchive: canUpdate && !archived,
        canRestore: canUpdate && archived
    };
}

export function requireActivityCapability(
    context: ActivityContext, activity: ActivityAccessRecord, assigneeIds: readonly string[],
    capability: keyof ActivityCapabilities
): void {
    if (!activityCapabilities(context, activity, assigneeIds)[capability]) {
        throw new ActivityError('ACTIVITY_FORBIDDEN', 403, 'Non hai più il permesso per eseguire questa operazione.');
    }
}

export function canCreateActivity(context: ActivityContext): boolean {
    return isEligibleActivityRole(context.role) && hasPermission(context.permissions, 'activity', 'create');
}

/** Validate linked resources independently of the activity permission. No previews are copied. */
export async function requireActivityLinks(
    context: ActivityContext, links: {patientId?: string | null; agendaEventId?: string | null},
    transaction?: Transaction
): Promise<void> {
    if (links.patientId) {
        const scope = resolveGrantedScope(context.permissions, 'patient', 'read');
        const patient = scope ? await Patient.schema(context.schema).findOne({
            where: {id: links.patientId, tenantId: context.tenantId, structureId: context.structureId, archivedAt: null,
                ...(scope === 'own' ? {userId: context.userId} : {})},
            attributes: ['id'], transaction
        }) : null;
        if (!patient) throw new ActivityError('ACTIVITY_NOT_FOUND', 404, 'Il paziente non è disponibile nella sede selezionata.');
    }
    if (links.agendaEventId) {
        const scope = resolveGrantedScope(context.permissions, 'agenda', 'read');
        const event = scope ? await AgendaEvent.schema(context.schema).findOne({
            where: {id: links.agendaEventId, structureId: context.structureId,
                ...(scope === 'own' ? {calendarId: context.userId} : {})},
            attributes: ['id', 'patientId', 'patient'], transaction
        }) : null;
        if (!event) throw new ActivityError('ACTIVITY_NOT_FOUND', 404, "L'appuntamento non è disponibile nella sede selezionata.");
        const eventPatientId = event.patientId ?? event.patient?.id ?? null;
        if (links.patientId && eventPatientId !== links.patientId) {
            throw new ActivityError('ACTIVITY_VALIDATION_FAILED', 422, "L'appuntamento non appartiene al paziente selezionato.",
                {agendaEventId: "Scegli un appuntamento del paziente selezionato."});
        }
    }
}

/** Non-authorized or deleted links become null in responses, without blocking the activity. */
export async function visibleActivityLinks(
    context: ActivityContext, links: {patientId?: string | null; agendaEventId?: string | null},
    transaction?: Transaction
): Promise<{patientId: string | null; agendaEventId: string | null}> {
    const visible: {patientId: string | null; agendaEventId: string | null} = {patientId: null, agendaEventId: null};
    for (const field of ['patientId', 'agendaEventId'] as const) {
        if (!links[field]) continue;
        try {
            await requireActivityLinks(context, {[field]: links[field]}, transaction);
            visible[field] = links[field]!;
        } catch (error) {
            if (!(error instanceof ActivityError) || error.statusCode !== 404) throw error;
        }
    }
    return visible;
}

/** Resolve fresh labels only for independently readable resources in this board's structure. */
export async function visibleActivityLinkMetadata(
    context: ActivityContext, links: {patientId?: string | null; agendaEventId?: string | null},
    transaction?: Transaction
): Promise<ActivityLinksDto> {
    const patientScope = resolveGrantedScope(context.permissions, 'patient', 'read');
    const agendaScope = resolveGrantedScope(context.permissions, 'agenda', 'read');
    const [patient, event] = await Promise.all([
        links.patientId && patientScope ? Patient.schema(context.schema).findOne({
            where: {id: links.patientId, tenantId: context.tenantId, structureId: context.structureId, archivedAt: null,
                ...(patientScope === 'own' ? {userId: context.userId} : {})},
            attributes: ['id', 'name', 'surname'], transaction
        }) : Promise.resolve(null),
        links.agendaEventId && agendaScope ? AgendaEvent.schema(context.schema).findOne({
            where: {id: links.agendaEventId, structureId: context.structureId,
                ...(agendaScope === 'own' ? {calendarId: context.userId} : {})},
            attributes: ['id', 'title', 'start', 'allDay', 'recurrence', 'recurringEventId'], transaction
        }) : Promise.resolve(null),
    ]);
    return {
        patient: patient ? {id: patient.id,
            displayName: [patient.name?.trim(), patient.surname?.trim()].filter(Boolean).join(' ')} : null,
        agendaEvent: event ? activityAgendaLink(event) : null,
    };
}

function activityAgendaLink(event: AgendaEvent): ActivityAgendaLinkDto {
    return {id: event.id, title: event.title ?? null, start: event.start ?? null,
        allDay: Boolean(event.allDay), isRecurring: Boolean(event.recurrence?.trim() || event.recurringEventId)};
}

/** Patient names are read independently of activity rights, without mutable anagrafica caches. */
export async function searchActivityPatientLinks(
    context: ActivityContext, input: ActivityLookupQuery, transaction?: Transaction
): Promise<{items: ActivityPatientLinkDto[]; total: number; nextOffset: number | null}> {
    const scope = resolveGrantedScope(context.permissions, 'patient', 'read');
    if (!scope) throw new ActivityError('ACTIVITY_FORBIDDEN', 403, 'Non hai il permesso di consultare i pazienti.');
    const conditions: WhereOptions[] = [{tenantId: context.tenantId, structureId: context.structureId, archivedAt: null,
        ...(scope === 'own' ? {userId: context.userId} : {})}];
    const search = textSearchWhere(['name', 'surname'], input.query);
    if (search) conditions.push(search);
    const result = await Patient.schema(context.schema).findAndCountAll({
        where: {[Op.and]: conditions}, attributes: ['id', 'name', 'surname'],
        order: [['surname', 'ASC'], ['name', 'ASC'], ['id', 'ASC']], offset: input.offset, limit: input.limit, transaction
    });
    return {items: result.rows.map(patient => ({id: patient.id,
        displayName: [patient.name?.trim(), patient.surname?.trim()].filter(Boolean).join(' ') || 'Paziente'})),
        total: result.count, nextOffset: input.offset + input.limit < result.count ? input.offset + input.limit : null};
}

/** Persisted appointments only: no virtual recurrence IDs or clinical snapshots enter this lookup. */
export async function searchActivityAgendaLinks(
    context: ActivityContext, input: ActivityAgendaLookupQuery, transaction?: Transaction
): Promise<{items: ActivityAgendaLinkDto[]; total: number; nextOffset: number | null}> {
    const scope = resolveGrantedScope(context.permissions, 'agenda', 'read');
    if (!scope) throw new ActivityError('ACTIVITY_FORBIDDEN', 403, 'Non hai il permesso di consultare gli appuntamenti.');
    if (input.patientId) await requireActivityLinks(context, {patientId: input.patientId}, transaction);
    if (!input.patientId && input.query.length < 2) return {items: [], total: 0, nextOffset: null};

    const conditions: WhereOptions[] = [{structureId: context.structureId,
        ...(scope === 'own' ? {calendarId: context.userId} : {})}];
    if (input.patientId) conditions.push({[Op.or]: [
        {patientId: input.patientId},
        {[Op.and]: [{patientId: null}, {patient: {id: input.patientId}}]}
    ]});
    const search = textSearchWhere(['title', 'start'], input.query);
    if (search) {
        const civilDate = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input.query);
        const date = civilDate ? `${civilDate[3]}-${civilDate[2]}-${civilDate[1]}` : input.query;
        const from = agendaDateBoundary(date, false), to = agendaDateBoundary(date, true);
        conditions.push(from && to ? {[Op.or]: [search,
            {start: {[Op.between]: [from.toISOString(), to.toISOString()]}},
            // Legacy all-day agenda rows may hold a civil date instead of an instant.
            {start: date}]} : search);
    }
    const result = await AgendaEvent.schema(context.schema).findAndCountAll({
        where: {[Op.and]: conditions}, attributes: ['id', 'title', 'start', 'allDay', 'recurrence', 'recurringEventId'],
        order: [['start', 'DESC'], ['id', 'ASC']], offset: input.offset, limit: input.limit, transaction
    });
    return {items: result.rows.map(activityAgendaLink), total: result.count,
        nextOffset: input.offset + input.limit < result.count ? input.offset + input.limit : null};
}

export async function visibleActivityLinksForRecords(
    context: ActivityContext,
    activities: ReadonlyArray<{id: string; patientId?: string | null; agendaEventId?: string | null}>,
    transaction?: Transaction
): Promise<Map<string, {patientId: string | null; agendaEventId: string | null}>> {
    const patientIds = [...new Set(activities.flatMap(activity => activity.patientId ? [activity.patientId] : []))];
    const agendaIds = [...new Set(activities.flatMap(activity => activity.agendaEventId ? [activity.agendaEventId] : []))];
    const patientScope = resolveGrantedScope(context.permissions, 'patient', 'read');
    const agendaScope = resolveGrantedScope(context.permissions, 'agenda', 'read');
    const [patients, events] = await Promise.all([
        patientScope && patientIds.length ? Patient.schema(context.schema).findAll({
            where: {id: {[Op.in]: patientIds}, tenantId: context.tenantId, structureId: context.structureId,
                archivedAt: null, ...(patientScope === 'own' ? {userId: context.userId} : {})},
            attributes: ['id'], raw: true, transaction
        }) : Promise.resolve([]),
        agendaScope && agendaIds.length ? AgendaEvent.schema(context.schema).findAll({
            where: {id: {[Op.in]: agendaIds}, structureId: context.structureId,
                ...(agendaScope === 'own' ? {calendarId: context.userId} : {})},
            attributes: ['id'], raw: true, transaction
        }) : Promise.resolve([])
    ]);
    const visiblePatients = new Set((patients as Array<{id: string}>).map(patient => patient.id));
    const visibleEvents = new Set((events as Array<{id: string}>).map(event => event.id));
    return new Map(activities.map(activity => [activity.id, {
        patientId: activity.patientId && visiblePatients.has(activity.patientId) ? activity.patientId : null,
        agendaEventId: activity.agendaEventId && visibleEvents.has(activity.agendaEventId) ? activity.agendaEventId : null
    }]));
}
