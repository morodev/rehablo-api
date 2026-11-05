import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sequelize } from '../../../config/database.js';
import Evaluation from '../models/evaluation.model.js';
import HumanBodyPoint from '../../human-body/models/humanBodyPoint.model.js';
import HumanBodySymptom from '../../human-body/models/humanBodySymptom.model.js';
import MetricDefinition from '../../measurements/models/catalog/metricDefinition.model.js';
import Observation from '../../measurements/models/observation.model.js';
import { resolveHumanBodyPointId } from '../../human-body/controllers/humanBodyPoint.helper.js';
import { updateSymptom, deleteSymptom } from '../../human-body/controllers/symptom.controller.js';
import { ingestObservations } from '../../measurements/services/observation.service.js';

const transaction = { LOCK: { SHARE: 'SHARE', UPDATE: 'UPDATE' } } as any;
const record = (values: Record<string, unknown>) => ({get: (key: string) => values[key], ...values});
function invoke(handler: any, req: any): Promise<{status?: number; body?: any; error?: any}> {
    return new Promise(resolve => {
        let status = 200;
        const res = {status(code: number) {status=code; return res;}, json(body: any) {resolve({status, body}); return res;}};
        handler(req, res, (error: any) => resolve({error}));
    });
}
test('point lookup refuses a point belonging to another patient', async t => {
    t.mock.method(HumanBodyPoint, 'schema', (() => ({findOne: async () => record({id:'point',userId:'actor',patientId:'other',evaluationId:null})})) as any);
    await assert.rejects(resolveHumanBodyPointId('fixture', {humanBodyPointId:'point',patientId:'patient'}, 'actor', transaction),
        (error: any) => error.statusCode===400 || error.statusCode===404);
});
test('a point retains its evaluation guard even when the caller omits evaluationId', async t => {
    t.mock.method(HumanBodyPoint, 'schema', (() => ({findOne: async () => record({id:'point',userId:'actor',patientId:'patient',evaluationId:'closed'})})) as any);
    t.mock.method(Evaluation, 'schema', (() => ({findByPk: async () => record({id:'closed',userId:'actor',patientId:'patient',status:'COMPLETED',createdAt:new Date()})})) as any);
    await assert.rejects(resolveHumanBodyPointId('fixture', {humanBodyPointId:'point',patientId:'patient'}, 'actor', transaction),
        (error: any) => error.statusCode===409);
});
for (const [name, handler] of [['update',updateSymptom],['delete',deleteSymptom]] as const) {
    test('closed evaluation blocks symptom '+name+' without a client evaluationId', async t => {
        let writes=0;
        t.mock.method(sequelize,'transaction',(async (callback: any)=>callback(transaction)) as any);
        t.mock.method(HumanBodySymptom,'schema',(()=>({
            findOne:async()=>record({id:'symptom',patientId:'patient',userId:'actor',evaluationId:'closed',humanBodyPointId:'point'}),
            findByPk:async()=>record({id:'symptom'}),
            update:async()=>{writes++;return [1];},destroy:async()=>{writes++;return 1;}
        })) as any);
        t.mock.method(Evaluation,'schema',(()=>({findByPk:async()=>record({id:'closed',patientId:'patient',userId:'actor',status:'COMPLETED',createdAt:new Date()})})) as any);
        const response=await invoke(handler,{tenantSchema:'fixture',params:{symptomId:'symptom'},body:{value:4},access:{userId:'actor',scope:'own'},user:{id:'actor'}});
        assert.equal(response.error?.statusCode,409);
        assert.equal(writes,0);
    });
}
test('missing, empty and boolean observations never become a measured zero', async t=>{
    t.mock.method(MetricDefinition,'findAll',(async()=>[record({code:'pain',unit:'score',higherIsBetter:false})]) as any);
    let written: any[]=[];
    t.mock.method(Observation,'schema',(()=>({bulkCreate:async(values:any[])=>{written=values;return values;}})) as any);
    const values=[null,undefined,'',false,0];
    const result=await ingestObservations('fixture',values.map(value=>({patientId:'patient',metricCode:'pain',value,provenance:'MANUAL'})) as any,{tenantId:'tenant',operatorId:'actor'});
    assert.equal(result.skipped.length,4);
    assert.equal(written.length,1);
    assert.equal(written[0].value,0);
});
