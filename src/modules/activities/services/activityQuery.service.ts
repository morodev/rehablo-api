import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {Request} from 'express';
import {literal, Op, Transaction, WhereOptions} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {env} from '../../../config/env.js';
import {ACTIVITY_STATUSES, ActivityContext, ActivityQuery, ActivityStatus} from '../activities.types.js';
import {Activity, ActivityBoard} from '../models/index.js';
import {ActivityError} from '../utils/activityErrors.js';
import {effectiveDueAt} from '../utils/activityValidation.js';
import {requireActivityLinks, resolveActivityContext} from './activityAccess.service.js';
import {currentBoard, models, requireAccess, serializeActivities, serializeBoard} from './activityPersistence.service.js';

interface Cursor {
    version: 1;
    boardId: string;
    queryKey: string;
    snapshotRevision: number;
    evaluationAt: string;
    kind: 'board' | 'list' | 'archived' | 'recurring';
    status: ActivityStatus;
    position: string;
    id: string;
    archivedAt: string | null;
}

const CURSOR_LIFETIME = 10 * 60_000;
const statusOrder = literal(`CASE "activity"."status" WHEN 'TODO' THEN 0 WHEN 'IN_PROGRESS' THEN 1 WHEN 'WAITING' THEN 2 ELSE 3 END`);

export async function queryActivities(req: Request, query: ActivityQuery) {
    return sequelize.transaction({isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ, readOnly: true}, async transaction => {
        const context = await resolveActivityContext(req, transaction);
        requireAccess(context, 'read');
        const board = await currentBoard(context, transaction);
        if (query.patientId || query.agendaEventId) await requireActivityLinks(context, {patientId: query.patientId, agendaEventId: query.agendaEventId}, transaction);
        const queryKey = createHash('sha256').update(JSON.stringify({
            boardId: board.id, actorId: context.userId, view: query.view, search: query.search,
            mine: query.mine, statuses: [...query.statuses].sort(), priority: query.priority,
            assigneeId: query.assigneeId, due: query.due, unassigned: query.unassigned,
            reassignmentRequired: query.reassignmentRequired, patientId: query.patientId, agendaEventId: query.agendaEventId ?? null,
            includeAllCompleted: query.includeAllCompleted
        })).digest('hex');
        const cursors = query.view === 'board'
            ? Object.entries(query.cursors).map(([status, cursor]) => decodeCursor(cursor!, context, board, queryKey, 'board', status as ActivityStatus))
            : query.cursor ? [decodeCursor(query.cursor, context, board, queryKey, query.view)] : [];
        const evaluationAt = cursors.length ? new Date(cursors[0].evaluationAt) : new Date();
        if (cursors.some(cursor => cursor.evaluationAt !== evaluationAt.toISOString())) throw cursorExpired();
        const metadata = {view: query.view, board: serializeBoard(board.get({plain: true})),
            orderRevision: board.get('orderRevision'), snapshotRevision: board.get('snapshotRevision'),
            queryKey, evaluationAt: evaluationAt.toISOString(), serverNow: new Date().toISOString()};
        const baseWhere = filterWhere(context, board.id, query, evaluationAt);
        const scoped = models(context);
        if (query.view === 'board') {
            const windows = await Promise.all(ACTIVITY_STATUSES.map(async status => {
                const cursor = cursors.find(item => item.status === status);
                const limit = query.limits[status] ?? query.limit;
                const where = and(baseWhere, {status});
                const rows = await scoped.activity.findAll({where: cursor ? and(where, positionAfter(cursor)) : where,
                    order: [['position', 'ASC'], ['id', 'ASC']], limit: limit + 1, transaction});
                const total = await scoped.activity.count({where, transaction});
                return {status, total, rows: rows.slice(0, limit), hasMore: rows.length > limit};
            }));
            const allRows = windows.flatMap(window => window.rows);
            const serialized = await serializeActivities(context, allRows, transaction, evaluationAt);
            const byId = new Map(serialized.map(item => [item.id, item]));
            return {...metadata, columns: windows.map(window => ({
                status: window.status, total: window.total, items: window.rows.map(row => byId.get(row.id)!),
                nextCursor: window.hasMore ? encodeCursor(board, queryKey, evaluationAt, 'board', window.rows[window.rows.length - 1]) : null
            }))};
        }
        const cursor = cursors[0];
        const order: any = query.view === 'archived'
            ? [['archivedAt', 'DESC'], ['id', 'DESC']]
            : [[statusOrder, 'ASC'], ['position', 'ASC'], ['id', 'ASC']];
        const rows = await scoped.activity.findAll({where: cursor ? and(baseWhere,
            query.view === 'archived' ? archivedAfter(cursor) : listAfter(cursor)) : baseWhere,
            order, limit: query.limit + 1, transaction});
        const total = await scoped.activity.count({where: baseWhere, transaction});
        const page = rows.slice(0, query.limit);
        return {...metadata, total, items: await serializeActivities(context, page, transaction, evaluationAt),
            nextCursor: rows.length > query.limit ? encodeCursor(board, queryKey, evaluationAt, query.view, page[page.length - 1]) : null};
    });
}

function filterWhere(context: ActivityContext, boardId: string, query: ActivityQuery, evaluationAt: Date): WhereOptions {
    const recurring = query.view === 'recurring';
    const template = '"activity"."recurrence"->\'template\'';
    const clauses: WhereOptions[] = [{boardId, archivedAt: query.view === 'archived' ? {[Op.ne]: null} : null}];
    if (query.view === 'recurring') clauses.push({recurrence: {[Op.ne]: null}});
    else if (query.view !== 'archived') clauses.push({[Op.or]: [{recurrence: null}, {currentExecutionId: {[Op.ne]: null}}]},
        literal('NOT EXISTS (SELECT 1 FROM "' + context.schema + '"."activity_executions" e WHERE e.id = "activity"."currentExecutionId" AND e."archivedAt" IS NOT NULL)'));
    if (query.statuses.length) clauses.push({status: {[Op.in]: query.statuses}});
    if (query.priority) clauses.push(recurring ? literal(`(${template}->>'priority') = ${sequelize.escape(query.priority)}`) : {priority: query.priority});
    if (query.search) {
        const search = '%' + query.search.replace(/[\\%_]/g, character => '\\' + character) + '%';
        clauses.push(recurring ? literal(`((${template}->>'title') ILIKE ${sequelize.escape(search)} OR (${template}->>'description') ILIKE ${sequelize.escape(search)})`)
            : {[Op.or]: [{title: {[Op.iLike]: search}}, {description: {[Op.iLike]: search}}]});
    }
    if (query.patientId) clauses.push(recurring ? literal(`(${template}->>'patientId') = ${sequelize.escape(query.patientId)}`) : {patientId: query.patientId});
    if (query.agendaEventId) clauses.push(recurring ? literal(`(${template}->>'agendaEventId') = ${sequelize.escape(query.agendaEventId)}`) : {agendaEventId: query.agendaEventId});
    if (query.reassignmentRequired) clauses.push({reassignmentRequired: true});
    const schema = '"' + context.schema + '"';
    const assigned = (userId: string) => recurring
        ? literal(`(${template}->'assigneeIds') @> ${sequelize.escape(JSON.stringify([userId]))}::jsonb`)
        : literal(`EXISTS (SELECT 1 FROM ${schema}."activity_assignments" AS assigned WHERE assigned."activityId" = "activity"."id" AND assigned."userId" = ${sequelize.escape(userId)})`);
    if (query.mine) clauses.push(assigned(context.userId));
    if (query.assigneeId) clauses.push(assigned(query.assigneeId));
    if (query.unassigned) clauses.push(recurring ? literal(`jsonb_array_length(${template}->'assigneeIds') = 0`)
        : literal(`NOT EXISTS (SELECT 1 FROM ${schema}."activity_assignments" AS assigned WHERE assigned."activityId" = "activity"."id")`));
    const today = localDate(evaluationAt, context.timezone);
    if (query.due === 'none') clauses.push({dueKind: null});
    if (query.due === 'overdue') clauses.push({archivedAt: null, status: {[Op.ne]: 'COMPLETED'}, [Op.or]: [
        {dueKind: 'timed', dueAt: {[Op.lt]: evaluationAt}}, {dueKind: 'allDay', dueDate: {[Op.lt]: today}}
    ]});
    if (query.due === 'today') {
        const end = effectiveDueAt({kind: 'allDay', date: today, timezone: context.timezone})!;
        const start = new Date(effectiveDueAt({kind: 'allDay', date: offsetDate(today, -1), timezone: context.timezone})!.getTime() + 1);
        clauses.push({[Op.or]: [{dueKind: 'timed', dueAt: {[Op.gte]: start, [Op.lte]: end}}, {dueKind: 'allDay', dueDate: today}]});
    }
    if (query.due === 'todayOrOverdue') {
        const end = effectiveDueAt({kind: 'allDay', date: today, timezone: context.timezone})!;
        clauses.push({archivedAt: null, status: {[Op.ne]: 'COMPLETED'}, [Op.or]: [
            {dueKind: 'timed', dueAt: {[Op.lte]: end}}, {dueKind: 'allDay', dueDate: {[Op.lte]: today}}
        ]});
    }
    if (query.due === 'upcoming') clauses.push({[Op.or]: [
        {dueKind: 'timed', dueAt: {[Op.gte]: evaluationAt}}, {dueKind: 'allDay', dueDate: {[Op.gte]: today}}
    ]});
    if (query.view !== 'archived' && query.view !== 'recurring' && !query.includeAllCompleted) {
        const cutoffDay = offsetDate(today, -30);
        const cutoff = new Date(effectiveDueAt({kind: 'allDay', date: cutoffDay, timezone: context.timezone})!.getTime() + 1);
        clauses.push({[Op.or]: [{status: {[Op.ne]: 'COMPLETED'}}, {completedAt: {[Op.gte]: cutoff}},
            literal('(\"activity\".\"recurrence\"->>\'status\') = \'active\'')]});
    }
    return and(...clauses);
}

function and(...clauses: WhereOptions[]): WhereOptions { return {[Op.and]: clauses}; }

function positionAfter(cursor: Cursor): WhereOptions {
    return {[Op.or]: [{position: {[Op.gt]: cursor.position}}, {position: cursor.position, id: {[Op.gt]: cursor.id}}]};
}

function listAfter(cursor: Cursor): WhereOptions {
    const index = ACTIVITY_STATUSES.indexOf(cursor.status);
    return {[Op.or]: [{status: {[Op.in]: ACTIVITY_STATUSES.slice(index + 1)}}, and({status: cursor.status}, positionAfter(cursor))]};
}

function archivedAfter(cursor: Cursor): WhereOptions {
    return {[Op.or]: [{archivedAt: {[Op.lt]: cursor.archivedAt}}, {archivedAt: cursor.archivedAt, id: {[Op.lt]: cursor.id}}]};
}

function encodeCursor(board: ActivityBoard, queryKey: string, evaluationAt: Date, kind: Cursor['kind'], activity: Activity): string {
    const body: Cursor = {version: 1, boardId: board.id, queryKey, snapshotRevision: board.get('snapshotRevision'),
        evaluationAt: evaluationAt.toISOString(), kind, status: activity.status, position: String(activity.position),
        id: activity.id, archivedAt: activity.archivedAt?.toISOString() ?? null};
    const token = Buffer.from(JSON.stringify(body)).toString('base64url');
    const signature = createHmac('sha256', env.jwtSecret).update('activities-cursor:' + token).digest('base64url');
    return token + '.' + signature;
}

function decodeCursor(value: string, context: ActivityContext, board: ActivityBoard, queryKey: string, kind: Cursor['kind'], status?: ActivityStatus): Cursor {
    try {
        const [token, provided, extra] = value.split('.');
        if (!token || !provided || extra || value.length > 4096) throw cursorExpired();
        const signature = createHmac('sha256', env.jwtSecret).update('activities-cursor:' + token).digest();
        const supplied = Buffer.from(provided, 'base64url');
        if (supplied.length !== signature.length || !timingSafeEqual(signature, supplied)) throw cursorExpired();
        const cursor = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Cursor;
        const age = Date.now() - Date.parse(cursor.evaluationAt);
        if (cursor.version !== 1 || cursor.boardId !== board.id || cursor.queryKey !== queryKey
            || cursor.snapshotRevision !== board.snapshotRevision || cursor.kind !== kind
            || (status && cursor.status !== status) || !ACTIVITY_STATUSES.includes(cursor.status)
            || !/^-?\d{1,19}$/.test(cursor.position) || !/^[a-f0-9-]{36}$/i.test(cursor.id)
            || !Number.isFinite(age) || age < 0 || age > CURSOR_LIFETIME
            || (kind === 'archived' && !cursor.archivedAt)) throw cursorExpired();
        return cursor;
    } catch { throw cursorExpired(); }
}

function cursorExpired() {
    return new ActivityError('ACTIVITY_CURSOR_EXPIRED', 409, 'La bacheca è stata aggiornata. Ricarica le attività prima di continuare.');
}

function localDate(date: Date, timezone: string): string {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function offsetDate(date: string, days: number): string {
    const instant = new Date(date + 'T00:00:00.000Z');
    instant.setUTCDate(instant.getUTCDate() + days);
    return instant.toISOString().slice(0, 10);
}
