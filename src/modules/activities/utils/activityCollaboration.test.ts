import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import type {ActivityBoardRecord, ActivityContext} from '../activities.types.js';
import {ActivityError} from './activityErrors.js';
import {decodeChildCursor, encodeChildCursor} from './activityChildCursor.js';
import {
    parseActivityChildPageQuery, parseChecklistCreateInput, parseChecklistDeleteInput, parseChecklistMoveInput,
    parseChecklistPatchInput, parseCommentCreateInput, parseCommentDeleteInput, parseCommentPatchInput
} from './activityValidation.js';

const invalid = (callback: () => unknown) => assert.throws(callback, (error: unknown) =>
    error instanceof ActivityError && error.code === 'ACTIVITY_VALIDATION_FAILED' && error.statusCode === 422);

test('checklist create requires aggregate revision, trims text and defaults to end', () => {
    const operationId = randomUUID();
    assert.deepEqual(parseChecklistCreateInput({operationId, expectedChecklistRevision: 0, text: '  Primo passo  '}),
        {operationId, expectedChecklistRevision: 0, text: 'Primo passo', placement: {kind: 'end'}});
    for (const value of [undefined, -1, 1.5, '1']) invalid(() => parseChecklistCreateInput({operationId, expectedChecklistRevision: value, text: 'Passo'}));
    for (const value of ['', '   ', 'a'.repeat(301), null]) invalid(() => parseChecklistCreateInput({operationId, expectedChecklistRevision: 0, text: value}));
});

test('checklist edits require item version and cannot alter rank, actor or aggregate revision', () => {
    const operationId = randomUUID();
    assert.deepEqual(parseChecklistPatchInput({operationId, expectedVersion: 1, changes: {checked: false, text: '  A  '}}),
        {operationId, expectedVersion: 1, changes: {checked: false, text: 'A'}});
    for (const changes of [{}, {position: '1'}, {checkedByUserId: randomUUID()}, {checked: 'true'}, {text: null}]) {
        invalid(() => parseChecklistPatchInput({operationId, expectedVersion: 1, changes}));
    }
    invalid(() => parseChecklistPatchInput({operationId, expectedVersion: 1, expectedChecklistRevision: 3, changes: {checked: true}}));
    invalid(() => parseChecklistPatchInput({operationId, expectedVersion: 0, changes: {checked: true}}));
});

test('delete requires both revisions and anchor reorder rejects ambiguous placements', () => {
    const operationId = randomUUID(), itemId = randomUUID();
    assert.deepEqual(parseChecklistDeleteInput({operationId, expectedVersion: 1, expectedChecklistRevision: 2}),
        {operationId, expectedVersion: 1, expectedChecklistRevision: 2});
    invalid(() => parseChecklistDeleteInput({operationId, expectedVersion: 1}));
    assert.deepEqual(parseChecklistMoveInput({operationId, expectedChecklistRevision: 2, placement: {kind: 'before', itemId}}).placement,
        {kind: 'before', itemId});
    for (const placement of [{kind: 'before'}, {kind: 'after', itemId}, {kind: 'end', itemId}, {kind: 'start', position: 1}]) {
        invalid(() => parseChecklistMoveInput({operationId, expectedChecklistRevision: 2, placement}));
    }
});

test('comments accept plain text up to 5000 characters and reject changes to authors/tombstones', () => {
    const operationId = randomUUID();
    assert.equal(parseCommentCreateInput({operationId, text: '  <b>testo</b>  '}).text, '<b>testo</b>');
    assert.equal(parseCommentCreateInput({operationId, text: 'a'.repeat(5000)}).text.length, 5000);
    for (const text of ['', '   ', null, 'a'.repeat(5001)]) invalid(() => parseCommentCreateInput({operationId, text}));
    invalid(() => parseCommentCreateInput({operationId, text: 'A', authorUserId: randomUUID()}));
    invalid(() => parseCommentPatchInput({operationId, expectedVersion: 1, text: 'A', deletedAt: null}));
    invalid(() => parseCommentDeleteInput({operationId, expectedVersion: 1, text: 'A'}));
    invalid(() => parseCommentPatchInput({operationId, expectedVersion: 0, text: 'A'}));
});

test('child pagination defaults to 20, caps at 200 and rejects malformed offset/limit', () => {
    assert.deepEqual(parseActivityChildPageQuery({}), {limit: 20, cursor: null, offset: 0});
    assert.deepEqual(parseActivityChildPageQuery({limit: '200', offset: '20', pagination: 'cursor'}), {limit: 200, cursor: null, offset: 20});
    for (const limit of ['0', '201', '20abc', ['20']]) invalid(() => parseActivityChildPageQuery({limit}));
    for (const offset of ['-1', '0.5', '9007199254740992', ['1']]) invalid(() => parseActivityChildPageQuery({offset}));
    invalid(() => parseActivityChildPageQuery({cursor: 'a.b', offset: '1'}));
    invalid(() => parseActivityChildPageQuery({pagination: 'offset'}));
});

const context = {userId: randomUUID(), tenantId: randomUUID(), structureId: randomUUID(), schema: 'test',
    permissions: [], timezone: 'Europe/Rome'} as unknown as ActivityContext;
const board: ActivityBoardRecord = {id: randomUUID(), structureId: context.structureId, timezone: context.timezone, orderRevision: 3, snapshotRevision: 8};
const activityId = randomUUID(), row = {id: randomUUID(), createdAt: '2026-10-11T10:00:00.000Z'};
const evaluationAt = '2026-10-11T10:01:00.000Z', evaluated = Date.parse(evaluationAt);
const expired = (callback: () => unknown) => assert.throws(callback, (error: unknown) =>
    error instanceof ActivityError && error.code === 'ACTIVITY_CURSOR_EXPIRED');

test('child cursors preserve evaluation and tuple at the ten-minute boundary', () => {
    const cursor = encodeChildCursor(context, board, activityId, 'comments', evaluationAt, row);
    const parsed = decodeChildCursor(cursor, context, board, activityId, 'comments', evaluated + 600_000);
    assert.equal(parsed.evaluationAt, evaluationAt); assert.equal(parsed.id, row.id); assert.equal(parsed.createdAt, row.createdAt);
    expired(() => decodeChildCursor(cursor, context, board, activityId, 'comments', evaluated + 600_001));
    expired(() => decodeChildCursor(cursor, context, board, activityId, 'comments', evaluated - 1));
});

test('child cursors bind actor, board, activity, kind and snapshot independently of order revision', () => {
    const cursor = encodeChildCursor(context, board, activityId, 'comments', evaluationAt, row);
    decodeChildCursor(cursor, context, {...board, orderRevision: 99}, activityId, 'comments', evaluated);
    expired(() => decodeChildCursor(cursor, {...context, userId: randomUUID()}, board, activityId, 'comments', evaluated));
    expired(() => decodeChildCursor(cursor, context, {...board, id: randomUUID()}, activityId, 'comments', evaluated));
    expired(() => decodeChildCursor(cursor, context, board, randomUUID(), 'comments', evaluated));
    expired(() => decodeChildCursor(cursor, context, board, activityId, 'history', evaluated));
    expired(() => decodeChildCursor(cursor, context, {...board, snapshotRevision: 9}, activityId, 'comments', evaluated));
});

test('child cursors reject altered payload, malformed signatures and appended data', () => {
    const cursor = encodeChildCursor(context, board, activityId, 'comments', evaluationAt, row);
    const [body, signature] = cursor.split('.');
    for (const value of [body + '.invalid', 'invalid.' + signature, cursor + '.extra', 'x'.repeat(4097), '']) {
        expired(() => decodeChildCursor(value, context, board, activityId, 'comments', evaluated));
    }
});
