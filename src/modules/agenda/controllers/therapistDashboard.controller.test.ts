import assert from 'node:assert/strict';
import {it} from 'node:test';
import {Op} from 'sequelize';
import AgendaEvent from '../models/agendaEvent.model.js';
import {therapistDayDashboard} from './agenda.controller.js';

function run(req: any): Promise<{status: number; body: any}> {
    return new Promise(resolve => {
        const res: any = {statusCode: 200, status(code: number) {this.statusCode = code; return this;},
            json(body: any) {resolve({status: this.statusCode, body}); return this;}};
        therapistDayDashboard(req, res, error => resolve({status: 500, body: error}));
    });
}

it('derives the therapist from the authenticated principal and retains the granted agenda scope', async t => {
    const queries: any[] = [];
    t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async (options: any) => {queries.push(options); return [];}})) as any);
    const req: any = {tenantSchema: 'rehablo_test', query: {date: '2026-11-10', operatorId: 'someone-else'},
        user: {sub: 'authenticated-operator'}, access: {scope: 'structure', structureId: 'selected-premise', userId: 'authenticated-operator'}};
    const result = await run(req);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data, {events: [], lastSessionByPatient: {}});
    assert.deepEqual(queries[0].where[Op.and][0][Op.and], [{structureId: 'selected-premise'}, {calendarId: 'authenticated-operator'}]);
    assert.equal(queries.length, 1);
});

it('rejects invalid dates and missing principals before reading any data', async t => {
    t.mock.method(AgendaEvent, 'schema', (() => {throw new Error('unexpected database access');}) as any);
    assert.equal((await run({query: {date: '2026-02-30'}, user: {sub: 'operator'}})).status, 400);
    assert.equal((await run({query: {date: ['2026-11-10']}, user: {sub: 'operator'}})).status, 400);
    assert.equal((await run({query: {date: '2026-11-10'}, user: {}})).status, 401);
});
