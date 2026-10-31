import {randomUUID} from 'node:crypto';
import {Op, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {acquireTenantActivityGate} from '../../../utils/tenantActivityGate.js';
import {getTenantSchemaName} from '../../../utils/tenantSchema.js';
import Tenant from '../../auth/models/tenant.model.js';
import User from '../../auth/models/user.model.js';
import TenantUser from '../../auth/models/tenantUser.model.js';
import StructureUser from '../../auth/models/structureUser.model.js';
import Patient from '../../patients/models/patient.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import {resolveEffectiveRole} from '../../auth/rbac/roles.js';
import {Activity, ActivityAssignment, ActivityAlert, ActivityBoard, ActivityChecklistItem, ActivityExecution, ActivityHistory} from '../models/index.js';
import {ACTIVITY_EXECUTION_STATE_FIELDS} from '../models/activityExecution.model.js';
import type {ActivityContext} from '../activities.types.js';
import {ActivityError} from '../utils/activityErrors.js';
import {activityExecutionDeadline, addRecurrenceDays, nextRecurrenceDate, parseActivityRecurrenceRule,
    recurrenceDateOnOrAfter, recurrenceLocalDate, recurrenceOutcome,
    type ActivityRecurrenceRule, type ActivityRecurrenceState, type ActivityRecurrenceTemplate} from '../utils/activityRecurrence.policy.js';
import {isEligibleActivityRole} from './activityAccess.service.js';
import {cancelActivityDeliveries} from './activityDeliveryPersistence.service.js';

export type ActivityRecurrenceContext = Pick<ActivityContext, 'tenantId' | 'schema' | 'structureId' | 'timezone'> & {userId?: string};
const projectionFields = ACTIVITY_EXECUTION_STATE_FIELDS.filter(field => field !== 'archivedAt' && field !== 'archivedByUserId');
const MAX_RECOVERY_BATCH = 100;

function executionState(activity: Activity | ActivityExecution): Record<string, unknown> {
    return Object.fromEntries(projectionFields.map(field => [field, activity.get(field) ?? null]));
}
function json(value: unknown): string {return JSON.stringify(value);}

async function history(context: ActivityRecurrenceContext, activityId: string, executionId: string | null,
    eventType: string, data: Record<string, unknown>, transaction: Transaction): Promise<void> {
    await ActivityHistory.schema(context.schema).create({activityId, executionId, actorUserId: null, eventType, data}, {transaction});
}

/** Capture an ordinary current-cycle mutation; never take assignment/state data from today's card for another day. */
export async function captureCurrentExecution(context: ActivityRecurrenceContext, parent: Activity,
    transaction: Transaction, now = new Date()): Promise<ActivityExecution | null> {
    if (!parent.currentExecutionId) return null;
    const execution = await ActivityExecution.schema(context.schema).findOne({where: {id: parent.currentExecutionId, activityId: parent.id}, transaction});
    if (!execution) throw new ActivityError('ACTIVITY_EXECUTION_NOT_FOUND', 409, 'L’esecuzione non è più disponibile. Aggiorna la scheda.');
    const assignments = await ActivityAssignment.schema(context.schema).findAll({where: {activityId: parent.id}, transaction});
    const values = {...executionState(parent), assigneeIds: assignments.map(row => row.userId).sort()};
    const changed = Object.entries(values).some(([key, value]) => json(value) !== json(execution.get(key)));
    if (changed) await execution.update({...values, version: execution.version + 1,
        ...(context.userId && execution.closedAt ? {lateUpdatedAt: now, lateUpdatedByUserId: context.userId} : {})}, {transaction});
    return execution;
}

/** Only the execution currently represented by the card may change its projection. Board revisions belong to the caller. */
export async function projectExecution(context: ActivityRecurrenceContext, board: ActivityBoard, parent: Activity,
    execution: ActivityExecution, transaction: Transaction): Promise<void> {
    if (parent.currentExecutionId !== execution.id || execution.activityId !== parent.id) return;
    const values = executionState(execution);
    const changed = Object.entries(values).some(([key, value]) => json(value) !== json(parent.get(key)));
    if (changed) await parent.update({...values, version: parent.version + 1}, {transaction});
    // Membership changes for a historical execution never replace current assignment rows.
    const existing = await ActivityAssignment.schema(context.schema).findAll({where: {activityId: parent.id}, transaction});
    if (json(existing.map(row => row.userId).sort()) !== json([...execution.assigneeIds].sort())) {
        await replaceAssignments(context, parent, execution.assigneeIds, transaction);
    }
}

/** Freeze what was recorded by the boundary, not the later corrected state. Does not copy mutable comment text. */
export async function sealActivityExecution(context: ActivityRecurrenceContext, parent: Activity, execution: ActivityExecution,
    transaction: Transaction, now = new Date()): Promise<boolean> {
    if (execution.closedAt) return false;
    const deadline = activityExecutionDeadline(execution.occurrenceDate, context.timezone);
    if (now.getTime() < deadline.getTime()) return false;
    const items = await ActivityChecklistItem.schema(context.schema).findAll({where: {activityId: parent.id, executionId: execution.id},
        order: [['position', 'ASC'], ['id', 'ASC']], transaction, raw: true});
    const checklist = items.map(item => ({id: item.id, text: item.text, position: String(item.position), checked: item.checked,
        checkedByUserId: item.checkedByUserId, checkedAt: item.checkedAt, createdByUserId: item.createdByUserId}));
    const outcome = execution.archivedAt ? 'archived' : recurrenceOutcome(execution.status, execution.reviewStatus,
        checklist.filter(item => item.checked).length, checklist.length);
    const deadlineSnapshot = {...executionState(execution), archivedAt: execution.archivedAt,
        archivedByUserId: execution.archivedByUserId, assigneeIds: execution.assigneeIds, checklist,
        occurrenceDate: execution.occurrenceDate, outcome, capturedAt: now.toISOString()};
    await execution.update({closedAt: deadline, deadlineSnapshot, version: execution.version + 1}, {transaction});
    await history(context, parent.id, execution.id, 'EXECUTION_CLOSED', {occurrenceDate: execution.occurrenceDate,
        closedAt: deadline.toISOString(), outcome}, transaction);
    if (parent.currentExecutionId === execution.id) await cancelCurrentAlert(context, parent, transaction);
    return true;
}

async function cancelCurrentAlert(context: ActivityRecurrenceContext, parent: Activity, transaction: Transaction): Promise<void> {
    const alert = await ActivityAlert.schema(context.schema).findOne({where: {activityId: parent.id}, transaction});
    if (!alert?.enabled) return;
    await alert.update({enabled: false, scheduleVersion: alert.scheduleVersion + 1}, {transaction});
    await cancelActivityDeliveries(context.schema, alert.id, transaction);
    await history(context, parent.id, alert.executionId ?? parent.currentExecutionId, 'ALERT_CANCELLED', {reason: 'EXECUTION_FINISHED'}, transaction);
}

async function replaceAssignments(context: ActivityRecurrenceContext, parent: Activity, ids: string[], transaction: Transaction): Promise<void> {
    await ActivityAssignment.schema(context.schema).destroy({where: {activityId: parent.id}, transaction});
    if (ids.length) await ActivityAssignment.schema(context.schema).bulkCreate(ids.map(userId => ({activityId: parent.id, userId,
        assignedByUserId: context.userId ?? parent.createdByUserId})), {transaction});
}

async function eligibleIds(context: ActivityRecurrenceContext, transaction: Transaction): Promise<Set<string>> {
    const [memberships, structures] = await Promise.all([
        TenantUser.findAll({where: {tenantId: context.tenantId, deactivatedAt: null}, transaction}),
        StructureUser.findAll({where: {structureId: context.structureId}, transaction})
    ]);
    const roles = new Map(memberships.map(row => [row.userId, row.role]));
    const ids = structures.filter(row => isEligibleActivityRole(resolveEffectiveRole(roles.get(row.userId), row.role)))
        .filter(row => roles.has(row.userId)).map(row => row.userId);
    const people = ids.length ? await User.findAll({where: {id: {[Op.in]: ids}, deactivatedAt: null}, attributes: ['id'], transaction}) : [];
    return new Set(people.map(row => row.id));
}

async function validateRecurringTemplate(context: ActivityRecurrenceContext, parent: Activity, state: ActivityRecurrenceState,
    transaction: Transaction): Promise<ActivityRecurrenceState> {
    const eligible = await eligibleIds(context, transaction);
    const assigned = state.template.assigneeIds.filter(id => eligible.has(id));
    let reason: string | null = null;
    if (state.template.assigneeIds.length && !assigned.length) reason = 'ASSIGNEE_UNAVAILABLE';
    if (state.template.reviewerUserId && !eligible.has(state.template.reviewerUserId)) reason = 'REVIEWER_UNAVAILABLE';
    if (state.template.reviewerUserId && assigned.includes(state.template.reviewerUserId)) reason = 'REVIEWER_CONFLICT';
    if (state.template.patientId && !await Patient.schema(context.schema).findOne({where: {id: state.template.patientId,
        tenantId: context.tenantId, structureId: context.structureId, archivedAt: null}, attributes: ['id'], transaction})) reason = 'LINK_UNAVAILABLE';
    if (state.template.agendaEventId && !await AgendaEvent.schema(context.schema).findOne({where: {id: state.template.agendaEventId,
        structureId: context.structureId}, attributes: ['id'], transaction})) reason = 'LINK_UNAVAILABLE';
    const next = {...state, blockedReason: reason, template: {...state.template, assigneeIds: reason ? state.template.assigneeIds : assigned}};
    if (reason || assigned.length !== state.template.assigneeIds.length) {
        await parent.update({recurrence: next, version: parent.version + 1}, {transaction});
        await history(context, parent.id, null, reason ? 'RECURRENCE_BLOCKED' : 'RECURRENCE_ASSIGNMENTS_UPDATED',
            reason ? {reason} : {assigneeIds: assigned}, transaction);
    }
    return next;
}

async function endPosition(context: ActivityRecurrenceContext, board: ActivityBoard, parent: Activity, transaction: Transaction): Promise<string> {
    const rows = await Activity.schema(context.schema).findAll({where: {boardId: board.id, status: 'TODO', archivedAt: null,
        id: {[Op.ne]: parent.id}}, order: [['position', 'ASC'], ['id', 'ASC']], transaction});
    const maximum = rows.length ? BigInt(rows[rows.length - 1].position) : 0n;
    if (maximum + 1024n <= 2n ** 63n - 1n) return (maximum + 1024n).toString();
    // Compact exactly like ordinary board moves; temporary ranks avoid the immediate uniqueness constraint.
    let rank = -(2n ** 63n);
    const occupied = new Set(rows.map(row => String(row.position)).concat(String(parent.position)));
    for (const row of rows) {
        while (occupied.has(rank.toString())) rank++;
        const position = rank.toString(); occupied.add(position);
        await row.update({position}, {transaction, silent: true}); rank++;
    }
    for (let index = 0; index < rows.length; index++) await rows[index].update({position: String((index + 1) * 1024)}, {transaction, silent: true});
    return String((rows.length + 1) * 1024);
}

async function startExecution(context: ActivityRecurrenceContext, board: ActivityBoard, parent: Activity,
    state: ActivityRecurrenceState, date: string, transaction: Transaction, now: Date): Promise<ActivityExecution> {
    const scoped = ActivityExecution.schema(context.schema);
    let execution = await scoped.findOne({where: {activityId: parent.id, occurrenceDate: date}, transaction});
    if (!execution) {
        const template = state.template;
        execution = await scoped.create({id: randomUUID(), activityId: parent.id, occurrenceDate: date, boardId: board.id,
            title: template.title, description: template.description, priority: template.priority,
            status: 'TODO', position: await endPosition(context, board, parent, transaction), version: 1,
            checklistRevision: template.checklist.length ? 1 : 0, reviewerUserId: template.reviewerUserId,
            reviewStatus: 'not_requested', reviewApprovedByUserId: null, reviewApprovedAt: null,
            dueKind: 'allDay', dueDate: date, dueAt: null, dueTimezone: context.timezone,
            createdByUserId: parent.createdByUserId, updatedByUserId: null, patientId: template.patientId,
            agendaEventId: template.agendaEventId, assigneeIds: template.assigneeIds,
            completedAt: null, completedByUserId: null, archivedAt: null, archivedByUserId: null, reassignmentRequired: false,
            closedAt: null, deadlineSnapshot: null, lateUpdatedAt: null, lateUpdatedByUserId: null}, {transaction});
        const unscoped = !parent.currentExecutionId ? await ActivityChecklistItem.schema(context.schema).findAll({
            where: {activityId: parent.id, executionId: null}, order: [['position', 'ASC'], ['id', 'ASC']], transaction}) : [];
        const reusable = unscoped.length === template.checklist.length && unscoped.every((item, index) => !item.checked && item.text === template.checklist[index].text);
        if (reusable && unscoped.length) {
            await ActivityChecklistItem.schema(context.schema).update({executionId: execution.id}, {where: {activityId: parent.id, executionId: null}, transaction});
        } else {
            // Null-scope checklist rows belong only to the not-yet-started template of a newly created routine.
            if (unscoped.length) await ActivityChecklistItem.schema(context.schema).destroy({where: {activityId: parent.id, executionId: null}, transaction});
            if (template.checklist.length) await ActivityChecklistItem.schema(context.schema).bulkCreate(template.checklist.map((item, index) => ({
                activityId: parent.id, executionId: execution!.id, text: item.text, position: String((index + 1) * 1024),
                checked: false, version: 1, createdByUserId: parent.createdByUserId})), {transaction});
        }
        await history(context, parent.id, execution.id, 'EXECUTION_STARTED', {occurrenceDate: date,
            recovered: date < recurrenceLocalDate(now, context.timezone)}, transaction);
    }
    await parent.update({...executionState(execution), currentExecutionId: execution.id, version: parent.version + 1}, {transaction});
    await replaceAssignments(context, parent, execution.assigneeIds, transaction);
    await sealActivityExecution(context, parent, execution, transaction, now);
    return execution;
}

/** Caller owns tenant gate then board lock. A bounded recovery advances the persisted cursor without skipping dates. */
export async function synchronizeActivityRecurrence(context: ActivityRecurrenceContext, board: ActivityBoard,
    parent: Activity, transaction: Transaction, now = new Date()): Promise<void> {
    if (!parent.recurrence) return;
    let changed = false, orderChanged = false;
    if (parent.currentExecutionId) {
        const execution = await ActivityExecution.schema(context.schema).findOne({where: {id: parent.currentExecutionId, activityId: parent.id}, transaction});
        if (execution) changed = await sealActivityExecution(context, parent, execution, transaction, now);
    }
    let state = parent.recurrence;
    const today = recurrenceLocalDate(now, context.timezone);
    if (!parent.archivedAt && state.status === 'active' && !state.blockedReason && state.nextDate && state.nextDate <= today) {
        const prior = json(state);
        state = await validateRecurringTemplate(context, parent, state, transaction);
        if (json(state) !== prior) changed = true;
        if (!state.blockedReason) {
            let next = state.nextDate;
            for (let count = 0; next && next <= today && count < MAX_RECOVERY_BATCH; count++) {
                await cancelCurrentAlert(context, parent, transaction);
                await startExecution(context, board, parent, state, next, transaction, now);
                next = nextRecurrenceDate(state, next);
                changed = true; orderChanged = true;
            }
            state = {...state, nextDate: next, status: next ? 'active' : 'ended'};
            await parent.update({recurrence: state}, {transaction});
        }
    }
    if (changed) await board.update({snapshotRevision: board.snapshotRevision + 1,
        orderRevision: board.orderRevision + (orderChanged ? 1 : 0)}, {transaction});
}

/** New routines begin today or later; editing a started routine affects dates after today only. */
export async function configureActivityRecurrence(parent: Activity, input: ActivityRecurrenceRule, template: ActivityRecurrenceTemplate,
    board: ActivityBoard, context: ActivityRecurrenceContext, transaction: Transaction, now = new Date()): Promise<void> {
    const rule = parseActivityRecurrenceRule(input);
    const today = recurrenceLocalDate(now, context.timezone);
    if (!parent.recurrence && rule.startsOn < today) throw new ActivityError('ACTIVITY_VALIDATION_FAILED', 422,
        'La prima esecuzione deve essere oggi o in futuro.', {'recurrence.startsOn': 'Scegli oggi o un giorno futuro.'});
    if (parent.recurrence) await synchronizeActivityRecurrence(context, board, parent, transaction, now);
    const first = parent.currentExecutionId ? recurrenceDateOnOrAfter(rule, addRecurrenceDays(today, 1))
        : recurrenceDateOnOrAfter(rule, today);
    const recurrence: ActivityRecurrenceState = {...rule, status: first ? 'active' : 'ended', nextDate: first,
        blockedReason: null, template: structuredClone(template)};
    await parent.update({recurrence, version: parent.version + 1}, {transaction});
    await synchronizeActivityRecurrence(context, board, parent, transaction, now);
}

export async function stopActivityRecurrence(parent: Activity, transaction: Transaction): Promise<void> {
    if (!parent.recurrence) return;
    await parent.update({recurrence: {...parent.recurrence, status: 'stopped', nextDate: null}}, {transaction});
}

export async function sweepActivityRecurrences(options: {tenantIds?: string[]; clock?: () => Date} = {}): Promise<void> {
    const clock = options.clock ?? (() => new Date());
    const tenants = await Tenant.findAll({where: options.tenantIds ? {id: options.tenantIds} : {}, attributes: ['id']});
    for (const tenant of tenants) {
        const schema = getTenantSchemaName(tenant.id);
        try {
            const rows = await Activity.schema(schema).findAll({where: {recurrence: {[Op.ne]: null}}, attributes: ['boardId'], raw: true});
            for (const boardId of new Set(rows.map(row => row.boardId))) {
                await sequelize.transaction(async transaction => {
                    await acquireTenantActivityGate(tenant.id, transaction, 'shared');
                    const board = await ActivityBoard.schema(schema).findByPk(boardId, {transaction, lock: transaction.LOCK.UPDATE});
                    if (!board) return;
                    const context: ActivityRecurrenceContext = {tenantId: tenant.id, schema, structureId: board.structureId, timezone: board.timezone};
                    const activities = await Activity.schema(schema).findAll({where: {boardId, recurrence: {[Op.ne]: null}}, transaction});
                    for (const parent of activities) await synchronizeActivityRecurrence(context, board, parent, transaction, clock());
                });
            }
        } catch (error) {
            console.warn('[activities-recurrence]', {tenantId: tenant.id, code: (error as any)?.original?.code ?? (error as any)?.code ?? 'SWEEP_FAILED'});
        }
    }
}

let sweepRunning = false;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
export function startActivityRecurrenceSweep(): void {
    if (sweepTimer || process.env.BACKGROUND_JOBS_ENABLED === 'false') return;
    const run = async () => {
        if (sweepRunning) return;
        sweepRunning = true;
        try {await sweepActivityRecurrences();}
        catch (error) {console.warn('[activities-recurrence]', {code: (error as any)?.original?.code ?? (error as any)?.code ?? 'SWEEP_FAILED'});}
        finally {sweepRunning = false;}
    };
    void run();
    sweepTimer = setInterval(() => void run(), 60_000);
    sweepTimer.unref();
}
