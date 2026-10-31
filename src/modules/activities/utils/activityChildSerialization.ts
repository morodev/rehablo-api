import {Op, Transaction} from 'sequelize';
import User from '../../auth/models/user.model.js';
import TenantUser from '../../auth/models/tenantUser.model.js';
import StructureUser from '../../auth/models/structureUser.model.js';
import {resolveEffectiveRole} from '../../auth/rbac/roles.js';
import {resolveGrantedScope} from '../../auth/rbac/permissions.js';
import type {ActivityChecklistItemDto, ActivityCommentDto, ActivityContext, ActivityHistoryDto, ActivityUserSummary} from '../activities.types.js';
import {activityCapabilities, isEligibleActivityRole} from '../services/activityAccess.service.js';
import type {Activity, ActivityChecklistItem, ActivityComment, ActivityHistory} from '../models/index.js';

export async function activityUserSummaries(context: ActivityContext, ids: Array<string | null>, transaction: Transaction): Promise<Map<string, ActivityUserSummary>> {
    const unique = [...new Set(ids.filter(Boolean) as string[])];
    if (!unique.length) return new Map();
    const [rows, memberships, assignments] = await Promise.all([
        User.findAll({where: {id: {[Op.in]: unique}}, attributes: ['id', 'name', 'surname', 'deactivatedAt'], transaction}),
        TenantUser.findAll({where: {tenantId: context.tenantId, userId: {[Op.in]: unique}},
            attributes: ['userId', 'role', 'deactivatedAt'], transaction}),
        StructureUser.findAll({where: {structureId: context.structureId, userId: {[Op.in]: unique}},
            attributes: ['userId', 'role'], transaction})
    ]);
    const tenantMembers = new Map(memberships.map(row => [row.userId, row]));
    const structureMembers = new Map(assignments.map(row => [row.userId, row]));
    // Keep the historical name even when membership disappears. Email verification
    // (User.isActive) is distinct from suspension and does not affect this flag.
    return new Map(rows.map(row => {
        const membership = tenantMembers.get(row.id), assignment = structureMembers.get(row.id);
        const role = resolveEffectiveRole(membership?.role, assignment?.role);
        const eligible = !row.deactivatedAt && !!membership && !membership.deactivatedAt && !!assignment && isEligibleActivityRole(role);
        return [row.id, {id: row.id, name: row.name ?? null, surname: row.surname ?? null, role, eligible}];
    }));
}
const iso = (value: Date | string | null): string | null => value ? new Date(value).toISOString() : null;

export async function serializeChecklist(context: ActivityContext, rows: ActivityChecklistItem[], transaction: Transaction): Promise<ActivityChecklistItemDto[]> {
    const summaries = await activityUserSummaries(context, rows.flatMap(row => [row.createdByUserId, row.checkedByUserId]), transaction);
    return rows.map(row => ({id: row.id, activityId: row.activityId, text: row.text, position: String(row.position),
        createdByUserId: row.createdByUserId, checked: row.checked, checkedByUserId: row.checkedByUserId,
        checkedAt: iso(row.checkedAt), version: row.version, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)!,
        createdBy: summaries.get(row.createdByUserId) ?? null, checkedBy: summaries.get(row.checkedByUserId ?? '') ?? null}));
}
export function commentCapabilities(context: ActivityContext, activity: Activity, authorId: string, deletedAt: Date | null) {
    const canComment = activityCapabilities(context, activity.get({plain: true}), context.execution?.assigneeIds ?? []).canComment;
    const manage = resolveGrantedScope(context.permissions, 'activity', 'manage');
    const allowed = canComment && !deletedAt && (authorId === context.userId || manage === 'structure' || manage === 'tenant');
    return {canEdit: allowed, canDelete: allowed};
}
export async function serializeComments(context: ActivityContext, activity: Activity, rows: ActivityComment[], transaction: Transaction): Promise<ActivityCommentDto[]> {
    const summaries = await activityUserSummaries(context, rows.map(row => row.authorUserId), transaction);
    return rows.map(row => ({id: row.id, activityId: row.activityId, authorUserId: row.authorUserId,
        author: summaries.get(row.authorUserId) ?? null, text: row.deletedAt ? null : row.text, version: row.version,
        editedAt: iso(row.editedAt), deletedAt: iso(row.deletedAt), createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)!,
        capabilities: commentCapabilities(context, activity, row.authorUserId, row.deletedAt)}));
}
export async function serializeHistory(context: ActivityContext, rows: ActivityHistory[], transaction: Transaction): Promise<ActivityHistoryDto[]> {
    const summaries = await activityUserSummaries(context, rows.map(row => row.actorUserId), transaction);
    return rows.map(row => ({id: row.id, activityId: row.activityId, executionId: row.executionId ?? null, actorUserId: row.actorUserId,
        eventType: row.eventType, data: row.data ?? {}, createdAt: iso(row.createdAt)!, actor: summaries.get(row.actorUserId ?? '') ?? null}));
}
