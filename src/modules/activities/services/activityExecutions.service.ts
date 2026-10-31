import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import type {Request} from 'express';
import {literal, Op, Transaction, type WhereOptions} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {env} from '../../../config/env.js';
import type {ActivityContext, ActivityUserSummary} from '../activities.types.js';
import type {ActivityExecution} from '../models/index.js';
import {ActivityError} from '../utils/activityErrors.js';
import {parseActivityCivilDate, parseActivityId} from '../utils/activityValidation.js';
import {resolveActivityContext, visibleActivityLinks} from './activityAccess.service.js';
import {activityInBoard, currentBoard, models, requireAccess} from './activityPersistence.service.js';
import {recurrenceOutcome} from '../utils/activityRecurrence.policy.js';
import {activityUserSummaries} from '../utils/activityChildSerialization.js';

const outcomes = ['completed', 'pending_review', 'partial', 'not_recorded', 'archived'];
const iso = (value: Date | string | null | undefined) => value ? new Date(value).toISOString() : null;

export async function serializeExecutionSummary(context: ActivityContext, execution: ActivityExecution, transaction: Transaction,
    batch?: {checklist: Array<{checked: boolean}>; people: Map<string, ActivityUserSummary>}) {
    const items = batch?.checklist ?? await models(context).checklist.findAll({where: {activityId: execution.activityId, executionId: execution.id},
        attributes: ['checked'], transaction, raw: true});
    const people = batch?.people ?? await activityUserSummaries(context, [execution.lateUpdatedByUserId], transaction);
    const snapshot = execution.deadlineSnapshot ? structuredClone(execution.deadlineSnapshot) : null;
    if (snapshot) {
        const links = await visibleActivityLinks(context, snapshot as any, transaction);
        snapshot.patientId = links.patientId; snapshot.agendaEventId = links.agendaEventId;
        // Comment bodies remain in their canonical, deletable records.
        delete snapshot.comments;
    }
    return {
        id: execution.id, activityId: execution.activityId, date: execution.occurrenceDate,
        status: execution.status, reviewStatus: execution.reviewStatus, version: execution.version,
        checklistRevision: execution.checklistRevision,
        checklistProgress: {total: items.length, checked: items.filter(item => item.checked).length},
        completedAt: iso(execution.completedAt), completedByUserId: execution.completedByUserId,
        archivedAt: iso(execution.archivedAt), closedAt: iso(execution.closedAt),
        deadlineSnapshot: snapshot, lateUpdatedAt: iso(execution.lateUpdatedAt), lateUpdatedByUserId: execution.lateUpdatedByUserId,
        lateUpdatedBy: people.get(execution.lateUpdatedByUserId ?? '') ?? null,
        outcome: execution.archivedAt ? 'archived' : recurrenceOutcome(execution.status, execution.reviewStatus, items.filter(item => item.checked).length, items.length),
        outcomeAtDeadline: snapshot?.outcome ?? null
    };
}

/** Filters identify the execution day, so a correction recorded later stays with its day. */
export async function getActivityExecutions(req: Request, activityId: string) {
    parseActivityId(activityId, 'activityId');
    const permitted = new Set(['from', 'to', 'outcome', 'outcomeBasis', 'eventType', 'cursor', 'limit']);
    if (Object.keys(req.query).some(key => !permitted.has(key))) throw new ActivityError('ACTIVITY_VALIDATION_FAILED', 422, 'Controlla i filtri della cronologia.');
    const string = (name: string) => {
        const value = req.query[name];
        if (value == null || value === '') return null;
        if (typeof value !== 'string') throw new ActivityError('ACTIVITY_VALIDATION_FAILED', 422, 'Controlla i filtri della cronologia.');
        return value;
    };
    const from = string('from') ? parseActivityCivilDate(string('from'), 'from') : null;
    const to = string('to') ? parseActivityCivilDate(string('to'), 'to') : null;
    const outcome = string('outcome'), outcomeBasis = string('outcomeBasis') ?? 'current', eventType = string('eventType');
    const rawLimit = string('limit') ?? '20', limit = Number(rawLimit);
    if ((from && to && from > to) || !/^\d+$/.test(rawLimit) || limit < 1 || limit > 100
        || (outcome && !outcomes.includes(outcome)) || !['current', 'deadline'].includes(outcomeBasis)
        || (eventType && !/^[A-Za-z_]{1,64}$/.test(eventType))) {
        throw new ActivityError('ACTIVITY_VALIDATION_FAILED', 422, 'Controlla il periodo e i filtri della cronologia.');
    }
    return sequelize.transaction({isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ, readOnly: true}, async transaction => {
        const context = await resolveActivityContext(req, transaction); requireAccess(context, 'read');
        const board = await currentBoard(context, transaction);
        await activityInBoard(context, board.id, activityId, transaction);
        const key = createHash('sha256').update(JSON.stringify({board: board.id, actor: context.userId, activityId,
            from, to, outcome, outcomeBasis, eventType})).digest('hex');
        const cursor = string('cursor') ? decodeCursor(string('cursor')!, key, board.snapshotRevision) : null;
        const clauses: WhereOptions[] = [{activityId}];
        if (from) clauses.push({occurrenceDate: {[Op.gte]: from}});
        if (to) clauses.push({occurrenceDate: {[Op.lte]: to}});
        const schema = '"' + context.schema + '"';
        if (outcome) {
            const currentOutcome = `CASE WHEN "activityExecution"."archivedAt" IS NOT NULL THEN 'archived' WHEN "activityExecution"."status" = 'COMPLETED' THEN 'completed' WHEN "activityExecution"."reviewStatus" = 'pending' THEN 'pending_review' WHEN "activityExecution"."status" IN ('IN_PROGRESS', 'WAITING') OR EXISTS (SELECT 1 FROM ${schema}."activity_checklist_items" i WHERE i."executionId" = "activityExecution".id AND i.checked) THEN 'partial' ELSE 'not_recorded' END`;
            clauses.push(literal(`(${outcomeBasis === 'deadline' ? '"activityExecution"."deadlineSnapshot"->>\'outcome\'' : currentOutcome}) = ${sequelize.escape(outcome)}`));
        }
        if (eventType) {
            const categories: Record<string, string> = {checklist: 'CHECKLIST_', comments: 'COMMENT_', review: 'REVIEW_'};
            const prefix = categories[eventType];
            const predicate = prefix ? `h."eventType" LIKE ${sequelize.escape(prefix.replaceAll('_', '\\_') + '%')}`
                : eventType === 'status' ? `h."eventType" IN ('COMPLETED','REOPENED','STATUS_CHANGED','EXECUTION_STARTED','EXECUTION_CLOSED')`
                    : `h."eventType" = ${sequelize.escape(eventType)}`;
            clauses.push(literal(`EXISTS (SELECT 1 FROM ${schema}."activity_history" h WHERE h."executionId" = "activityExecution".id AND ${predicate})`));
        }
        const where = {[Op.and]: clauses};
        const pageWhere = cursor ? {[Op.and]: [where, {[Op.or]: [{occurrenceDate: {[Op.lt]: cursor.date}},
            {occurrenceDate: cursor.date, id: {[Op.lt]: cursor.id}}]}]} : where;
        const scoped = models(context);
        const [total, rows] = await Promise.all([
            scoped.execution.count({where, transaction}),
            scoped.execution.findAll({where: pageWhere, order: [['occurrenceDate', 'DESC'], ['id', 'DESC']], limit: limit + 1, transaction})
        ]);
        const selected = rows.slice(0, limit);
        const [checklist, people] = await Promise.all([
            selected.length ? scoped.checklist.findAll({where: {executionId: {[Op.in]: selected.map(row => row.id)}},
                attributes: ['executionId', 'checked'], transaction, raw: true}) : [],
            activityUserSummaries(context, selected.map(row => row.lateUpdatedByUserId), transaction)
        ]);
        const items = await Promise.all(selected.map(row => serializeExecutionSummary(context, row, transaction,
            {checklist: checklist.filter(item => item.executionId === row.id), people})));
        const last = selected[selected.length - 1];
        return {items, total, nextCursor: rows.length > limit ? encodeCursor({key, revision: board.snapshotRevision,
            date: last.occurrenceDate, id: last.id, issuedAt: Date.now()}) : null, snapshotRevision: board.snapshotRevision};
    });
}

interface ExecutionCursor {key: string; revision: number; date: string; id: string; issuedAt: number;}
function encodeCursor(value: ExecutionCursor): string {
    const token = Buffer.from(JSON.stringify(value)).toString('base64url');
    return token + '.' + createHmac('sha256', env.jwtSecret).update('activity-executions:' + token).digest('base64url');
}
function decodeCursor(value: string, key: string, revision: number): ExecutionCursor {
    try {
        const [token, signature, extra] = value.split('.');
        if (!token || !signature || extra || value.length > 4096) throw new Error();
        const wanted = createHmac('sha256', env.jwtSecret).update('activity-executions:' + token).digest();
        const actual = Buffer.from(signature, 'base64url');
        if (wanted.length !== actual.length || !timingSafeEqual(wanted, actual)) throw new Error();
        const decoded = JSON.parse(Buffer.from(token, 'base64url').toString()) as ExecutionCursor;
        if (decoded.key !== key || decoded.revision !== revision || !Number.isFinite(decoded.issuedAt)
            || Date.now() - decoded.issuedAt > 600_000 || decoded.issuedAt > Date.now()) throw new Error();
        parseActivityCivilDate(decoded.date); parseActivityId(decoded.id);
        return decoded;
    } catch {throw new ActivityError('ACTIVITY_CURSOR_EXPIRED', 409, 'La cronologia è cambiata. Ricarica le giornate prima di continuare.');}
}
