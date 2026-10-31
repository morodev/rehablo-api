import type {Permission} from '../auth/rbac/permissions.js';
import type {RoleCode} from '../auth/rbac/roles.js';
import type {Activity, ActivityExecution} from './models/index.js';

export interface ActivityRecurrenceRule {
    frequency: 'daily' | 'weekly'; interval: number; startsOn: string; endsOn: string | null;
}
export interface ActivityRecurrenceTemplate {
    title: string; description: string | null; priority: ActivityPriority; assigneeIds: string[];
    reviewerUserId: string | null; patientId: string | null; agendaEventId: string | null;
    checklist: Array<{text: string}>;
}
export interface ActivityRecurrenceConfiguration extends ActivityRecurrenceRule {
    status: 'active' | 'stopped' | 'ended'; nextDate: string | null; blockedReason: string | null;
    template: ActivityRecurrenceTemplate;
}
export interface ActivityExecutionInput {expectedExecutionId?: string | null;}

export const ACTIVITY_STATUSES = ['TODO', 'IN_PROGRESS', 'WAITING', 'COMPLETED'] as const;
export type ActivityStatus = typeof ACTIVITY_STATUSES[number];
export const ACTIVITY_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type ActivityPriority = typeof ACTIVITY_PRIORITIES[number];
export type ActivityReviewStatus = 'not_requested' | 'pending' | 'approved';
export interface ActivityReviewInput extends ActivityArchiveInput {
    action: 'request' | 'approveAndComplete' | 'authorizeCompletion' | 'returnToProgress';
    expectedChecklistRevision: number; comment?: string;
}
export const ACTIVITY_ALERT_CHANNELS = ['inApp', 'push', 'email'] as const;
export type ActivityAlertChannel = typeof ACTIVITY_ALERT_CHANNELS[number];
export const ACTIVITY_TIMEZONE = 'Europe/Rome';

export type ActivityDue = null
    | {kind: 'timed'; at: string}
    | {kind: 'allDay'; date: string; timezone: string};

export interface ActivityAlertInput {
    scheduledAt: string;
    /** inApp is always included when an alert is explicitly activated. */
    channels: ActivityAlertChannel[];
}

export interface ActivityCoreFields {
    title: string;
    description: string | null;
    priority: ActivityPriority;
    assigneeIds: string[];
    reviewerUserId?: string | null;
    due: ActivityDue;
    alert: ActivityAlertInput | null;
    patientId: string | null;
    agendaEventId: string | null;
}

export interface ActivityCreateInput extends ActivityCoreFields {
    operationId: string;
    status: ActivityStatus;
    checklist: Array<{text: string}>;
    recurrence?: ActivityRecurrenceRule;
}

export type ActivityChanges = Partial<ActivityCoreFields> & {recurrence?: ActivityRecurrenceRule; recurrenceTemplate?: ActivityRecurrenceTemplate};
export interface ActivityPatchInput extends ActivityExecutionInput {
    operationId: string;
    expectedVersion: number;
    changes: ActivityChanges;
}

export type ActivityPlacement = {kind: 'start' | 'end'} | {kind: 'before'; activityId: string};
export interface ActivityMoveInput extends ActivityExecutionInput {
    operationId: string;
    expectedVersion: number;
    expectedOrderRevision: number;
    targetStatus: ActivityStatus;
    placement: ActivityPlacement;
    expectedChecklistRevision?: number;
    allowIncompleteChecklist?: boolean;
}

export interface ActivityArchiveInput extends ActivityExecutionInput {
    operationId: string;
    expectedVersion: number;
    expectedOrderRevision: number;
    scope?: 'execution' | 'routine';
}
export type ActivityRestoreInput = ActivityArchiveInput;

export type ActivityView = 'board' | 'list' | 'archived' | 'recurring';
export type ActivityDueFilter = 'today' | 'overdue' | 'todayOrOverdue' | 'upcoming' | 'none';
export interface ActivityFilters {
    search: string;
    mine: boolean;
    statuses: ActivityStatus[];
    priority: ActivityPriority | null;
    assigneeId: string | null;
    due: ActivityDueFilter | null;
    unassigned: boolean;
    reassignmentRequired: boolean;
    patientId: string | null;
    includeAllCompleted: boolean;
    agendaEventId?: string | null;
}
export interface ActivityQuery extends ActivityFilters {
    view: ActivityView;
    limit: number;
    cursor: string | null;
    limits: Partial<Record<ActivityStatus, number>>;
    cursors: Partial<Record<ActivityStatus, string>>;
}

/** Authenticated context checked against current public-schema memberships. */
export interface ActivityContext {
    tenantId: string;
    structureId: string;
    userId: string;
    schema: string;
    role: RoleCode;
    permissions: Permission[];
    timezone: string;
    executionId?: string | null;
    execution?: ActivityExecution;
    parentActivity?: Activity;
    historicalExecution?: boolean;
}

export interface ActivityCapabilities {
    canEdit: boolean;
    canMove: boolean;
    canAssign: boolean;
    canManageChecklist: boolean;
    canComment: boolean;
    canArchive: boolean;
    canRestore: boolean;
    canRequestReview: boolean; canReview: boolean; canComplete: boolean;
    canAssignReviewer: boolean; canReopenChecklist: boolean;
}

export interface ActivityUserSummary {
    id: string;
    name: string | null;
    surname: string | null;
    role?: RoleCode | null;
    eligible?: boolean;
}

export interface ActivityAlertDto extends ActivityAlertInput {
    enabled: boolean;
    scheduleVersion: number;
    deliveryState?: 'scheduled' | 'pending' | 'sent' | 'failed' | 'uncertain' | 'reprogramRequired';
}

export interface ActivityBoardDto {
    id: string;
    structureId: string;
    timezone: string;
    orderRevision: number;
    snapshotRevision: number;
}

export interface ActivityBoardMetadataDto extends ActivityBoardDto {
    serverNow: string;
    columns: Array<{status: ActivityStatus; label: string}>;
    capabilities: {canCreate: boolean};
}

export interface ActivityCardDto {
    id: string;
    boardId: string;
    title: string;
    description: string | null;
    status: ActivityStatus;
    priority: ActivityPriority;
    position: string;
    version: number;
    checklistRevision: number;
    due: ActivityDue;
    alert: ActivityAlertDto | null;
    assigneeIds: string[];
    assignees: ActivityUserSummary[];
    reviewerUserId: string | null; reviewer: ActivityUserSummary | null;
    reviewStatus: ActivityReviewStatus; reviewApprovedByUserId: string | null; reviewApprovedAt: string | null;
    createdByUserId: string;
    updatedByUserId: string | null;
    createdBy: ActivityUserSummary | null;
    updatedBy: ActivityUserSummary | null;
    patientId: string | null;
    agendaEventId: string | null;
    completedAt: string | null;
    completedByUserId: string | null;
    archivedAt: string | null;
    archivedByUserId: string | null;
    createdAt: string;
    updatedAt: string;
    reassignmentRequired: boolean;
    isOverdue: boolean;
    checklistProgress: {total: number; checked: number};
    commentCount: number;
    capabilities: ActivityCapabilities;
    recurrence?: (Omit<ActivityRecurrenceConfiguration, 'template'> & {canManage: boolean;
        template?: ActivityRecurrenceTemplate & {assignees?: ActivityUserSummary[]; reviewer?: ActivityUserSummary | null; links?: ActivityLinksDto}}) | null;
    currentExecutionId?: string | null;
    executionDate?: string | null;
    executionClosedAt?: string | null;
    lateUpdatedAt?: string | null;
}
export interface ActivityChecklistItemDto {
    id: string;
    activityId: string;
    createdByUserId: string;
    text: string;
    position: string;
    checked: boolean;
    checkedByUserId: string | null;
    checkedAt: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
    createdBy?: ActivityUserSummary | null;
    checkedBy?: ActivityUserSummary | null;
}

export type ActivityChecklistPlacement = {kind: 'start' | 'end'} | {kind: 'before'; itemId: string};
export interface ActivityChecklistCreateInput extends ActivityExecutionInput {operationId: string; expectedChecklistRevision: number; text: string; placement: ActivityChecklistPlacement;}
export interface ActivityChecklistPatchInput extends ActivityExecutionInput {operationId: string; expectedVersion: number; allowReopen?: boolean; expectedActivityVersion?: number; changes: {text?: string; checked?: boolean};}
export interface ActivityChecklistDeleteInput extends ActivityExecutionInput {operationId: string; expectedVersion: number; expectedChecklistRevision: number;}
export interface ActivityChecklistMoveInput extends ActivityExecutionInput {operationId: string; expectedChecklistRevision: number; placement: ActivityChecklistPlacement;}
export interface ActivityCommentCreateInput extends ActivityExecutionInput {operationId: string; text: string;}
export interface ActivityCommentPatchInput extends ActivityCommentCreateInput {expectedVersion: number;}
export interface ActivityCommentDeleteInput extends ActivityExecutionInput {operationId: string; expectedVersion: number;}
export interface ActivityChildPageQuery {limit: number; cursor: string | null; offset: number; scope?: 'routine';}
export interface ActivityCursorPage<T> {
    items: T[]; total: number; nextCursor: string | null; evaluationAt: string; queryKey: string; snapshotRevision: number;
}
export interface ActivityCommentDto {
    id: string; activityId: string; authorUserId: string; author: ActivityUserSummary | null;
    text: string | null; version: number; editedAt: string | null; deletedAt: string | null;
    createdAt: string; updatedAt: string; capabilities: {canEdit: boolean; canDelete: boolean};
}
export interface ActivityChecklistMutationResponse {
    activityId: string; item: ActivityChecklistItemDto | null; checklist: ActivityChecklistItemDto[];
    checklistRevision: number; snapshotRevision: number; activity: ActivityCardDto; orderRevision: number;
}
export interface ActivityCommentMutationResponse {activityId: string; comment: ActivityCommentDto; snapshotRevision: number;}

export interface ActivityHistoryDto {
    id: string;
    activityId: string;
    actorUserId: string | null;
    eventType: string;
    data: Record<string, unknown>;
    createdAt: string;
    actor?: ActivityUserSummary | null;
    executionId?: string | null;
}

export interface ActivityMutationResponse {
    activity: ActivityCardDto;
    orderRevision: number;
    snapshotRevision: number;
    executionId?: string | null;
}

export interface ActivityAgendaLinkDto {
    id: string;
    title: string | null;
    start: string | null;
    allDay: boolean;
    isRecurring: boolean;
}

export interface ActivityLookupQuery {
    query: string;
    offset: number;
    limit: number;
}

export interface ActivityAgendaLookupQuery extends ActivityLookupQuery {
    patientId: string | null;
}

export interface ActivityPatientLinkDto {
    id: string;
    displayName: string;
}

export interface ActivityLinksDto {
    patient: ActivityPatientLinkDto | null;
    agendaEvent: ActivityAgendaLinkDto | null;
}

export interface ActivityDetailDto extends ActivityMutationResponse {
    checklist: ActivityChecklistItemDto[];
    history: ActivityHistoryDto[];
    links: ActivityLinksDto;
    commentsPage?: ActivityCursorPage<ActivityCommentDto>;
    historyPage?: ActivityCursorPage<ActivityHistoryDto>;
}

export interface ActivityColumnDto {
    status: ActivityStatus;
    total: number;
    items: ActivityCardDto[];
    nextCursor: string | null;
}
export interface ActivityReadMetadata {
    board: ActivityBoardDto;
    serverNow: string;
    evaluationAt: string;
    queryKey: string;
    snapshotRevision: number;
    orderRevision: number;
}
export interface ActivityBoardResponse extends ActivityReadMetadata {
    view: 'board';
    columns: ActivityColumnDto[];
}
export interface ActivityListResponse extends ActivityReadMetadata {
    view: 'list' | 'archived' | 'recurring';
    total: number;
    items: ActivityCardDto[];
    nextCursor: string | null;
}

export interface ActivitySummaryQuery {mine: boolean; limit: number;}
export interface ActivityLinksQuery {patientId: string | null; agendaEventId: string | null;}
export interface ActivitySummaryResponse {
    board: ActivityBoardDto; evaluationAt: string; serverNow: string; snapshotRevision: number;
    overdue: {total: number; items: ActivityCardDto[]}; today: {total: number; items: ActivityCardDto[]};
}
export interface ActivityLinksResponse extends ActivityLinksDto {
    board: ActivityBoardDto; capabilities: {canCreate: boolean};
}

/** Explicit whitelist of persisted fields; never spread a Sequelize object into a DTO. */
export interface ActivityRecord {
    id: string;
    boardId: string;
    title: string;
    description?: string | null;
    status: ActivityStatus;
    priority: ActivityPriority;
    position: string | number | bigint;
    version: number;
    checklistRevision: number;
    recurrence?: ActivityRecurrenceConfiguration | null;
    currentExecutionId?: string | null;
    executionDate?: string | null;
    executionClosedAt?: Date | string | null;
    lateUpdatedAt?: Date | string | null;
    dueKind: 'timed' | 'allDay' | null;
    dueAt?: Date | string | null;
    dueDate?: string | null;
    dueTimezone?: string | null;
    createdByUserId: string;
    updatedByUserId?: string | null;
    patientId?: string | null;
    agendaEventId?: string | null;
    completedAt?: Date | string | null;
    completedByUserId?: string | null;
    archivedAt?: Date | string | null;
    archivedByUserId?: string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
    reassignmentRequired?: boolean;
    reviewerUserId?: string | null; reviewStatus?: ActivityReviewStatus;
    reviewApprovedByUserId?: string | null; reviewApprovedAt?: Date | string | null;
}
export interface ActivityBoardRecord {
    id: string;
    structureId: string;
    timezone: string;
    orderRevision: number;
    snapshotRevision: number;
}
export interface ActivityAlertRecord {
    enabled: boolean;
    scheduledAt: Date | string | null;
    scheduleVersion: number;
    channels: string[];
}
export interface ActivitySchedule {
    due: ActivityDue;
    alert: ActivityAlertInput | null;
    assigneeIds: readonly string[];
    status: ActivityStatus;
    archivedAt?: Date | string | null;
}
