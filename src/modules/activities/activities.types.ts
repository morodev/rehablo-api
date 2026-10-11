import type {Permission} from '../auth/rbac/permissions.js';
import type {RoleCode} from '../auth/rbac/roles.js';

export const ACTIVITY_STATUSES = ['TODO', 'IN_PROGRESS', 'WAITING', 'COMPLETED'] as const;
export type ActivityStatus = typeof ACTIVITY_STATUSES[number];
export const ACTIVITY_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type ActivityPriority = typeof ACTIVITY_PRIORITIES[number];
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
    due: ActivityDue;
    alert: ActivityAlertInput | null;
    patientId: string | null;
    agendaEventId: string | null;
}

export interface ActivityCreateInput extends ActivityCoreFields {
    operationId: string;
    status: ActivityStatus;
    checklist: Array<{text: string}>;
}

export type ActivityChanges = Partial<ActivityCoreFields>;
export interface ActivityPatchInput {
    operationId: string;
    expectedVersion: number;
    changes: ActivityChanges;
}

export type ActivityPlacement = {kind: 'start' | 'end'} | {kind: 'before'; activityId: string};
export interface ActivityMoveInput {
    operationId: string;
    expectedVersion: number;
    expectedOrderRevision: number;
    targetStatus: ActivityStatus;
    placement: ActivityPlacement;
    expectedChecklistRevision?: number;
    allowIncompleteChecklist?: boolean;
}

export interface ActivityArchiveInput {
    operationId: string;
    expectedVersion: number;
    expectedOrderRevision: number;
}
export type ActivityRestoreInput = ActivityArchiveInput;

export type ActivityView = 'board' | 'list' | 'archived';
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
}

export interface ActivityCapabilities {
    canEdit: boolean;
    canMove: boolean;
    canAssign: boolean;
    canManageChecklist: boolean;
    canComment: boolean;
    canArchive: boolean;
    canRestore: boolean;
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
export interface ActivityChecklistCreateInput {operationId: string; expectedChecklistRevision: number; text: string; placement: ActivityChecklistPlacement;}
export interface ActivityChecklistPatchInput {operationId: string; expectedVersion: number; changes: {text?: string; checked?: boolean};}
export interface ActivityChecklistDeleteInput {operationId: string; expectedVersion: number; expectedChecklistRevision: number;}
export interface ActivityChecklistMoveInput {operationId: string; expectedChecklistRevision: number; placement: ActivityChecklistPlacement;}
export interface ActivityCommentCreateInput {operationId: string; text: string;}
export interface ActivityCommentPatchInput extends ActivityCommentCreateInput {expectedVersion: number;}
export interface ActivityCommentDeleteInput {operationId: string; expectedVersion: number;}
export interface ActivityChildPageQuery {limit: number; cursor: string | null; offset: number;}
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
    checklistRevision: number; snapshotRevision: number;
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
}

export interface ActivityMutationResponse {
    activity: ActivityCardDto;
    orderRevision: number;
    snapshotRevision: number;
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
    view: 'list' | 'archived';
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
