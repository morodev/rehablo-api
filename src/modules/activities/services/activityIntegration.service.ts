import type {Request} from 'express';
import {literal, Op, Transaction, type WhereOptions} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import type {ActivityLinksQuery, ActivityLinksResponse, ActivitySummaryQuery, ActivitySummaryResponse} from '../activities.types.js';
import {activityLocalDate, effectiveDueAt} from '../utils/activityValidation.js';
import {canCreateActivity, requireActivityLinks, resolveActivityContext, visibleActivityLinkMetadata} from './activityAccess.service.js';
import {currentBoard, models, requireAccess, serializeActivities, serializeBoard} from './activityPersistence.service.js';

/** Both counters and cards use one board snapshot and the same server clock. */
export async function queryActivitySummary(req: Request, query: ActivitySummaryQuery): Promise<ActivitySummaryResponse> {
    return sequelize.transaction({isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ, readOnly: true}, async transaction => {
        const context = await resolveActivityContext(req, transaction);
        requireAccess(context, 'read');
        const board = await currentBoard(context, transaction);
        const evaluationAt = new Date(), day = activityLocalDate(evaluationAt);
        const end = effectiveDueAt({kind: 'allDay', date: day, timezone: context.timezone})!;
        const clauses: WhereOptions[] = [{boardId: board.id, archivedAt: null, status: {[Op.ne]: 'COMPLETED'}},
            {[Op.or]: [{recurrence: null}, {currentExecutionId: {[Op.ne]: null}}]},
            literal('NOT EXISTS (SELECT 1 FROM "' + context.schema + '"."activity_executions" e WHERE e.id = "activity"."currentExecutionId" AND e."archivedAt" IS NOT NULL)')];
        if (query.mine) clauses.push(literal(`EXISTS (SELECT 1 FROM "${context.schema}"."activity_assignments" assigned WHERE assigned."activityId" = "activity"."id" AND assigned."userId" = ${sequelize.escape(context.userId)})`));
        const buckets: WhereOptions[] = [
            {[Op.or]: [{dueKind: 'timed', dueAt: {[Op.lt]: evaluationAt}}, {dueKind: 'allDay', dueDate: {[Op.lt]: day}}]},
            {[Op.or]: [{dueKind: 'timed', dueAt: {[Op.gte]: evaluationAt, [Op.lte]: end}}, {dueKind: 'allDay', dueDate: day}]}
        ];
        const deadline = literal(`CASE WHEN "activity"."dueKind" = 'timed' THEN "activity"."dueAt" ELSE (("activity"."dueDate"::date + 1)::timestamp AT TIME ZONE ${sequelize.escape(context.timezone)}) - interval '1 millisecond' END`);
        const priority = literal(`CASE "activity"."priority" WHEN 'URGENT' THEN 3 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 1 ELSE 0 END`);
        const windows = await Promise.all(buckets.map(async bucket => {
            const where = {[Op.and]: [...clauses, bucket]};
            const [total, rows] = await Promise.all([
                models(context).activity.count({where, transaction}),
                models(context).activity.findAll({where, order: [[deadline, 'ASC'], [priority, 'DESC'], ['id', 'ASC']], limit: query.limit, transaction})
            ]);
            return {total, items: await serializeActivities(context, rows, transaction, evaluationAt)};
        }));
        return {board: serializeBoard(board.get({plain: true})), evaluationAt: evaluationAt.toISOString(),
            serverNow: new Date().toISOString(), snapshotRevision: board.snapshotRevision,
            overdue: windows[0], today: windows[1]};
    });
}

/** URL prefill is checked independently against patient and appointment permissions. */
export async function queryActivityLinks(req: Request, query: ActivityLinksQuery): Promise<ActivityLinksResponse> {
    return sequelize.transaction({isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ, readOnly: true}, async transaction => {
        const context = await resolveActivityContext(req, transaction);
        requireAccess(context, 'read');
        const board = await currentBoard(context, transaction);
        await requireActivityLinks(context, query, transaction);
        const links = await visibleActivityLinkMetadata(context, query, transaction);
        return {...links, board: serializeBoard(board.get({plain: true})), capabilities: {canCreate: canCreateActivity(context)}};
    });
}
