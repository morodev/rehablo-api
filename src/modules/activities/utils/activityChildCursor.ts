import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {env} from '../../../config/env.js';
import type {ActivityBoardRecord, ActivityContext} from '../activities.types.js';
import {ActivityError} from './activityErrors.js';

export type ActivityChildKind = 'comments' | 'history';
interface ChildCursor {
    version: 1; boardId: string; activityId: string; actorId: string; kind: ActivityChildKind;
    snapshotRevision: number; queryKey: string; evaluationAt: string; createdAt: string; id: string;
}
const lifetime = 10 * 60_000;
export function childQueryKey(context: ActivityContext, boardId: string, activityId: string, kind: ActivityChildKind): string {
    return createHash('sha256').update(JSON.stringify({actorId: context.userId, boardId, activityId, executionId: context.executionId ?? null, kind})).digest('hex');
}
export function childCursorExpired(): ActivityError {
    return new ActivityError('ACTIVITY_CURSOR_EXPIRED', 409, 'L’attività è stata aggiornata. Ricarica i commenti o la cronologia prima di continuare.');
}
export function encodeChildCursor(context: ActivityContext, board: ActivityBoardRecord, activityId: string,
    kind: ActivityChildKind, evaluationAt: string, last: {id: string; createdAt: Date | string}): string {
    const body: ChildCursor = {version: 1, boardId: board.id, activityId, actorId: context.userId, kind,
        snapshotRevision: board.snapshotRevision, queryKey: childQueryKey(context, board.id, activityId, kind),
        evaluationAt, createdAt: new Date(last.createdAt).toISOString(), id: last.id};
    const token = Buffer.from(JSON.stringify(body)).toString('base64url');
    return token + '.' + createHmac('sha256', env.jwtSecret).update('activities-child-cursor:' + token).digest('base64url');
}
export function decodeChildCursor(value: string, context: ActivityContext, board: ActivityBoardRecord,
    activityId: string, kind: ActivityChildKind, now = Date.now()): ChildCursor {
    try {
        const [token, provided, extra] = value.split('.');
        if (!token || !provided || extra || value.length > 4096) throw childCursorExpired();
        const wanted = createHmac('sha256', env.jwtSecret).update('activities-child-cursor:' + token).digest();
        const signature = Buffer.from(provided, 'base64url');
        if (signature.length !== wanted.length || !timingSafeEqual(wanted, signature)) throw childCursorExpired();
        const cursor = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as ChildCursor;
        const age = now - Date.parse(cursor.evaluationAt);
        if (cursor.version !== 1 || cursor.boardId !== board.id || cursor.activityId !== activityId
            || cursor.actorId !== context.userId || cursor.kind !== kind || cursor.snapshotRevision !== board.snapshotRevision
            || cursor.queryKey !== childQueryKey(context, board.id, activityId, kind)
            || !Number.isFinite(age) || age < 0 || age > lifetime
            || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(cursor.id)
            || !Number.isFinite(Date.parse(cursor.createdAt))) throw childCursorExpired();
        return cursor;
    } catch {throw childCursorExpired();}
}
