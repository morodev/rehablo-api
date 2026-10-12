import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sequelize } from '../../../config/database.js';
import Evaluation from '../models/evaluation.model.js';
import HumanBodyPoint from '../../human-body/models/humanBodyPoint.model.js';
import HumanBodyEvent from '../../human-body/models/humanBodyEvent.model.js';
import { assertEvaluationEditable } from '../services/evaluationGuard.js';
import { resolveHumanBodyPointId } from '../../human-body/controllers/humanBodyPoint.helper.js';
import { createHumanBodyPoint } from '../../human-body/controllers/point.controller.js';

const transaction = { LOCK: { SHARE: 'SHARE', UPDATE: 'UPDATE' } } as any;

test('point helper propagates the caller transaction to lookup and creation', async t => {
    const options: any[] = [];
    t.mock.method(HumanBodyPoint, 'schema', (() => ({
        findOne: async (value: any) => { options.push(value); return { get: () => 'existing' }; },
        create: async (_value: any, option: any) => { options.push(option); return { get: () => 'created' }; }
    })) as any);
    assert.equal(await resolveHumanBodyPointId('fixture', { humanBodyPointId: 'existing' }, 'actor', transaction), 'existing');
    assert.equal(await resolveHumanBodyPointId('fixture', { pointToCreate: {} }, 'actor', transaction), 'created');
    assert.ok(options.every(option => option.transaction === transaction));
});

test('evaluation guard locks the editable source for the caller transaction and keeps legacy behavior', async t => {
    let options: any;
    let lookups = 0;
    t.mock.method(Evaluation, 'schema', (() => ({
        findByPk: async (_id: string, option: any) => {
            lookups++; options = option;
            return { get: (key: string) => ({ status: 'DRAFT', createdAt: new Date(), userId: 'actor' })[key] };
        }
    })) as any);
    await assertEvaluationEditable('fixture', null, 'actor', transaction);
    assert.equal(lookups, 0);
    await assertEvaluationEditable('fixture', 'evaluation', 'actor', transaction);
    assert.equal(options.transaction, transaction);
    assert.equal(options.lock, 'SHARE');
    await assert.rejects(assertEvaluationEditable('fixture', 'evaluation', 'other', transaction),
        (error: any) => error.statusCode === 404);
});

test('point response is sent only after transaction commit completes', async t => {
    let releaseCommit!: () => void;
    let reachedCommit!: () => void;
    const committing = new Promise<void>(resolve => { reachedCommit = resolve; });
    const commit = new Promise<void>(resolve => { releaseCommit = resolve; });
    t.mock.method(sequelize, 'transaction', (async (callback: any) => {
        const value = await callback(transaction);
        reachedCommit();
        await commit;
        return value;
    }) as any);
    const writes: any[] = [];
    t.mock.method(HumanBodyPoint, 'schema', (() => ({
        create: async (_values: any, options: any) => { writes.push(options); return { get: () => 'point' }; }
    })) as any);
    t.mock.method(HumanBodyEvent, 'schema', (() => ({
        bulkCreate: async (_values: any, options: any) => { writes.push(options); return []; }
    })) as any);
    let sent = false;
    const res: any = { status() { return res; }, json() { sent = true; return res; } };
    let done!: () => void;
    let reject!: (error: unknown) => void;
    const completed = new Promise<void>((resolve, fail) => { done = resolve; reject = fail; });
    res.json = () => { sent = true; done(); return res; };
    createHumanBodyPoint({ tenantSchema: 'fixture', body: { humanBodyEvents: [{ eventType: 'fixture' }] },
        access: { userId: 'actor', scope: 'tenant' } } as any, res, reject);
    await committing;
    assert.equal(sent, false);
    assert.ok(writes.every(options => options.transaction === transaction));
    releaseCommit();
    await completed;
    assert.equal(sent, true);
});

test('point commit failure reaches the error handler without sending success', async t => {
    const error = new Error('commit failed');
    t.mock.method(sequelize, 'transaction', (async (callback: any) => { await callback(transaction); throw error; }) as any);
    t.mock.method(HumanBodyPoint, 'schema', (() => ({ create: async () => ({ get: () => 'point' }) })) as any);
    let sent = false;
    const res: any = { status() { sent = true; return res; }, json() { return res; } };
    const caught = await new Promise(resolve => createHumanBodyPoint({
        tenantSchema: 'fixture', body: {}, access: { userId: 'actor', scope: 'tenant' }
    } as any, res, resolve));
    assert.equal(caught, error);
    assert.equal(sent, false);
});

