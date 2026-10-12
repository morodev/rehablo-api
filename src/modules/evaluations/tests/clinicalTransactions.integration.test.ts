import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test, type TestContext } from 'node:test';
import type { RequestHandler } from 'express';

// Validate the isolated database BEFORE importing anything that initializes Sequelize.
const { requireActivitiesTestDatabase } = await import('../../../../scripts/activities-test-database.mjs');
const target = requireActivitiesTestDatabase(process.env);
process.env.DATABASE_URL = target.databaseUrl;
process.env.NODE_ENV = 'test';
process.env.DB_SSL = 'false';
process.env.JWT_SECRET ??= randomUUID();
const { sequelize } = await import('../../../config/database.js');
(sequelize as any).options.logging = false;
const auth = await import('../../auth/models/index.js');
const hb = await import('../../human-body/models/index.js');
const evals = await import('../models/index.js');
const protocols = await import('../../protocols/models/index.js');
const catalog = await import('../../protocols/models/catalog/index.js');
const { default: Observation } = await import('../../measurements/models/observation.model.js');
const { default: Patient } = await import('../../patients/models/patient.model.js');
const { default: HumanBodyEvent } = await import('../../human-body/models/humanBodyEvent.model.js');
const { cloneEvaluation } = await import('../services/evaluationClone.js');
const { createHumanBodyPoint } = await import('../../human-body/controllers/point.controller.js');
const { saveSymptom } = await import('../../human-body/controllers/symptom.controller.js');
const { saveStrength } = await import('../../human-body/controllers/strength.controller.js');
const { saveArticularity } = await import('../../human-body/controllers/articularity.controller.js');
const { saveQuestionnaireInstance } = await import('../../human-body/controllers/questionnaireInstance.controller.js');
const { saveScale } = await import('../../human-body/controllers/scaleInstance.controller.js');
const questionnaire = await import('../../human-body/controllers/questionnaire.controller.js');
const { assignProtocol } = await import('../../protocols/controllers/protocolInstance.controller.js');
const { saveProtocolTemplate } = await import('../../protocols/controllers/protocolTemplate.controller.js');
const { advanceProtocolPhase } = await import('../../protocols/controllers/protocolPhaseInstance.controller.js');
const { deletePatient } = await import('../../patients/controllers/patient.controller.js');
const { updateStructureForTenant } = await import('../../auth/controllers/structure.controller.js');

const tenantId = randomUUID(), userId = randomUUID(), structureId = randomUUID();
const schema = 'rehablo_' + tenantId.replaceAll('-', '');
const publicTemplates: string[] = [], publicExercises: string[] = [];
let verified = false, createdSchema = false;
const cloneModels: any[] = [evals.Evaluation, hb.HumanBodyPoint, HumanBodyEvent, hb.HumanBodySymptom,
    hb.HumanBodyArticularity, hb.HumanBodyStrength, hb.HumanBodyQuestionnaireInstance, hb.HumanBodyAnswerInstance,
    hb.UserScaleInstance, hb.UserAnswer, hb.TestInstance, Observation];

before(async () => {
    await sequelize.authenticate();
    const [rows] = await sequelize.query('SELECT current_database() AS name');
    assert.equal((rows[0] as any).name, target.databaseName);
    verified = true;
    auth.registerAuthAssociations();
    hb.registerHumanBodyAssociations();
    evals.registerEvaluationAssociations();
    catalog.registerProtocolCatalogAssociations();
    protocols.registerProtocolAssociations();
    // Only the required fixture models; never server bootstrap, alter or force.
    for (const model of [auth.Tenant, auth.User, auth.UserEmail, auth.Structure, auth.StructureAvailability,
        auth.PatientPortalAccess, catalog.Exercise, catalog.ProtocolTemplate, catalog.ProtocolPhaseTemplate,
        catalog.ProtocolTemplateExercise]) await model.sync({ force: false, alter: false });
    assert.match(schema, /^rehablo_[a-f0-9]{32}$/);
    await sequelize.query('CREATE SCHEMA "' + schema + '"');
    createdSchema = true;
    for (const model of [Patient, evals.Evaluation, hb.HumanBodyArea, hb.HumanBodyPoint, HumanBodyEvent,
        hb.HumanBodySymptom, hb.HumanBodyArticularity, hb.HumanBodyStrength, hb.HumanBodyQuestionnaire,
        hb.HumanBodyQuestion, hb.HumanBodyAnswer, hb.HumanBodyQuestionnaireInstance, hb.HumanBodyAnswerInstance,
        hb.UserScaleInstance, hb.UserAnswer, hb.TestInstance, Observation, protocols.ProtocolInstance,
        protocols.ProtocolPhaseInstance, protocols.ProtocolExerciseLog]) {
        await (model as any).schema(schema).sync({ force: false, alter: false });
    }
    await auth.Tenant.create({ id: tenantId, businessName: tenantId, license: 'fixture', idStripe: tenantId,
        maxUserQuantity: 1, maxStructureQuantity: 1 });
    await auth.User.create({ id: userId, email: userId + '@example.invalid', password: 'fixture', isActive: true });
    await auth.Structure.create({ id: structureId, tenantId, name: 'Original structure' });
});

after(async () => {
    try {
        if (!verified) return;
        if (createdSchema) await sequelize.query('DROP SCHEMA "' + schema + '" CASCADE');
        if (publicTemplates.length) await catalog.ProtocolTemplate.destroy({ where: { id: publicTemplates } });
        if (publicExercises.length) await catalog.Exercise.destroy({ where: { id: publicExercises } });
        await auth.PatientPortalAccess.destroy({ where: { tenantId } });
        await auth.StructureAvailability.destroy({ where: { structureId } });
        await auth.Structure.destroy({ where: { id: structureId } });
        await auth.UserEmail.destroy({ where: { userId } });
        await auth.User.destroy({ where: { id: userId } });
        await auth.Tenant.destroy({ where: { id: tenantId } });
    } finally { await sequelize.close(); }
});

function invoke(handler: RequestHandler, body: any = {}, params: any = {}, extra: any = {}): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
        let status = 200;
        const res: any = { status(value: number) { status = value; return res; },
            json(value: any) { resolve({ status, body: value }); return res; } };
        handler({ tenantSchema: schema, body, params, query: {}, user: { id: userId, sub: userId,
            tid: tenantId, tenants: [{ id: tenantId }] }, access: { scope: 'tenant', userId, structureId },
            ...extra } as any, res, reject);
    });
}

async function snapshot(models: any[], publicModels: any[] = []) {
    return JSON.stringify(await Promise.all([
        ...models.map(model => model.schema(schema).findAll({ raw: true, order: [['id', 'ASC']] })),
        ...publicModels.map(model => model.findAll({ raw: true, order: [['id', 'ASC']] }))
    ]));
}

/** Execute the real write, then fail: only an actual DB rollback can restore the snapshot. */
function failAfter(t: TestContext, model: any, method: string, occurrence = 1) {
    const original = model[method];
    let writes = 0;
    const mocked = t.mock.method(model, method, async function (this: any, ...args: any[]) {
        const result = await original.apply(this, args);
        if (++writes === occurrence) throw new Error('injected after write');
        return result;
    });
    return mocked;
}

async function patientFixture() {
    return Patient.schema(schema).create({ tenantId, userId, structureId, name: 'Synthetic patient' } as any);
}
function pointInput(patientId: string, evaluationId?: string) {
    return { patientId, userId, evaluationId, cxCoordinate: 1, cyCoordinate: 2, rDimension: 4,
        bodyPart: 'arm', fillColor: '#000000', idSvg: 'fixture' };
}
async function evaluationFixture() {
    const patient = await patientFixture();
    const evaluation = await evals.Evaluation.schema(schema).create({ patientId: patient.id, userId,
        structureId, title: 'Source', notes: 'Synthetic', status: 'DRAFT' });
    return { patient, evaluation };
}
async function questionnaireFixture() {
    const parent = await hb.HumanBodyQuestionnaire.schema(schema).create({ title: 'Fixture' } as any);
    const question = await hb.HumanBodyQuestion.schema(schema).create({
        humanBodyQuestionnaireId: parent.id, text: 'Question', type: 'single' } as any);
    const answer = await hb.HumanBodyAnswer.schema(schema).create({
        humanBodyQuestionId: question.id, text: 'Answer', isCorrect: true } as any);
    return { parent, question, answer };
}
async function fullCloneFixture() {
    const { patient, evaluation } = await evaluationFixture();
    const point = await hb.HumanBodyPoint.schema(schema).create(pointInput(patient.id, evaluation.id));
    await HumanBodyEvent.schema(schema).create({ humanBodyPointId: point.id, eventType: 'fixture' });
    const base = { humanBodyPointId: point.id, evaluationId: evaluation.id, patientId: patient.id,
        userId, bodyPart: 'arm', date: new Date() };
    await hb.HumanBodySymptom.schema(schema).create({ ...base, symptom: 'fixture', value: 2 } as any);
    await hb.HumanBodyStrength.schema(schema).create({ ...base, valueStrength: 4 } as any);
    await hb.HumanBodyArticularity.schema(schema).create({ ...base, articularity: 'fixture', movement: 'flexion' } as any);
    const { parent, question, answer } = await questionnaireFixture();
    const instance = await hb.HumanBodyQuestionnaireInstance.schema(schema).create({
        userId, patientId: patient.id, evaluationId: evaluation.id, humanBodyPointId: point.id,
        humanBodyQuestionnaireId: parent.id });
    await hb.HumanBodyAnswerInstance.schema(schema).create({ humanBodyQuestionnaireInstanceId: instance.id,
        humanBodyQuestionId: question.id, humanBodyAnswerId: answer.id, customAnswer: null });
    const scale = await hb.UserScaleInstance.schema(schema).create({
        userId, patientId: patient.id, evaluationId: evaluation.id, scaleId: randomUUID() });
    await hb.UserAnswer.schema(schema).create({ userScaleInstanceId: scale.id, questionScaleId: randomUUID(),
        answerScaleId: null, customAnswer: 'fixture' });
    await hb.TestInstance.schema(schema).create({ userId, patientId: patient.id, evaluationId: evaluation.id,
        testId: randomUUID(), notes: 'fixture', isPositive: false });
    await Observation.schema(schema).create({ tenantId, patientId: patient.id, evaluationId: evaluation.id,
        humanBodyPointId: point.id, metricCode: 'fixture', unit: 'deg', effectiveDateTime: new Date(),
        provenance: 'MANUAL', value: 0 } as any);
    return { patient, evaluation, point };
}

for (const [name, model] of [['first point', hb.HumanBodyPoint], ['middle answer', hb.HumanBodyAnswerInstance],
    ['last observation', Observation]] as const) {
    test('clone rolls back every row after failure at ' + name, async t => {
        const { evaluation } = await fullCloneFixture();
        const before = await snapshot(cloneModels);
        failAfter(t, model, 'create');
        await assert.rejects(cloneEvaluation(schema, evaluation.id, { userId }), /injected after write/);
        assert.equal(await snapshot(cloneModels), before);
    });
}

test('clone commits the complete graph, remaps IDs and leaves the source unchanged', async () => {
    const { evaluation, point } = await fullCloneFixture();
    const beforeSource = evaluation.toJSON();
    const counts = await Promise.all(cloneModels.map(model => model.schema(schema).count()));
    const cloned = await cloneEvaluation(schema, evaluation.id, { userId });
    assert.equal(cloned.status, 'DRAFT');
    assert.equal(cloned.parentEvaluationId, evaluation.id);
    assert.equal(cloned.title, 'Copia di Source');
    assert.equal(cloned.userId, userId);
    const afterCounts = await Promise.all(cloneModels.map(model => model.schema(schema).count()));
    assert.deepEqual(afterCounts, counts.map(count => count + 1));
    assert.deepEqual((await evals.Evaluation.schema(schema).findByPk(evaluation.id))!.toJSON(), beforeSource);
    const clonedPoint = (await hb.HumanBodyPoint.schema(schema).findOne({ where: { evaluationId: cloned.id } }))!;
    assert.notEqual(clonedPoint.id, point.id);
    const observation = (await Observation.schema(schema).findOne({ where: { evaluationId: cloned.id } }))!;
    assert.equal(observation.humanBodyPointId, clonedPoint.id);
    const questionnaire = (await hb.HumanBodyQuestionnaireInstance.schema(schema).findOne({ where: { evaluationId: cloned.id } }))!;
    assert.equal(questionnaire.humanBodyPointId, clonedPoint.id);
    assert.equal(await hb.HumanBodyAnswerInstance.schema(schema).count({
        where: { humanBodyQuestionnaireInstanceId: questionnaire.id } }), 1);
    const scale = (await hb.UserScaleInstance.schema(schema).findOne({ where: { evaluationId: cloned.id } }))!;
    assert.equal(await hb.UserAnswer.schema(schema).count({ where: { userScaleInstanceId: scale.id } }), 1);
    for (const model of [hb.HumanBodySymptom, hb.HumanBodyArticularity, hb.HumanBodyStrength] as any[]) {
        const child = await model.schema(schema).findOne({ where: { evaluationId: cloned.id } });
        assert.equal(child.humanBodyPointId, clonedPoint.id);
    }
    assert.equal(await HumanBodyEvent.schema(schema).count({ where: { humanBodyPointId: clonedPoint.id } }), 1);
});

test('clone reads all children from the same repeatable-read snapshot', async t => {
    const { evaluation, point } = await fullCloneFixture();
    const original = evals.Evaluation.findByPk;
    let changed = false;
    t.mock.method(evals.Evaluation, 'findByPk', (async function (this: any, id: any, options: any) {
        const source = await original.call(this, id, options);
        if (id === evaluation.id && !changed) {
            changed = true;
            // A separate pooled connection changes a child after the source snapshot exists.
            await hb.HumanBodyPoint.schema(schema).update({ cxCoordinate: 99 }, { where: { id: point.id } });
        }
        return source;
    }) as any);
    const cloned = await cloneEvaluation(schema, evaluation.id, { userId });
    const clonedPoint = (await hb.HumanBodyPoint.schema(schema).findOne({ where: { evaluationId: cloned.id } }))!;
    assert.equal(clonedPoint.cxCoordinate, 1);
    assert.equal((await hb.HumanBodyPoint.schema(schema).findByPk(point.id))!.cxCoordinate, 99);
});

test('point and events roll back together after the event insert', async t => {
    const { patient, evaluation } = await evaluationFixture();
    const before = await snapshot([hb.HumanBodyPoint, HumanBodyEvent]);
    failAfter(t, HumanBodyEvent, 'bulkCreate');
    await assert.rejects(invoke(createHumanBodyPoint, { ...pointInput(patient.id, evaluation.id),
        humanBodyEvents: [{ eventType: 'fixture' }] }), /injected after write/);
    assert.equal(await snapshot([hb.HumanBodyPoint, HumanBodyEvent]), before);
});

for (const [name, handler, model, method, child] of [
    ['symptom', saveSymptom, hb.HumanBodySymptom, 'create', { symptom: 'fixture', value: 1 }],
    ['strength', saveStrength, hb.HumanBodyStrength, 'create', { valueStrength: 1 }],
    ['articularity', saveArticularity, hb.HumanBodyArticularity, 'bulkCreate', null]
] as const) {
    test(name + ' failure rolls back its automatically created point', async t => {
        const { patient, evaluation } = await evaluationFixture();
        const common = { patientId: patient.id, evaluationId: evaluation.id, bodyPart: 'arm', date: new Date() };
        const body = { ...common, ...child, pointToCreate: pointInput(patient.id, evaluation.id),
            ...(name === 'articularity' ? { articularities: [{ ...common, articularity: 'fixture', movement: 'flexion' }] } : {}) };
        const before = await snapshot([hb.HumanBodyPoint, model]);
        failAfter(t, model, method);
        await assert.rejects(invoke(handler, body), /injected after write/);
        assert.equal(await snapshot([hb.HumanBodyPoint, model]), before);
    });
}

test('compiled questionnaire failure rolls back point, instance and answers', async t => {
    const { patient, evaluation } = await evaluationFixture();
    const { parent, question } = await questionnaireFixture();
    const models = [hb.HumanBodyPoint, hb.HumanBodyQuestionnaireInstance, hb.HumanBodyAnswerInstance];
    const before = await snapshot(models);
    failAfter(t, hb.HumanBodyAnswerInstance, 'bulkCreate');
    await assert.rejects(invoke(saveQuestionnaireInstance, { patientId: patient.id, evaluationId: evaluation.id,
        questionnaireId: parent.id, pointToCreate: pointInput(patient.id, evaluation.id),
        questions: [{ questionId: question.id, customAnswer: 'free text' }] }), /injected after write/);
    assert.equal(await snapshot(models), before);
});

test('scale answer failure rolls back the scale instance', async t => {
    const { patient, evaluation } = await evaluationFixture();
    const models = [hb.UserScaleInstance, hb.UserAnswer], before = await snapshot(models);
    failAfter(t, hb.UserAnswer, 'bulkCreate');
    await assert.rejects(invoke(saveScale, { patientId: patient.id, evaluationId: evaluation.id,
        scaleId: randomUUID(), questions: [{ questionId: randomUUID(), customAnswer: 'free text' }] }), /injected after write/);
    assert.equal(await snapshot(models), before);
});

test('empty compiled questionnaires/scales and legacy missing evaluation remain supported', async () => {
    const patient = await patientFixture(), { parent } = await questionnaireFixture();
    const questionnaireResult = await invoke(saveQuestionnaireInstance, { patientId: patient.id,
        questionnaireId: parent.id, questions: [] });
    assert.equal(questionnaireResult.status, 201);
    assert.equal(questionnaireResult.body.data.evaluationId, null);
    assert.equal(questionnaireResult.body.data.humanBodyPointId, null);
    const scaleResult = await invoke(saveScale, { patientId: patient.id, scaleId: randomUUID(), questions: [] });
    assert.equal(scaleResult.status, 201);
    assert.equal(scaleResult.body.data.evaluationId, null);
});

test('closed evaluation still rejects child writes without creating a point', async () => {
    const { patient, evaluation } = await evaluationFixture();
    await evaluation.update({ status: 'COMPLETED' });
    const before = await snapshot([hb.HumanBodyPoint]);
    await assert.rejects(invoke(createHumanBodyPoint, pointInput(patient.id, evaluation.id)),
        (error: any) => error.statusCode === 409);
    assert.equal(await snapshot([hb.HumanBodyPoint]), before);
});

test('questionnaire definition creation rolls back its complete tree', async t => {
    const models = [hb.HumanBodyQuestionnaire, hb.HumanBodyQuestion, hb.HumanBodyAnswer];
    const before = await snapshot(models);
    failAfter(t, hb.HumanBodyAnswer, 'bulkCreate', 2);
    await assert.rejects(invoke(questionnaire.saveQuestionnaire, { title: 'New questionnaire',
        questionnaires: [{ text: 'First', type: 'single', answers: [] }, { text: 'Second', type: 'single', answers: [] }] }),
    /injected after write/);
    assert.equal(await snapshot(models), before);
});

test('questionnaire definition update restores existing title, question and answer on failure', async t => {
    const { parent, question, answer } = await questionnaireFixture();
    const models = [hb.HumanBodyQuestionnaire, hb.HumanBodyQuestion, hb.HumanBodyAnswer], before = await snapshot(models);
    failAfter(t, hb.HumanBodyAnswer.prototype, 'update');
    await assert.rejects(invoke(questionnaire.updateQuestionnaireById, { title: 'Changed', questionnaires: [{
        id: question.id, text: 'Changed question', type: 'single', answers: [{ id: answer.id, text: 'Changed answer' }] }]
    }, { questionnaireId: parent.id }), /injected after write/);
    assert.equal(await snapshot(models), before);
});

test('questionnaire definition deletion restores all children on failure', async t => {
    const { parent } = await questionnaireFixture();
    const models = [hb.HumanBodyQuestionnaire, hb.HumanBodyQuestion, hb.HumanBodyAnswer], before = await snapshot(models);
    failAfter(t, hb.HumanBodyQuestion, 'destroy');
    await assert.rejects(invoke(questionnaire.deleteQuestionnaireById, {}, { questionnaireId: parent.id }), /injected after write/);
    assert.equal(await snapshot(models), before);
});

async function protocolFixture() {
    const template = await catalog.ProtocolTemplate.create({ name: 'Fixture ' + randomUUID() } as any);
    publicTemplates.push(template.id);
    const first = await catalog.ProtocolPhaseTemplate.create({ protocolTemplateId: template.id, name: 'First', order: 0 } as any);
    const second = await catalog.ProtocolPhaseTemplate.create({ protocolTemplateId: template.id, name: 'Second', order: 1 } as any);
    return { template, first, second };
}

test('protocol template failure rolls back template, phases and exercise prescriptions', async t => {
    const exercise = await catalog.Exercise.create({ name: 'Fixture ' + randomUUID() });
    publicExercises.push(exercise.id);
    const models = [catalog.ProtocolTemplate, catalog.ProtocolPhaseTemplate, catalog.ProtocolTemplateExercise];
    const before = await snapshot([], models);
    failAfter(t, catalog.ProtocolTemplateExercise, 'create', 2);
    await assert.rejects(invoke(saveProtocolTemplate, { name: 'Failed fixture', phases: [
        { name: 'First', exercises: [{ exerciseId: exercise.id }] }, { name: 'Second', exercises: [{ exerciseId: exercise.id }] }
    ] }), /injected after write/);
    assert.equal(await snapshot([], models), before);
});

test('protocol assignment failure rolls back every phase and its parent', async t => {
    const patient = await patientFixture(), { template } = await protocolFixture();
    const models = [protocols.ProtocolInstance, protocols.ProtocolPhaseInstance], before = await snapshot(models);
    failAfter(t, protocols.ProtocolPhaseInstance, 'create', 2);
    await assert.rejects(invoke(assignProtocol, { patientId: patient.id, protocolTemplateId: template.id }), /injected after write/);
    assert.equal(await snapshot(models), before);
});

test('phase advance rollback preserves current and next phase, then success advances both', async t => {
    const patient = await patientFixture(), { template, first, second } = await protocolFixture();
    const result = await invoke(assignProtocol, { patientId: patient.id, protocolTemplateId: template.id });
    assert.equal(result.status, 201);
    const phases = await protocols.ProtocolPhaseInstance.schema(schema).findAll({
        where: { protocolInstanceId: result.body.data.id } });
    const current = phases.find(phase => phase.protocolPhaseTemplateId === first.id)!;
    const next = phases.find(phase => phase.protocolPhaseTemplateId === second.id)!;
    assert.equal(current.status, 'IN_PROGRESS'); assert.equal(next.status, 'PENDING');
    const before = await snapshot([protocols.ProtocolPhaseInstance]);
    const mocked = failAfter(t, protocols.ProtocolPhaseInstance.prototype, 'update', 2);
    await assert.rejects(invoke(advanceProtocolPhase, { progressionNotes: 'done' },
        { protocolPhaseInstanceId: current.id }), /injected after write/);
    assert.equal(await snapshot([protocols.ProtocolPhaseInstance]), before);
    mocked.mock.restore();
    assert.equal((await invoke(advanceProtocolPhase, { progressionNotes: 'done' },
        { protocolPhaseInstanceId: current.id })).status, 200);
    await current.reload(); await next.reload();
    assert.equal(current.status, 'COMPLETED'); assert.equal(next.status, 'IN_PROGRESS');
});

test('patient archive rolls back both tenant and public changes on portal failure', async t => {
    const patient = await patientFixture();
    const access = await auth.PatientPortalAccess.create({ tenantId, patientId: patient.id, userId, status: 'ACTIVE' });
    const before = await snapshot([Patient], [auth.PatientPortalAccess]);
    failAfter(t, auth.PatientPortalAccess, 'update');
    await assert.rejects(invoke(deletePatient, {}, { patientId: patient.id }), /injected after write/);
    assert.equal(await snapshot([Patient], [auth.PatientPortalAccess]), before);
    await access.reload(); assert.equal(access.status, 'ACTIVE');
});

test('patient archive changes only ACTIVE portal links, preserves REVOKED and handles absent links', async () => {
    for (const status of ['ACTIVE', 'REVOKED', null] as const) {
        const patient = await patientFixture();
        const access = status ? await auth.PatientPortalAccess.create({ tenantId, patientId: patient.id,
            userId, status, ...(status === 'REVOKED' ? { revokedAt: new Date(), revokedByUserId: userId } : {}) }) : null;
        assert.equal((await invoke(deletePatient, {}, { patientId: patient.id })).status, 200);
        await patient.reload(); assert.ok(patient.archivedAt);
        if (access) {
            await access.reload();
            assert.equal(access.status, status === 'ACTIVE' ? 'HISTORICAL' : 'REVOKED');
            if (status === 'ACTIVE') assert.equal(access.historicalAt?.getTime(), patient.archivedAt?.getTime());
            else assert.ok(access.revokedAt);
        }
    }
});

test('structure update rolls back both profile and availability edits after a later insert fails', async t => {
    const availability = await auth.StructureAvailability.create({ structureId, day: 1, enabled: true, open: '08:00', close: '18:00' });
    const before = await snapshot([], [auth.Structure, auth.StructureAvailability]);
    failAfter(t, auth.StructureAvailability, 'create');
    await assert.rejects(invoke(updateStructureForTenant, { premise: { name: 'Changed structure',
        premiseAvailabilities: [{ id: availability.id, day: 1, enabled: false },
            { day: 2, enabled: true, open: '08:00', close: '18:00' }] } }, { structureId }), /injected after write/);
    assert.equal(await snapshot([], [auth.Structure, auth.StructureAvailability]), before);
});

test('structure availability update remains incremental, including an empty array', async () => {
    const count = await auth.StructureAvailability.count({ where: { structureId } });
    const result = await invoke(updateStructureForTenant, { premise: { name: 'Committed structure',
        premiseAvailabilities: [] } }, { structureId });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.name, 'Committed structure');
    assert.equal(await auth.StructureAvailability.count({ where: { structureId } }), count);
});

test('point, questionnaire and scale commits preserve all submitted answers and associations', async () => {
    const { patient, evaluation } = await evaluationFixture();
    const { parent, question, answer } = await questionnaireFixture();
    const pointResult = await invoke(createHumanBodyPoint, { ...pointInput(patient.id, evaluation.id),
        humanBodyEvents: [{ eventType: 'first' }, { eventType: 'second' }] });
    assert.equal(pointResult.status, 201);
    const pointId = pointResult.body.data.id;
    assert.equal(await HumanBodyEvent.schema(schema).count({ where: { humanBodyPointId: pointId } }), 2);
    const compiled = await invoke(saveQuestionnaireInstance, { patientId: patient.id, evaluationId: evaluation.id,
        humanBodyPointId: pointId, questionnaireId: parent.id,
        questions: [{ questionId: question.id, answerId: answer.id }, { questionId: question.id, customAnswer: 'free text' }] });
    assert.equal(compiled.status, 201);
    assert.equal(compiled.body.data.humanBodyPointId, pointId);
    const answers = await hb.HumanBodyAnswerInstance.schema(schema).findAll({
        where: { humanBodyQuestionnaireInstanceId: compiled.body.data.id } });
    assert.equal(answers.length, 2);
    assert.ok(answers.some(row => row.humanBodyAnswerId === answer.id && row.customAnswer === null));
    assert.ok(answers.some(row => row.humanBodyAnswerId === null && row.customAnswer === 'free text'));
    const scale = await invoke(saveScale, { patientId: patient.id, evaluationId: evaluation.id,
        scaleId: randomUUID(), questions: [{ questionId: randomUUID(), customAnswer: 'scale text' }] });
    assert.equal(scale.status, 201);
    assert.equal((await hb.UserAnswer.schema(schema).findOne({
        where: { userScaleInstanceId: scale.body.data.id } }))!.customAnswer, 'scale text');
});

test('questionnaire definitions preserve default answer and incremental updates, then delete their tree', async () => {
    const created = await invoke(questionnaire.saveQuestionnaire, { title: 'Compatible', questionnaires: [
        { text: 'Original', type: 'single', answers: [] }, { text: 'Retained', type: 'single', answers: [{ text: 'Yes', isCorrect: true }] }
    ] });
    assert.equal(created.status, 201);
    const id = created.body.data.id;
    const originalQuestions = await hb.HumanBodyQuestion.schema(schema).findAll({ where: { humanBodyQuestionnaireId: id } });
    assert.equal(originalQuestions.length, 2);
    const original = originalQuestions.find(row => row.text === 'Original')!;
    const defaultAnswer = (await hb.HumanBodyAnswer.schema(schema).findOne({ where: { humanBodyQuestionId: original.id } }))!;
    assert.equal(defaultAnswer.text, '');
    assert.equal(defaultAnswer.isCorrect, false);
    assert.equal((await invoke(questionnaire.updateQuestionnaireById, { questionnaire: {
        title: 'Updated', questionnaires: [{ id: original.id, text: 'Edited', type: 'single', answers: [
            { id: defaultAnswer.id, text: 'Updated default', isCorrect: true }, { text: 'Additional', isCorrect: false }
        ] }]
    } }, { questionnaireId: id })).status, 200);
    assert.equal(await hb.HumanBodyQuestion.schema(schema).count({ where: { humanBodyQuestionnaireId: id } }), 2);
    assert.equal(await hb.HumanBodyAnswer.schema(schema).count({ where: { humanBodyQuestionId: original.id } }), 2);
    assert.equal((await invoke(questionnaire.deleteQuestionnaireById, {}, { questionnaireId: id })).status, 200);
    assert.equal(await hb.HumanBodyQuestionnaire.schema(schema).findByPk(id), null);
    assert.equal(await hb.HumanBodyQuestion.schema(schema).count({ where: { humanBodyQuestionnaireId: id } }), 0);
    assert.equal(await hb.HumanBodyAnswer.schema(schema).count({ where: { humanBodyQuestionId: originalQuestions.map(row => row.id) } }), 0);
});

test('protocol template success preserves explicit and default phase/exercise ordering', async () => {
    const exercise = await catalog.Exercise.create({ name: 'Fixture ' + randomUUID() });
    publicExercises.push(exercise.id);
    const result = await invoke(saveProtocolTemplate, { name: 'Committed ' + randomUUID(), phases: [
        { name: 'First', exercises: [{ exerciseId: exercise.id, sets: 2 }] },
        { name: 'Second', order: 5, exercises: [{ exerciseId: exercise.id, order: 4 }] }
    ] });
    assert.equal(result.status, 201);
    publicTemplates.push(result.body.data.id);
    const phases = await catalog.ProtocolPhaseTemplate.findAll({ where: { protocolTemplateId: result.body.data.id }, order: [['order', 'ASC']] });
    assert.deepEqual(phases.map(row => row.order), [0, 5]);
    const prescriptions = await catalog.ProtocolTemplateExercise.findAll({
        where: { protocolPhaseTemplateId: phases.map(row => row.id) }, order: [['order', 'ASC']] });
    assert.deepEqual(prescriptions.map(row => row.order), [0, 4]);
    assert.equal(prescriptions[0].sets, 2);
});

test('missing aggregate roots still return 404 without side effects', async () => {
    const before = await snapshot([Patient, evals.Evaluation, protocols.ProtocolInstance], [auth.Structure]);
    assert.equal((await invoke(deletePatient, {}, { patientId: randomUUID() })).status, 404);
    assert.equal((await invoke(questionnaire.updateQuestionnaireById, { title: 'Missing' }, { questionnaireId: randomUUID() })).status, 404);
    assert.equal((await invoke(questionnaire.deleteQuestionnaireById, {}, { questionnaireId: randomUUID() })).status, 404);
    assert.equal((await invoke(updateStructureForTenant, { premise: { name: 'Missing' } }, { structureId: randomUUID() })).status, 404);
    assert.equal((await invoke(assignProtocol, { patientId: randomUUID(), protocolTemplateId: randomUUID() })).status, 404);
    assert.equal(await snapshot([Patient, evals.Evaluation, protocols.ProtocolInstance], [auth.Structure]), before);
});
