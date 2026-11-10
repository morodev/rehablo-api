import assert from 'node:assert/strict';
import {it} from 'node:test';
import {sequelize} from '../../../config/database.js';
import User from '../../auth/models/user.model.js';
import TenantUser from '../../auth/models/tenantUser.model.js';
import StructureUser from '../../auth/models/structureUser.model.js';
import Structure from '../../auth/models/structure.model.js';
import {Activity, ActivityBoard, ActivityAssignment, ActivityAlert, ActivityChecklistItem, ActivityComment} from '../models/index.js';
import {queryActivitySummary} from './activityIntegration.service.js';

const ids = {user: '10000000-0000-4000-8000-000000000001', tenant: '10000000-0000-4000-8000-000000000002',
    structure: '10000000-0000-4000-8000-000000000003'};
it('batches summary relations across overdue and today while preserving bucket order, totals and capabilities', async t => {
    const transaction = {} as any;
    t.mock.method(sequelize, 'transaction', (async (options: any, callback: any) => {
        assert.equal(options.readOnly, true); assert.equal(options.isolationLevel, 'REPEATABLE READ');
        return callback(transaction);
    }) as any);
    t.mock.method(User, 'findOne', (async () => ({id: ids.user})) as any);
    t.mock.method(TenantUser, 'findOne', (async () => ({role: 'OWNER'})) as any);
    t.mock.method(StructureUser, 'findOne', (async () => ({role: null})) as any);
    t.mock.method(Structure, 'findOne', (async () => ({id: ids.structure})) as any);
    t.mock.method(TenantUser, 'findAll', (async () => [{userId: ids.user, role: 'OWNER'}]) as any);
    t.mock.method(StructureUser, 'findAll', (async () => [{userId: ids.user, role: null}]) as any);
    t.mock.method(User, 'findAll', (async () => [{id: ids.user, name: 'Synthetic', surname: 'Operator'}]) as any);
    for (const model of [Activity, ActivityBoard, ActivityAssignment, ActivityAlert, ActivityChecklistItem, ActivityComment]) {
        t.mock.method(model, 'schema', (() => model) as any);
    }
    const board = {id: 'board', structureId: ids.structure, timezone: 'Europe/Rome', snapshotRevision: 12, orderRevision: 3};
    t.mock.method(ActivityBoard, 'findOne', (async () => ({...board, get: (key: any) => typeof key === 'string' ? (board as any)[key] : board})) as any);
    const activity = (id: string, dueAt: Date) => {
        const data = {id, boardId: 'board', title: id, status: 'TODO', priority: 'NORMAL', position: '1024', version: 1,
            checklistRevision: 1, dueKind: 'timed', dueAt, dueTimezone: 'Europe/Rome', recurrence: null, currentExecutionId: null,
            createdByUserId: ids.user, createdAt: new Date(), updatedAt: new Date()};
        return {...data, get: () => data};
    };
    const windows = [[activity('late-b', new Date(Date.now() - 120_000)), activity('late-a', new Date(Date.now() - 60_000))],
        [activity('today', new Date(Date.now() + 60_000))]];
    let queryIndex = 0, countIndex = 0;
    t.mock.method(Activity, 'findAll', (async (options: any) => {
        assert.equal(options.transaction, transaction); assert.equal(options.limit, 5); return windows[queryIndex++];
    }) as any);
    t.mock.method(Activity, 'count', (async () => [9, 6][countIndex++]) as any);
    const assignments = t.mock.method(ActivityAssignment, 'findAll', (async () =>
        windows.flat().map(row => ({activityId: row.id, userId: ids.user}))) as any);
    t.mock.method(ActivityAlert, 'findAll', (async () => []) as any);
    const checklist = t.mock.method(ActivityChecklistItem, 'findAll', (async () =>
        [{activityId: 'late-b', executionId: null, checked: true}, {activityId: 'today', executionId: null, checked: false}]) as any);
    const comments = t.mock.method(ActivityComment, 'findAll', (async () => [{activityId: 'today', executionId: null}]) as any);
    const result = await queryActivitySummary({user: {id: ids.user, sub: ids.user, tid: ids.tenant, sid: ids.structure, actor: 'staff'}} as any,
        {mine: false, limit: 5});
    assert.equal(assignments.mock.callCount(), 1);
    assert.equal(checklist.mock.callCount(), 1);
    assert.equal(comments.mock.callCount(), 1);
    assert.deepEqual(result.overdue.items.map(row => row.id), ['late-b', 'late-a']);
    assert.deepEqual(result.today.items.map(row => row.id), ['today']);
    assert.equal(result.overdue.total, 9); assert.equal(result.today.total, 6);
    assert.deepEqual(result.overdue.items[0].checklistProgress, {total: 1, checked: 1});
    assert.equal(result.today.items[0].commentCount, 1);
    assert.deepEqual(result.today.items[0].assigneeIds, [ids.user]);
    assert.equal(result.overdue.items[0].isOverdue, true);
    assert.equal(result.today.items[0].isOverdue, false);
    assert.equal(result.snapshotRevision, 12);
});
