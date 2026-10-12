import assert from 'node:assert/strict';
import {it, type TestContext} from 'node:test';
import {sequelize} from '../config/database.js';
import {patientScopeWhere} from './rbac.js';
import Observation from '../modules/measurements/models/observation.model.js';
import {listObservations} from '../modules/measurements/services/observation.service.js';
import Point from '../modules/human-body/models/humanBodyPoint.model.js';
import Questionnaire from '../modules/human-body/models/humanBodyQuestionnaireInstance.model.js';
import Scale from '../modules/human-body/models/userScaleInstance.model.js';
import TestInstance from '../modules/human-body/models/testInstance.model.js';
import Symptom from '../modules/human-body/models/humanBodySymptom.model.js';
import Strength from '../modules/human-body/models/humanBodyStrength.model.js';
import Articularity from '../modules/human-body/models/humanBodyArticularity.model.js';
import TimeOff from '../modules/agenda/models/timeOffRequest.model.js';
import {getQuestionnaireInstances} from '../modules/human-body/controllers/questionnaireInstance.controller.js';
import {getUserScaleInstances} from '../modules/human-body/controllers/scaleInstance.controller.js';
import {getUserTestInstances} from '../modules/human-body/controllers/testInstance.controller.js';
import {getSymptomsByBodyPart} from '../modules/human-body/controllers/symptom.controller.js';
import {getStrengthByBodyPart} from '../modules/human-body/controllers/strength.controller.js';
import {getArticularityByBodyPart} from '../modules/human-body/controllers/articularity.controller.js';
import {getAllHumanBodyPoints, getAllHumanBodyPointsWithEvents} from '../modules/human-body/controllers/point.controller.js';
import {getTimeOffRequests} from '../modules/agenda/controllers/timeOff.controller.js';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const schema = 'rehablo_11111111111141118111111111111111';
const sql = (where: any): string => (sequelize as any).dialect.queryGenerator.whereQuery(where);
function request(scope: 'own' | 'structure' | 'tenant', query: Record<string, unknown> = {}, structureId: string | null = id(2)): any {
    return {tenantSchema: schema, query, body: {}, params: {},
        user: {id: id(1), sub: id(1), tid: id(9)},
        access: {resource: 'evaluation', action: 'read', scope, userId: id(1), structureId}};
}
function invoke(handler: any, req: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const res: any = {statusCode: 200, status(value: number) {this.statusCode = value; return this;},
            json(body: any) {resolve({status: this.statusCode, body}); return this;}};
        handler(req, res, reject);
    });
}
function capture(t: TestContext, model: any): () => string {
    let captured: any;
    t.mock.method(model, 'schema', (selected: string) => {
        assert.equal(selected, schema);
        return {findAll: async (options: any) => {captured = options.where; return [];}};
    });
    return () => {
        assert.ok(captured, 'the real controller/service must issue a scoped query');
        return sql(captured);
    };
}

for (const scope of ['own', 'structure'] as const) {
    it(`observation ${scope} retains both the patient authorization and the requested patient`, async t => {
        const query = capture(t, Observation);
        const req = request(scope);
        await listObservations(schema, {scope: patientScopeWhere(req, schema), patientId: id(3), metricCode: 'force'});
        const emitted = query();
        assert.ok(emitted.includes(`SELECT "id" FROM "${schema}"."patients"`));
        assert.ok(emitted.includes(scope === 'own' ? `"userId" = '${id(1)}'` : `"structureId" = '${id(2)}'`));
        assert.ok(emitted.includes(`"patientId" = '${id(3)}'`));
        assert.ok(emitted.includes(`"metricCode" = 'force'`));
    });
}

const clinicalLists = [
    ['questionnaires', Questionnaire, getQuestionnaireInstances],
    ['scales', Scale, getUserScaleInstances],
    ['tests', TestInstance, getUserTestInstances],
    ['symptoms', Symptom, getSymptomsByBodyPart],
    ['strength', Strength, getStrengthByBodyPart],
    ['articularity', Articularity, getArticularityByBodyPart],
    ['points', Point, getAllHumanBodyPoints],
    ['points with events', Point, getAllHumanBodyPointsWithEvents]
] as const;

for (const [name, model, handler] of clinicalLists) {
    for (const scope of ['own', 'structure', 'tenant'] as const) {
        it(`${name}: ${scope} permissions intersect the selected patient and evaluation`, async t => {
            const query = capture(t, model);
            const response = await invoke(handler, request(scope, {patientId: id(3), evaluationId: id(4)}));
            assert.equal(response.status, 200);
            const emitted = query();
            assert.ok(emitted.includes(`"patientId" = '${id(3)}'`), 'the patient filter must never be discarded');
            assert.ok(emitted.includes(`"evaluationId" = '${id(4)}'`));
            if (scope === 'own') assert.ok(emitted.includes(`"userId" = '${id(1)}'`));
            if (scope === 'structure') assert.ok(emitted.includes(`"structureId" = '${id(2)}'`));
            if (scope === 'tenant') assert.ok(!emitted.includes('SELECT "id"'), 'owner keeps tenant-wide scope');
        });
    }
}

it('observation requests without a selected structure retain the deny-all predicate', async t => {
    const query = capture(t, Observation);
    await listObservations(schema, {scope: patientScopeWhere(request('structure', {}, null), schema), patientId: id(3)});
    assert.ok(query().includes('1=0'));
});

it('own time off scope cannot be replaced by a colleague filter', async t => {
    const query = capture(t, TimeOff);
    const response = await invoke(getTimeOffRequests, request('own', {userId: id(7), status: 'PENDING,APPROVED'}));
    assert.equal(response.status, 200);
    assert.ok(query().includes(`"userId" = '${id(1)}'`));
    assert.ok(query().includes(`"userId" = '${id(7)}'`));
    assert.ok(query().includes("'PENDING', 'APPROVED'"));
});

it('time off date overlap does not replace a missing-structure deny-all predicate', async t => {
    const query = capture(t, TimeOff);
    const response = await invoke(getTimeOffRequests, request('structure', {start: '2026-10-01', end: '2026-11-01'}, null));
    assert.equal(response.status, 200);
    assert.ok(query().includes('1=0'));
    assert.ok(query().includes('"end" >'));
    assert.ok(query().includes('"start" <'));
});

it('tenant owner keeps the requested operator and date filters', async t => {
    const query = capture(t, TimeOff);
    await invoke(getTimeOffRequests, request('tenant', {userId: id(7), start: '2026-10-01'}));
    assert.ok(query().includes(`"userId" = '${id(7)}'`));
    assert.ok(!query().includes(`"userId" = '${id(1)}'`));
});
