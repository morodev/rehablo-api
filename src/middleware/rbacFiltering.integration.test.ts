import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after, before, it} from 'node:test';
import {QueryTypes} from 'sequelize';
import {requireActivitiesTestDatabase} from '../../scripts/activities-test-database.mjs';

// Resolve and validate the disposable database before importing any application model.
const safe = requireActivitiesTestDatabase(process.env);
process.env.DATABASE_URL = safe.databaseUrl;
process.env.DB_SSL = 'false';
process.env.NODE_ENV = 'test';
const {sequelize} = await import('../config/database.js');
(sequelize as any).options.logging = false;
const rbac = await import('./rbac.js');
const {default: Observation} = await import('../modules/measurements/models/observation.model.js');
const {listObservations} = await import('../modules/measurements/services/observation.service.js');
const {default: TimeOff} = await import('../modules/agenda/models/timeOffRequest.model.js');
const {getTimeOffRequests} = await import('../modules/agenda/controllers/timeOff.controller.js');
const clinical = await Promise.all([
    ['questionnaireInstance', 'humanBodyQuestionnaireInstance', 'getQuestionnaireInstances'],
    ['scaleInstance', 'userScaleInstance', 'getUserScaleInstances'],
    ['testInstance', 'testInstance', 'getUserTestInstances'],
    ['symptom', 'humanBodySymptom', 'getSymptomsByBodyPart'],
    ['strength', 'humanBodyStrength', 'getStrengthByBodyPart'],
    ['articularity', 'humanBodyArticularity', 'getArticularityByBodyPart'],
    ['point', 'humanBodyPoint', 'getAllHumanBodyPoints'],
    ['point', 'humanBodyPoint', 'getAllHumanBodyPointsWithEvents']
].map(async ([controller, model, handler]) => ({name: handler,
    model: (await import(`../modules/human-body/models/${model}.model.js`)).default,
    handler: (await import(`../modules/human-body/controllers/${controller}.controller.js`))[handler]})));

const schema = 'rbac_test_' + randomUUID().replaceAll('-', '');
const otherSchema = 'rbac_test_' + randomUUID().replaceAll('-', '');
const userA = randomUUID(), userB = randomUUID(), siteA = randomUUID(), siteB = randomUUID();
const patientA = randomUUID(), patientB = randomUUID(), patientC = randomUUID(), evaluation = randomUUID();
let initialized = false;
before(async () => {
    const [database] = await sequelize.query<{name: string}>('SELECT current_database() AS name', {type: QueryTypes.SELECT});
    assert.equal(database.name, safe.databaseName);
    await sequelize.query(`CREATE SCHEMA "${schema}"`);
    initialized = true;
    await sequelize.query(`CREATE SCHEMA "${otherSchema}"`);
    for (const name of [schema, otherSchema]) {
        await sequelize.query(`CREATE TABLE "${name}".patients (id uuid PRIMARY KEY, "userId" uuid, "structureId" uuid)`);
        await sequelize.query(`CREATE TABLE "${name}".records (id text PRIMARY KEY, "patientId" uuid, "userId" uuid,
            "structureId" uuid, "evaluationId" uuid, "metricCode" text, start timestamptz, "end" timestamptz, status text)`);
    }
    await sequelize.query(`INSERT INTO "${schema}".patients VALUES (:a,:ua,:sa),(:b,:ub,:sa),(:c,:ub,:sb)`, {
        replacements: {a: patientA, b: patientB, c: patientC, ua: userA, ub: userB, sa: siteA, sb: siteB}
    });
    for (const [id, patientId, userId, structureId] of [
        ['mine', patientA, userA, siteA], ['colleague', patientB, userB, siteA], ['other-site', patientC, userB, siteB]
    ]) await sequelize.query(`INSERT INTO "${schema}".records VALUES (:id,:patientId,:userId,:structureId,:evaluation,'force','2026-10-10','2026-10-12','PENDING')`, {
        replacements: {id, patientId, userId, structureId, evaluation}
    });
    await sequelize.query(`INSERT INTO "${otherSchema}".records VALUES ('foreign-tenant',:patient,:user,:site,:evaluation,'force','2026-10-10','2026-10-12','PENDING')`, {
        replacements: {patient: patientA, user: userA, site: siteA, evaluation}
    });
});
after(async () => {
    try {
        if (initialized) {
            for (const name of [schema, otherSchema]) {
                assert.match(name, /^rbac_test_[a-f0-9]{32}$/);
                await sequelize.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
            }
        }
    } finally {await sequelize.close();}
});
function request(scope: 'own' | 'structure' | 'tenant', query: Record<string, unknown>, selectedSite: string | null = siteA): any {
    return {tenantSchema: schema, query, user: {id: userA, sub: userA},
        access: {scope, userId: userA, structureId: selectedSite, resource: 'evaluation', action: 'read'}};
}
function invoke(handler: any, req: any): Promise<void> {
    return new Promise((resolve, reject) => {
        const res: any = {status(code: number) {assert.equal(code, 200); return this;}, json() {resolve(); return this;}};
        handler(req, res, reject);
    });
}
async function rowsFor(where: any): Promise<string[]> {
    const predicate = (sequelize as any).dialect.queryGenerator.whereQuery(where);
    const rows = await sequelize.query<{id: string}>(`SELECT id FROM "${schema}".records ${predicate} ORDER BY id`, {type: QueryTypes.SELECT});
    return rows.map(row => row.id);
}

for (const item of clinical) {
    it(`${item.name}: PostgreSQL keeps authorized records and rejects another site`, async t => {
        let actual: string[] = [];
        t.mock.method(item.model, 'schema', (selected: string) => {
            assert.equal(selected, schema);
            return {findAll: async ({where}: any) => {actual = await rowsFor(where); return [];}};
        });
        for (const [scope, patientId, expected] of [
            ['structure', patientA, ['mine']], ['structure', patientB, ['colleague']], ['structure', patientC, []],
            ['own', patientA, ['mine']], ['own', patientB, []], ['tenant', patientC, ['other-site']]
        ] as const) {
            await invoke(item.handler, request(scope, {patientId, evaluationId: evaluation}));
            assert.deepEqual(actual, expected);
        }
    });
}

it('observation patient subqueries are enforced by PostgreSQL for own, structure and tenant scopes', async t => {
    let actual: string[] = [];
    t.mock.method(Observation, 'schema', ((selected: string) => {
        assert.equal(selected, schema);
        return {findAll: async ({where}: any) => {actual = await rowsFor(where); return [];}};
    }) as any);
    for (const [scope, patientId, expected] of [
        ['own', patientA, ['mine']], ['own', patientB, []], ['structure', patientB, ['colleague']],
        ['structure', patientC, []], ['tenant', patientC, ['other-site']]
    ] as const) {
        const req = request(scope, {});
        await listObservations(schema, {scope: rbac.patientScopeWhere(req, schema), patientId});
        assert.deepEqual(actual, expected);
    }
});

it('time off own/structure limits remain effective with operator and overlap filters', async t => {
    let actual: string[] = [];
    t.mock.method(TimeOff, 'schema', ((selected: string) => {
        assert.equal(selected, schema);
        return {findAll: async ({where}: any) => {actual = await rowsFor(where); return [];}};
    }) as any);
    await invoke(getTimeOffRequests, request('own', {userId: userB}));
    assert.deepEqual(actual, []);
    await invoke(getTimeOffRequests, request('own', {userId: userA}));
    assert.deepEqual(actual, ['mine']);
    await invoke(getTimeOffRequests, request('structure', {userId: userB, start: '2026-10-01', end: '2026-11-01'}));
    assert.deepEqual(actual, ['colleague']);
    await invoke(getTimeOffRequests, request('structure', {start: '2026-10-01', end: '2026-11-01'}, null));
    assert.deepEqual(actual, []);
});
