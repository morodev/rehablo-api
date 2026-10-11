import {createHmac, timingSafeEqual} from 'node:crypto';
import type {Request} from 'express';
import {QueryTypes, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {env} from '../../../config/env.js';
import type {ActivityContext} from '../activities.types.js';
import {ActivityDelivery} from '../models/activityDelivery.model.js';
import {ActivityError} from '../utils/activityErrors.js';
import {resolveActivityContext} from './activityAccess.service.js';
import {currentBoard, requireAccess, writeOperation} from './activityPersistence.service.js';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
interface FeedCursor {version: 1; tenantId: string; structureId: string; userId: string; boardId: string; asOf: string; sentAt: string; id: string;}
interface FeedRow {id: string; activityId: string; title: string; scheduledAt: Date; sentAt: Date; readAt: Date | null; status: string; archived: boolean;}

function base(context: ActivityContext): string {
    // resolveActivityContext only produces validated UUID-derived schema names.
    const schema = '"' + context.schema + '"';
    return `FROM ${schema}.activity_deliveries d JOIN ${schema}.activity_alerts al ON al.id=d."alertId"
        JOIN ${schema}.activities a ON a.id=al."activityId"
        WHERE a."boardId"=:boardId AND d."recipientUserId"=:userId AND d.channel='inApp' AND d.status='SENT' AND d."sentAt" IS NOT NULL`;
}

async function counts(context: ActivityContext, boardId: string, transaction: Transaction) {
    const rows = await sequelize.query<{total: string; unreadCount: string}>(`SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE d."readAt" IS NULL) AS "unreadCount" ${base(context)}`,
        {type: QueryTypes.SELECT, replacements: {boardId, userId: context.userId}, transaction});
    return {total: Number(rows[0].total), unreadCount: Number(rows[0].unreadCount)};
}

export async function getActivityAlerts(req: Request) {
    if (Object.keys(req.query).some(key => !['limit', 'cursor'].includes(key))) throw invalid('Controlla i filtri degli avvisi.');
    const rawLimit = req.query.limit ?? '20';
    if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 50) throw invalid('Carica da 1 a 50 avvisi alla volta.');
    const limit = Number(rawLimit);
    if (req.query.cursor !== undefined && typeof req.query.cursor !== 'string') throw expired();
    return sequelize.transaction({isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ, readOnly: true}, async transaction => {
        const context = await resolveActivityContext(req, transaction); requireAccess(context, 'read');
        const board = await currentBoard(context, transaction);
        const cursor = req.query.cursor ? decode(req.query.cursor as string, context, board.id) : null;
        const asOf = cursor?.asOf ?? new Date().toISOString();
        const replacements = {boardId: board.id, userId: context.userId, asOf, sentAt: cursor?.sentAt, id: cursor?.id, limit: limit + 1};
        const rows = await sequelize.query<FeedRow>(`SELECT d.id, a.id AS "activityId", a.title,
            d."scheduledAt", d."sentAt", d."readAt", a.status, (a."archivedAt" IS NOT NULL) AS archived ${base(context)}
            AND d."sentAt"<=:asOf ${cursor ? 'AND (d."sentAt",d.id)<(:sentAt,:id)' : ''}
            ORDER BY d."sentAt" DESC,d.id DESC LIMIT :limit`, {type: QueryTypes.SELECT, replacements, transaction});
        const items = rows.slice(0, limit).map(row => ({...row, tenantId: context.tenantId, structureId: context.structureId}));
        const last = items[items.length - 1];
        return {...await counts(context, board.id, transaction), items, asOf,
            nextCursor: rows.length > limit ? encode({version: 1, tenantId: context.tenantId, structureId: context.structureId,
                userId: context.userId, boardId: board.id, asOf, sentAt: new Date(last.sentAt).toISOString(), id: last.id}) : null};
    });
}

export async function readActivityAlert(req: Request, deliveryId: string) {
    if (!UUID.test(deliveryId) || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)
        || Object.keys(req.body).some(key => key !== 'operationId') || typeof req.body.operationId !== 'string' || !UUID.test(req.body.operationId)) {
        throw invalid('Non siamo riusciti a identificare l’avviso. Ricarica gli avvisi e riprova.');
    }
    const input = {operationId: req.body.operationId.toLowerCase(), deliveryId: deliveryId.toLowerCase()};
    const load = async (context: ActivityContext, boardId: string, transaction: Transaction) => {
        const rows = await sequelize.query<{id: string; readAt: Date | null}>(`SELECT d.id,d."readAt" ${base(context)} AND d.id=:id FOR UPDATE OF d`,
            {type: QueryTypes.SELECT, replacements: {boardId, userId: context.userId, id: input.deliveryId}, transaction});
        if (!rows.length) throw new ActivityError('ACTIVITY_NOT_FOUND', 404, 'Questo avviso non è più disponibile nella sede selezionata.');
        return rows[0];
    };
    return writeOperation(req, input, 'alert-read:' + input.deliveryId, async (context, board, transaction) => {
        const row = await load(context, board.id, transaction);
        const readAt = row.readAt ?? new Date();
        if (!row.readAt) await ActivityDelivery.schema(context.schema).update({readAt}, {where: {id: row.id}, transaction});
        return {id: row.id, readAt: new Date(readAt).toISOString(), unreadCount: (await counts(context, board.id, transaction)).unreadCount};
    }, {receipt: data => ({id: data.id, readAt: data.readAt}), replay: async (context, board, _receipt, transaction) => {
        const row = await load(context, board.id, transaction);
        return {id: row.id, readAt: new Date(row.readAt!).toISOString(), unreadCount: (await counts(context, board.id, transaction)).unreadCount};
    }});
}

function encode(cursor: FeedCursor): string {
    const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return body + '.' + createHmac('sha256', env.jwtSecret).update('activities-alerts:' + body).digest('base64url');
}
function decode(value: string, context: ActivityContext, boardId: string): FeedCursor {
    try {
        const [body, signature, extra] = value.split('.');
        if (!body || !signature || extra || value.length > 4096) throw expired();
        const expected = createHmac('sha256', env.jwtSecret).update('activities-alerts:' + body).digest();
        const received = Buffer.from(signature, 'base64url');
        if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw expired();
        const cursor = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as FeedCursor;
        const age = Date.now() - Date.parse(cursor.asOf);
        if (cursor.version !== 1 || cursor.tenantId !== context.tenantId || cursor.structureId !== context.structureId
            || cursor.userId !== context.userId || cursor.boardId !== boardId || !UUID.test(cursor.id)
            || !Number.isFinite(age) || age < 0 || age > 10 * 60_000 || !Number.isFinite(Date.parse(cursor.sentAt))
            || Date.parse(cursor.sentAt) > Date.parse(cursor.asOf)) throw expired();
        return cursor;
    } catch {throw expired();}
}
function expired() {return new ActivityError('ACTIVITY_CURSOR_EXPIRED', 409, 'Gli avvisi sono stati aggiornati. Ricaricali prima di continuare.');}
function invalid(message: string) {return new ActivityError('ACTIVITY_VALIDATION_FAILED', 422, message);}
