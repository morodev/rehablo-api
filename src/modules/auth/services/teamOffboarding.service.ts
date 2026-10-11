import {createHash} from 'node:crypto';
import type {Request, Response} from 'express';
import {Op, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {getCurrentTenantId} from '../../../middleware/auth.js';
import {getSelectedStructureId, getUserId} from '../../../middleware/rbac.js';
import {getTenantSchemaName} from '../../../utils/tenantSchema.js';
import {acquireTenantActivityGate} from '../../../utils/tenantActivityGate.js';
import {sendErrorResponse} from '../../../utils/response.js';
import {Structure, StructureUser, TenantUser, User} from '../models/index.js';
import {getRolePermissions, isRoleCode, resolveEffectiveRole, RoleCode, ROLE_DEFINITIONS} from '../rbac/roles.js';
import {hasPermission} from '../rbac/permissions.js';
import {validateUserStructureSelection} from './userStructurePolicy.service.js';
import {defaultCalendarEnabled} from './structureCalendar.service.js';
import {Activity, ActivityAlert, ActivityAssignment, ActivityBoard, ActivityDelivery, ActivityHistory, ActivityOperation} from '../../activities/models/index.js';
import {assignableActivityUsers, isEligibleActivityRole} from '../../activities/services/activityAccess.service.js';
import {cancelActivityDeliveries, materializeActivityDeliveries} from '../../activities/services/activityDeliveryPersistence.service.js';
import type {ActivityContext} from '../../activities/activities.types.js';
import {getOperatorDeactivationImpact, reassignFutureAppointments} from '../../agenda/services/operatorReassignment.service.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import AgendaEventException from '../../agenda/models/agendaEventException.model.js';

export type TeamChange =
    | {kind: 'status'; active: boolean}
    | {kind: 'role'; role: RoleCode; structureIds?: string[]}
    | {kind: 'structureRole'; structureId: string; role: RoleCode | null}
    | {kind: 'structures'; structureIds: string[]}
    | {kind: 'profile'; role?: RoleCode; structureIds?: string[]}
    | {kind: 'remove'};
export type TeamResolution = {kind: 'replace'; userId: string} | {kind: 'defer'};
export interface TeamStructureResolution {
    structureId: string;
    appointments?: TeamResolution;
    activities?: TeamResolution;
}
export interface TeamOffboardingImpact {
    fingerprint: string;
    structures: Array<{
        structureId: string;
        structureName: string;
        appointments: Awaited<ReturnType<typeof getOperatorDeactivationImpact>>;
        activities: {
            openAssignedCount: number;
            orphanCount: number;
            alertsDisabledCount: number;
            replacementOperators: Array<{id: string; fullName: string}>;
            canReadDetails: boolean;
            items: Array<{id: string; title: string; wouldBecomeUnassigned: boolean}>;
        };
    }>;
}
export class TeamOffboardingError extends Error {
    constructor(readonly status: number, readonly code: string, message: string, readonly impact?: TeamOffboardingImpact) {
        super(message);
        this.name = 'TeamOffboardingError';
    }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function fail(message: string): never { throw new TeamOffboardingError(422, 'TEAM_VALIDATION_FAILED', message); }
function record(value: unknown): Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('La richiesta di modifica del membro non è valida.');
    return value as Record<string, any>;
}
function uuid(value: unknown): string {
    if (typeof value !== 'string' || !UUID.test(value)) fail('Seleziona un membro o una sede validi.');
    return value.toLowerCase();
}
function ids(value: unknown): string[] {
    if (!Array.isArray(value)) fail('Seleziona le sedi del membro.');
    return [...new Set(value.map(uuid))].sort();
}
function role(value: unknown): RoleCode {
    if (!isRoleCode(value) || !ROLE_DEFINITIONS[value].assignable) fail('Seleziona un ruolo valido per il team.');
    return value;
}
export function parseTeamChange(value: unknown): TeamChange {
    const input = record(value);
    const keys: Record<string, string[]> = {status: ['active'], role: ['role', 'structureIds'],
        structureRole: ['structureId', 'role'], structures: ['structureIds'], profile: ['role', 'structureIds'], remove: []};
    if (typeof input.kind !== 'string' || !Object.prototype.hasOwnProperty.call(keys, input.kind)
        || Object.keys(input).some(key => key !== 'kind' && !keys[input.kind].includes(key))) {
        fail('La modifica richiesta per il membro non è valida.');
    }
    switch (input.kind) {
        case 'status':
            if (typeof input.active !== 'boolean') fail('Indica se il membro deve essere attivo.');
            return {kind: 'status', active: input.active};
        case 'role': return {kind: 'role', role: role(input.role), ...(input.structureIds !== undefined ? {structureIds: ids(input.structureIds)} : {})};
        case 'structureRole': return {kind: 'structureRole', structureId: uuid(input.structureId), role: input.role === null ? null : role(input.role)};
        case 'structures': return {kind: 'structures', structureIds: ids(input.structureIds)};
        case 'profile': return {kind: 'profile', ...(input.role !== undefined ? {role: role(input.role)} : {}),
            ...(input.structureIds !== undefined ? {structureIds: ids(input.structureIds)} : {})};
        case 'remove': return {kind: 'remove'};
        default: fail('La modifica richiesta per il membro non è valida.');
    }
}
function stable(value: any): string {
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort()
        .map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }

async function actorContext(req: Request, transaction: Transaction) {
    const tenantId = getCurrentTenantId(req).toLowerCase();
    const userId = uuid(getUserId(req));
    const structureId = getSelectedStructureId(req);
    if (!req.user || req.user.actor === 'patient') throw new TeamOffboardingError(403, 'TEAM_FORBIDDEN', 'La gestione del team è riservata agli amministratori dello studio.');
    const [identity, membership, selected, selectedStructure] = await Promise.all([
        User.findOne({where: {id: userId, deactivatedAt: null}, transaction}),
        TenantUser.findOne({where: {tenantId, userId, deactivatedAt: null}, transaction}),
        structureId ? StructureUser.findOne({where: {structureId, userId}, transaction}) : null,
        structureId ? Structure.findOne({where: {id: structureId, tenantId}, transaction}) : null
    ]);
    const effective = membership ? resolveEffectiveRole(membership.role, selected?.role) : null;
    if (!identity || !membership || !effective || (structureId && (!selected || !selectedStructure))
        || !hasPermission(getRolePermissions(effective), 'user', 'update', 'tenant')) {
        throw new TeamOffboardingError(403, 'TEAM_FORBIDDEN', 'Non hai più il permesso di gestire i membri di questo studio.');
    }
    return {tenantId, userId, structureId, schema: getTenantSchemaName(tenantId), role: effective};
}
type TeamActor = Awaited<ReturnType<typeof actorContext>>;
interface PreparedTeamChange {
    actor: TeamActor;
    change: TeamChange;
    targetUserId: string;
    membership: TenantUser;
    identity: User;
    structures: Structure[];
    memberships: StructureUser[];
    boards: ActivityBoard[];
    affectedStructureIds: string[];
    nextRole: RoleCode;
    nextStructureIds: string[];
    impact: TeamOffboardingImpact;
    activityRows: Map<string, Activity[]>;
    assignmentRows: Map<string, ActivityAssignment[]>;
    eligibleIds: Map<string, Set<string>>;
}

async function prepare(
    actor: TeamActor, targetUserId: string, change: TeamChange, transaction: Transaction, lock: boolean, boards: ActivityBoard[]
): Promise<PreparedTeamChange> {
    const [membership, identity, structures, memberships] = await Promise.all([
        TenantUser.findOne({where: {tenantId: actor.tenantId, userId: targetUserId}, transaction}),
        User.findByPk(targetUserId, {transaction}),
        Structure.findAll({where: {tenantId: actor.tenantId}, order: [['id', 'ASC']], transaction}),
        StructureUser.findAll({where: {userId: targetUserId}, order: [['structureId', 'ASC']], transaction})
    ]);
    if (!membership || !identity) throw new TeamOffboardingError(404, 'TEAM_MEMBER_NOT_FOUND', 'Il membro non è più disponibile in questo studio.');
    const allowed = structures.map(row => row.id);
    const own = memberships.filter(row => allowed.includes(row.structureId));
    const currentIds = own.map(row => row.structureId).sort();
    const nextRole = 'role' in change && change.kind !== 'structureRole' && change.role ? change.role : membership.role;
    const nextStructureIds = change.kind === 'remove' ? [] : nextRole === RoleCode.OWNER ? allowed :
        'structureIds' in change && change.structureIds ? change.structureIds : currentIds;
    if (change.kind !== 'remove') {
        const selectionError = validateUserStructureSelection(nextRole, nextStructureIds, allowed);
        if (selectionError) fail(selectionError);
    }
    if (change.kind === 'structureRole') {
        if (!allowed.includes(change.structureId) || !currentIds.includes(change.structureId)) {
            throw new TeamOffboardingError(404, 'TEAM_MEMBER_NOT_FOUND', 'Il membro non è assegnato a questa sede.');
        }
        if (change.role === RoleCode.OWNER || (membership.role === RoleCode.OWNER && change.role !== null)) fail('Il ruolo proprietario non ammette override nella sede.');
    }
    const changesRole = nextRole !== membership.role || change.kind === 'structureRole';
    if ((changesRole || change.kind === 'remove' || (change.kind === 'status' && !change.active)) && targetUserId === actor.userId) {
        throw new TeamOffboardingError(403, 'TEAM_FORBIDDEN', 'Non puoi rimuovere o modificare il ruolo del tuo account.');
    }
    if (identity.get('isTenant') && nextRole !== RoleCode.OWNER) fail('Il ruolo del titolare dello studio non può essere modificato.');
    if (change.kind === 'remove' && membership.role === RoleCode.OWNER) {
        throw new TeamOffboardingError(409, 'TEAM_OWNER_REQUIRED', 'Il titolare dello studio non può essere eliminato. Puoi disattivarlo.');
    }
    const nextActive = change.kind !== 'remove' && (change.kind === 'status' ? change.active : membership.deactivatedAt === null);
    if (membership.role === RoleCode.OWNER && (nextRole !== RoleCode.OWNER || !nextActive)) {
        const otherOwners = await TenantUser.findAll({where: {tenantId: actor.tenantId, role: RoleCode.OWNER,
            userId: {[Op.ne]: targetUserId}, deactivatedAt: null}, attributes: ['userId'], transaction});
        const activeOwners = otherOwners.length ? await User.count({where: {
            id: {[Op.in]: otherOwners.map(owner => owner.userId)}, deactivatedAt: null}, transaction}) : 0;
        if (!activeOwners) throw new TeamOffboardingError(409, 'TEAM_OWNER_REQUIRED', 'Lo studio deve avere almeno un titolare attivo.');
    }
    const affected = own.filter(row => {
        const before = !membership.deactivatedAt && !identity.get('deactivatedAt') && isEligibleActivityRole(resolveEffectiveRole(membership.role, row.role));
        const override = nextRole === RoleCode.OWNER ? null : change.kind === 'structureRole' && change.structureId === row.structureId ? change.role : row.role;
        const after = nextActive && !identity.get('deactivatedAt') && nextStructureIds.includes(row.structureId)
            && isEligibleActivityRole(resolveEffectiveRole(nextRole, override));
        const removed = !nextActive || !nextStructureIds.includes(row.structureId);
        return !after && (before || removed);
    }).map(row => row.structureId);
    const activityRows = new Map<string, Activity[]>();
    const assignmentRows = new Map<string, ActivityAssignment[]>();
    const eligibleIds = new Map<string, Set<string>>();
    const impact: TeamOffboardingImpact = {fingerprint: '', structures: []};
    const fingerprints: unknown[] = [];
    const actorStructures = await StructureUser.findAll({where: {userId: actor.userId, structureId: {[Op.in]: allowed}}, transaction});
    for (const structureId of affected.sort()) {
        const board = boards.find(row => row.structureId === structureId);
        if (!board) throw new TeamOffboardingError(503, 'ACTIVITY_BOARD_UNAVAILABLE', 'Le attività di questa sede devono essere predisposte prima di modificare il team.');
        const context: ActivityContext = {tenantId: actor.tenantId, structureId, userId: actor.userId, schema: actor.schema,
            role: actor.role, permissions: getRolePermissions(actor.role), timezone: board.timezone};
        const [assignments, eligible, appointmentImpact, candidateEvents] = await Promise.all([
            ActivityAssignment.schema(actor.schema).findAll({where: {userId: targetUserId}, transaction}),
            assignableActivityUsers(context, transaction),
            getOperatorDeactivationImpact(actor.tenantId, actor.schema, targetUserId, new Date(), structureId, transaction),
            AgendaEvent.schema(actor.schema).findAll({where: {structureId, calendarId: targetUserId},
                attributes: ['id', 'start', 'end', 'recurrence', 'status', 'updatedAt'], order: [['id', 'ASC']], transaction,
                ...(lock ? {lock: transaction.LOCK.UPDATE} : {})})
        ]);
        const rows = assignments.length ? await Activity.schema(actor.schema).findAll({where: {boardId: board.id,
            id: {[Op.in]: assignments.map(row => row.activityId)}, archivedAt: null, status: {[Op.ne]: 'COMPLETED'}},
            order: [['id', 'ASC']], transaction}) : [];
        const allAssignments = rows.length ? await ActivityAssignment.schema(actor.schema).findAll({where: {
            activityId: {[Op.in]: rows.map(row => row.id)}}, order: [['activityId', 'ASC'], ['userId', 'ASC']], transaction}) : [];
        const enabledAlerts = rows.length ? await ActivityAlert.schema(actor.schema).findAll({where: {
            activityId: {[Op.in]: rows.map(row => row.id)}, enabled: true}, transaction}) : [];
        const eligibleSet = new Set(eligible.filter(row => row.id !== targetUserId).map(row => row.id));
        const orphaned = rows.filter(row => !allAssignments.some(item => item.activityId === row.id && eligibleSet.has(item.userId)));
        const visibleRole = resolveEffectiveRole(actor.role, actorStructures.find(row => row.structureId === structureId)?.role);
        const canReadDetails = actorStructures.some(row => row.structureId === structureId)
            && hasPermission(getRolePermissions(visibleRole), 'activity', 'read', 'structure');
        const exceptions = candidateEvents.length ? await AgendaEventException.schema(actor.schema).findAll({where: {
            eventId: {[Op.in]: candidateEvents.map(row => row.id)}}, attributes: ['id', 'eventId', 'exdate', 'updatedAt'],
            order: [['id', 'ASC']], transaction, ...(lock ? {lock: transaction.LOCK.UPDATE} : {})}) : [];
        impact.structures.push({structureId, structureName: structures.find(row => row.id === structureId)?.get('name') as string ?? 'Sede',
            appointments: appointmentImpact,
            activities: {openAssignedCount: rows.length, orphanCount: orphaned.length,
                alertsDisabledCount: enabledAlerts.filter(alert => orphaned.some(row => row.id === alert.activityId)).length,
                replacementOperators: eligible.filter(row => row.id !== targetUserId).map(row => ({id: row.id,
                    fullName: [row.name, row.surname].filter(Boolean).join(' ') || 'Operatore'})),
                canReadDetails, items: canReadDetails ? rows.map(row => ({id: row.id, title: row.title, wouldBecomeUnassigned: orphaned.includes(row)})) : []}});
        fingerprints.push({structureId, activities: rows.map(row => ({id: row.id, version: row.version, status: row.status})),
            assignments: allAssignments.map(row => ({activityId: row.activityId, userId: row.userId, eligible: eligibleSet.has(row.userId)})),
            alerts: enabledAlerts.map(row => ({activityId: row.activityId, version: row.scheduleVersion})).sort((a, b) => a.activityId.localeCompare(b.activityId)),
            appointments: candidateEvents.map(row => row.get({plain: true})), exceptions: exceptions.map(row => row.get({plain: true})),
            appointmentCounts: {singles: appointmentImpact.futureSingleAppointments, series: appointmentImpact.futureRecurringSeries}});
        activityRows.set(structureId, rows); assignmentRows.set(structureId, allAssignments); eligibleIds.set(structureId, eligibleSet);
    }
    impact.fingerprint = hash({tenantId: actor.tenantId, structureId: actor.structureId, targetUserId, change, membership: {role: membership.role, active: !membership.deactivatedAt,
        globallyActive: !identity.get('deactivatedAt')}, structures: own.map(row => ({id: row.structureId, role: row.role})), fingerprints});
    return {actor, change, targetUserId, membership, identity, structures, memberships: own, boards,
        affectedStructureIds: affected, nextRole, nextStructureIds, impact, activityRows, assignmentRows, eligibleIds};
}

async function allBoards(actor: TeamActor, transaction: Transaction, lock: boolean) {
    try {
        return await ActivityBoard.schema(actor.schema).findAll({order: [['structureId', 'ASC'], ['id', 'ASC']], transaction,
            ...(lock ? {lock: transaction.LOCK.UPDATE} : {})});
    } catch (error) {
        const code = (error as {original?: {code?: string}}).original?.code;
        if (code === '42P01' || code === '42703') throw new TeamOffboardingError(503, 'ACTIVITY_BOARD_UNAVAILABLE', 'Predisponi le attività dello studio prima di modificare il team.');
        throw error;
    }
}
export async function getTeamOffboardingImpact(req: Request, targetUserId: string, change: TeamChange) {
    return sequelize.transaction({isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ, readOnly: true}, async transaction => {
        const actor = await actorContext(req, transaction);
        const prepared = await prepare(actor, uuid(targetUserId), change, transaction, false, await allBoards(actor, transaction, false));
        return prepared.impact;
    });
}
function parseResolutions(value: unknown, allowed: readonly string[]): TeamStructureResolution[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) fail('Scegli come gestire le attività e gli appuntamenti nelle sedi coinvolte.');
    const seen = new Set<string>();
    return value.map(raw => {
        const item = record(raw); const structureId = uuid(item.structureId);
        if (!allowed.includes(structureId) || seen.has(structureId) || Object.keys(item).some(key => !['structureId', 'appointments', 'activities'].includes(key))) fail('La scelta per una sede non è valida.');
        seen.add(structureId);
        const parse = (rawChoice: unknown): TeamResolution | undefined => {
            if (rawChoice === undefined) return undefined;
            const choice = record(rawChoice);
            if (choice.kind === 'defer' && Object.keys(choice).length === 1) return {kind: 'defer'};
            if (choice.kind === 'replace' && Object.keys(choice).every(key => ['kind', 'userId'].includes(key))) return {kind: 'replace', userId: uuid(choice.userId)};
            fail('Scegli se riassegnare subito oppure gestire in seguito.');
        };
        return {structureId, appointments: parse(item.appointments), activities: parse(item.activities)};
    });
}

async function applyOffboarding(prepared: PreparedTeamChange, resolutions: TeamStructureResolution[], transaction: Transaction) {
    const {actor, targetUserId} = prepared;
    for (const impact of prepared.impact.structures) {
        const decision = resolutions.find(row => row.structureId === impact.structureId);
        const appointmentDecision = decision?.appointments;
        if (impact.appointments.hasFutureAppointments) {
            if (!appointmentDecision) throw new TeamOffboardingError(409, 'FUTURE_APPOINTMENTS_REQUIRE_REASSIGNMENT',
                'Scegli come gestire gli appuntamenti futuri in ciascuna sede.', prepared.impact);
            if (appointmentDecision.kind === 'replace') await reassignFutureAppointments(actor.tenantId, actor.schema, targetUserId,
                appointmentDecision.userId, transaction, new Date(), impact.structureId);
        }
        const activityDecision = decision?.activities;
        if (impact.activities.orphanCount && !activityDecision) throw new TeamOffboardingError(409, 'OPEN_ACTIVITIES_REQUIRE_REASSIGNMENT',
            'Questo operatore ha attività aperte che resterebbero senza responsabile. Scegli come gestirle.', prepared.impact);
        const eligible = prepared.eligibleIds.get(impact.structureId)!;
        if (activityDecision?.kind === 'replace' && !eligible.has(activityDecision.userId)) {
            throw new TeamOffboardingError(409, 'INVALID_ASSIGNEE', 'Il nuovo responsabile non è più disponibile nella sede. Controlla le scelte.', prepared.impact);
        }
        const activities = prepared.activityRows.get(impact.structureId)!;
        const assignments = prepared.assignmentRows.get(impact.structureId)!;
        for (const activity of activities) {
            const previous = assignments.filter(row => row.activityId === activity.id).map(row => row.userId);
            const next = previous.filter(id => id !== targetUserId);
            const orphan = !next.some(id => eligible.has(id));
            if (orphan && activityDecision?.kind === 'replace') next.push(activityDecision.userId);
            await ActivityAssignment.schema(actor.schema).destroy({where: {activityId: activity.id, userId: targetUserId}, transaction});
            if (orphan && activityDecision?.kind === 'replace') await ActivityAssignment.schema(actor.schema).bulkCreate([
                {activityId: activity.id, userId: activityDecision.userId, assignedByUserId: actor.userId}], {ignoreDuplicates: true, transaction});
            await activity.update({version: activity.version + 1, updatedByUserId: actor.userId,
                reassignmentRequired: orphan && activityDecision?.kind !== 'replace'}, {transaction});
            const alert = await ActivityAlert.schema(actor.schema).findOne({where: {activityId: activity.id}, transaction});
            if (alert) {
                await cancelActivityDeliveries(actor.schema, alert.id, transaction, {remove: [targetUserId]});
                if (orphan && activityDecision?.kind !== 'replace' && alert.enabled) {
                    await alert.update({enabled: false, scheduleVersion: alert.scheduleVersion + 1}, {transaction});
                    await cancelActivityDeliveries(actor.schema, alert.id, transaction);
                    await ActivityHistory.schema(actor.schema).create({activityId: activity.id, actorUserId: actor.userId,
                        eventType: 'ALERT_CANCELLED', data: {reason: 'LAST_ELIGIBLE_ASSIGNEE_REMOVED'}}, {transaction});
                }
            }
            if (alert?.enabled) await materializeActivityDeliveries(actor.schema, alert, transaction, {reactivateRecipients: true});
            await ActivityHistory.schema(actor.schema).create({activityId: activity.id, actorUserId: actor.userId,
                eventType: 'ASSIGNEE_OFFBOARDED', data: {userId: targetUserId, reason: prepared.change.kind,
                    previousAssigneeIds: previous, assigneeIds: next, reassignmentRequired: activity.reassignmentRequired}}, {transaction});
        }
        if (activities.length) {
            const board = prepared.boards.find(row => row.structureId === impact.structureId)!;
            await board.update({snapshotRevision: board.snapshotRevision + 1}, {transaction});
        }
    }
}

/** Callback runs in the same transaction after impact approval; it must not start another transaction. */
export async function runTeamMutation<T extends Record<string, any>>(
    req: Request, targetUserId: string, change: TeamChange,
    apply: (transaction: Transaction, prepared: PreparedTeamChange) => Promise<T>
): Promise<{data: T; replayed: boolean}> {
    const tenantId = getCurrentTenantId(req);
    return sequelize.transaction(async transaction => {
        await acquireTenantActivityGate(tenantId, transaction, 'exclusive');
        const actor = await actorContext(req, transaction);
        const boards = await allBoards(actor, transaction, true);
        const body = record(req.body);
        const operationId = body.operationId === undefined ? null : uuid(body.operationId);
        const inputHash = hash({targetUserId: uuid(targetUserId), change, body});
        const origin = boards.find(board => board.structureId === actor.structureId);
        if (operationId && !origin) throw new TeamOffboardingError(403, 'TEAM_CONTEXT_REQUIRED', 'Seleziona una sede prima di modificare il team.');
        const operations = ActivityOperation.schema(actor.schema);
        if (operationId && origin) {
            const receipt = await operations.findOne({where: {boardId: origin.id, actorUserId: actor.userId, operationId}, transaction});
            if (receipt) {
                if (receipt.command !== 'team.' + change.kind || receipt.inputHash !== inputHash) {
                    throw new TeamOffboardingError(409, 'OPERATION_ID_REUSED', 'Questa operazione è già stata usata con una scelta diversa. Controlla il membro prima di riprovare.');
                }
                return {data: structuredClone(receipt.responseBody) as T, replayed: true};
            }
        }
        // Lock all tenant memberships before calendars; activities already hold the board locks.
        await TenantUser.findAll({where: {tenantId: actor.tenantId}, order: [['userId', 'ASC']], transaction, lock: transaction.LOCK.UPDATE});
        const structures = await Structure.findAll({where: {tenantId: actor.tenantId}, attributes: ['id'], transaction});
        await StructureUser.findAll({where: {structureId: {[Op.in]: structures.map(row => row.id)}},
            order: [['userId', 'ASC'], ['structureId', 'ASC']], transaction, lock: transaction.LOCK.UPDATE});
        const prepared = await prepare(actor, uuid(targetUserId), change, transaction, true, boards);
        const resolutions = parseResolutions(body.resolutions, prepared.structures.map(row => row.id));
        // Legacy choices remain exclusively about appointments.
        if (body.replacementUserId !== undefined && body.replacementUserId !== null) uuid(body.replacementUserId);
        if (body.deferReassignment !== undefined && typeof body.deferReassignment !== 'boolean') fail('La scelta di riassegnazione non è valida.');
        if (body.replacementUserId && body.deferReassignment) fail('Scegli se riassegnare subito oppure gestire in seguito.');
        for (const structureId of prepared.affectedStructureIds) {
            let entry = resolutions.find(row => row.structureId === structureId);
            if (!entry) { entry = {structureId}; resolutions.push(entry); }
            if (!entry.appointments && (body.replacementUserId || body.deferReassignment)) {
                entry.appointments = body.replacementUserId ? {kind: 'replace', userId: uuid(body.replacementUserId)} : {kind: 'defer'};
            }
        }
        if (body.impactFingerprint !== undefined && (typeof body.impactFingerprint !== 'string'
            || body.impactFingerprint !== prepared.impact.fingerprint)) {
            throw new TeamOffboardingError(409, 'OFFBOARDING_IMPACT_CHANGED', 'L’impatto sul team è cambiato. Controlla nuovamente appuntamenti e attività prima di confermare.', prepared.impact);
        }
        const hasAffectedWork = prepared.impact.structures.some(row => row.activities.openAssignedCount || row.appointments.hasFutureAppointments);
        if (hasAffectedWork && !body.impactFingerprint) {
            const orphan = prepared.impact.structures.some(row => row.activities.orphanCount);
            throw new TeamOffboardingError(409, orphan ? 'OPEN_ACTIVITIES_REQUIRE_REASSIGNMENT' : 'OFFBOARDING_IMPACT_CHANGED',
                'Controlla le attività e gli appuntamenti coinvolti prima di modificare il membro.', prepared.impact);
        }
        await applyOffboarding(prepared, resolutions, transaction);
        const data = await apply(transaction, prepared);
        if (operationId && origin) await operations.create({boardId: origin.id, actorUserId: actor.userId, operationId,
            command: 'team.' + change.kind, inputHash, responseStatus: 200, responseBody: data,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000)}, {transaction});
        return {data, replayed: false};
    });
}

export async function applyTeamMembershipChange(transaction: Transaction, prepared: PreparedTeamChange) {
    const {change, membership, identity, targetUserId, actor, memberships, nextRole, nextStructureIds} = prepared;
    if (change.kind === 'status') {
        await membership.update({deactivatedAt: change.active ? null : new Date()}, {transaction});
        if (change.active && identity.get('deactivatedAt')) await identity.update({deactivatedAt: null}, {transaction});
    } else if (change.kind === 'remove') {
        await StructureUser.destroy({where: {userId: targetUserId, structureId: {[Op.in]: prepared.structures.map(row => row.id)}}, transaction});
        await membership.destroy({transaction});
    } else if (change.kind === 'structureRole') {
        await StructureUser.update({role: change.role}, {where: {userId: targetUserId, structureId: change.structureId}, transaction});
    } else {
        if (membership.role !== nextRole) await membership.update({role: nextRole}, {transaction});
        const previous = memberships.map(row => row.structureId);
        const removed = previous.filter(id => !nextStructureIds.includes(id));
        const added = nextStructureIds.filter(id => !previous.includes(id));
        if (removed.length) await StructureUser.destroy({where: {userId: targetUserId, structureId: {[Op.in]: removed}}, transaction});
        if (added.length) await StructureUser.bulkCreate(added.map(structureId => ({structureId, userId: targetUserId,
            role: null, calendarEnabled: defaultCalendarEnabled(nextRole)})), {transaction});
        if (nextRole === RoleCode.OWNER) await StructureUser.update({role: null}, {where: {
            userId: targetUserId, structureId: {[Op.in]: nextStructureIds}}, transaction});
    }
    return {userId: targetUserId, tenantId: actor.tenantId, role: nextRole, structureIds: nextStructureIds,
        ...(change.kind === 'remove' ? {deleted: 1} : {})};
}

export function sendTeamOffboardingError(res: Response, error: unknown): boolean {
    if (!(error instanceof TeamOffboardingError)) return false;
    sendErrorResponse(res, error.status, error.message, {code: error.code, ...(error.impact ? {impact: error.impact} : {})});
    return true;
}
