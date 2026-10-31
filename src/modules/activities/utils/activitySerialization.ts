import {
    ACTIVITY_ALERT_CHANNELS, ActivityAlertDto, ActivityAlertRecord, ActivityBoardDto,
    ActivityBoardRecord, ActivityCardDto, ActivityContext, ActivityRecord, ActivityUserSummary
} from '../activities.types.js';
import {activityCapabilities, canManageActivityRecurrence} from '../services/activityAccess.service.js';
import {dueFromActivity, isActivityOverdue} from './activityValidation.js';

export interface ActivitySerializationOptions {
    assigneeIds?: readonly string[];
    assignees?: readonly ActivityUserSummary[];
    people?: ReadonlyMap<string, ActivityUserSummary>;
    createdBy?: ActivityUserSummary | null;
    updatedBy?: ActivityUserSummary | null;
    alert?: ActivityAlertRecord | null;
    deliveryState?: ActivityAlertDto['deliveryState'];
    checklistProgress?: {total: number; checked: number};
    commentCount?: number;
    evaluationAt?: Date;
    /** Supply only links returned by the current linked-resource access policy. */
    links?: {patientId: string | null; agendaEventId: string | null};
    templateLinks?: {patientId: string | null; agendaEventId: string | null};
}

function iso(value: Date | string | null | undefined): string | null {
    return value == null ? null : new Date(value).toISOString();
}

function person(user: ActivityUserSummary | undefined): ActivityUserSummary | null {
    return user ? {
        id: user.id, name: user.name ?? null, surname: user.surname ?? null,
        ...(user.role !== undefined ? {role: user.role} : {}),
        ...(user.eligible !== undefined ? {eligible: user.eligible} : {})
    } : null;
}

function serializeAlert(alert: ActivityAlertRecord | null | undefined): ActivityAlertDto | null {
    if (!alert?.scheduledAt) return null;
    const channels = ACTIVITY_ALERT_CHANNELS.filter(channel => alert.channels.includes(channel));
    return {
        enabled: alert.enabled,
        scheduledAt: iso(alert.scheduledAt)!,
        scheduleVersion: alert.scheduleVersion,
        channels
    };
}

/** Plain record in; explicit public DTO out. Internal columns and Sequelize metadata never leak. */
export function serializeActivity(
    activity: ActivityRecord, context: ActivityContext, options: ActivitySerializationOptions = {}
): ActivityCardDto {
    const due = dueFromActivity(activity);
    const assigneeIds = [...new Set(options.assigneeIds ?? options.assignees?.map(user => user.id) ?? [])];
    const byUser = new Map(options.assignees?.map(user => [user.id, user]) ?? []);
    const archivedAt = iso(activity.archivedAt);
    const progress = options.checklistProgress ?? {total: 0, checked: 0};
    return {
        id: activity.id,
        boardId: activity.boardId,
        title: activity.title,
        description: activity.description ?? null,
        status: activity.status,
        priority: activity.priority,
        position: String(activity.position),
        version: activity.version,
        checklistRevision: activity.checklistRevision,
        due,
        alert: options.alert?.scheduledAt ? {...serializeAlert(options.alert)!, ...(options.deliveryState ? {deliveryState: options.deliveryState} : {})} : null,
        assigneeIds,
        reviewerUserId: activity.reviewerUserId ?? null,
        reviewer: activity.reviewerUserId ? person(options.people?.get(activity.reviewerUserId))
            ?? {id: activity.reviewerUserId, name: null, surname: null, eligible: false} : null,
        reviewStatus: activity.reviewStatus ?? 'not_requested',
        reviewApprovedByUserId: activity.reviewApprovedByUserId ?? null,
        reviewApprovedAt: iso(activity.reviewApprovedAt),
        assignees: assigneeIds.map(id => person(byUser.get(id) ?? options.people?.get(id))
            ?? {id, name: null, surname: null, eligible: false}),
        createdByUserId: activity.createdByUserId,
        updatedByUserId: activity.updatedByUserId ?? null,
        createdBy: person(options.createdBy ?? options.people?.get(activity.createdByUserId)),
        updatedBy: activity.updatedByUserId ? person(options.updatedBy ?? options.people?.get(activity.updatedByUserId)) : null,
        patientId: options.links?.patientId ?? null,
        agendaEventId: options.links?.agendaEventId ?? null,
        completedAt: iso(activity.completedAt),
        completedByUserId: activity.completedByUserId ?? null,
        archivedAt,
        archivedByUserId: activity.archivedByUserId ?? null,
        createdAt: iso(activity.createdAt)!,
        updatedAt: iso(activity.updatedAt)!,
        reassignmentRequired: !!activity.reassignmentRequired,
        isOverdue: isActivityOverdue(due, activity.status, archivedAt, options.evaluationAt),
        checklistProgress: {total: progress.total, checked: progress.checked},
        commentCount: options.commentCount ?? 0,
        capabilities: activityCapabilities(context, activity, assigneeIds),
        ...(activity.recurrence ? {recurrence: {frequency: activity.recurrence.frequency, interval: activity.recurrence.interval,
            startsOn: activity.recurrence.startsOn, endsOn: activity.recurrence.endsOn, status: activity.recurrence.status,
            nextDate: activity.recurrence.nextDate, blockedReason: activity.recurrence.blockedReason,
            canManage: canManageActivityRecurrence(context, activity),
            template: {...activity.recurrence.template,
                assignees: activity.recurrence.template.assigneeIds.map(id => person(options.people?.get(id)) ?? {id, name: null, surname: null, eligible: false}),
                reviewer: activity.recurrence.template.reviewerUserId ? person(options.people?.get(activity.recurrence.template.reviewerUserId))
                    ?? {id: activity.recurrence.template.reviewerUserId, name: null, surname: null, eligible: false} : null,
                patientId: options.templateLinks?.patientId ?? null, agendaEventId: options.templateLinks?.agendaEventId ?? null}},
            currentExecutionId: activity.currentExecutionId ?? null, executionDate: activity.executionDate ?? null,
            executionClosedAt: iso(activity.executionClosedAt), lateUpdatedAt: iso(activity.lateUpdatedAt)} : {})
    };
}

export function serializeBoard(board: ActivityBoardRecord): ActivityBoardDto {
    return {
        id: board.id, structureId: board.structureId, timezone: board.timezone,
        orderRevision: board.orderRevision, snapshotRevision: board.snapshotRevision
    };
}
