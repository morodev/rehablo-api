import {areaSymptomSnapshot} from '../../human-body/controllers/area.controller.js';
import {cloneEvaluation} from '../services/evaluationClone.js';
import {HumanBodyArea,HumanBodyArticularity,HumanBodyStrength,HumanBodyQuestionnaireInstance,HumanBodyAnswerInstance,UserScaleInstance,UserAnswer,TestInstance} from '../models/index.js';
import HumanBodyEvent from '../../human-body/models/humanBodyEvent.model.js';
import HumanBodySymptom from '../../human-body/models/humanBodySymptom.model.js';
import {ingestObservations} from '../../measurements/services/observation.service.js';
import {deleteClinicalRecord} from '../services/clinicalRecordMutations.js';

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sequelize} from '../../../config/database.js';
import Evaluation from '../models/evaluation.model.js';
import Patient from '../../patients/models/patient.model.js';
import Tenant from '../../auth/models/tenant.model.js';
import TenantUser from '../../auth/models/tenantUser.model.js';
import StructureUser from '../../auth/models/structureUser.model.js';
import User from '../../auth/models/user.model.js';
import HumanBodyPoint from '../../human-body/models/humanBodyPoint.model.js';
import Observation from '../../measurements/models/observation.model.js';
import MetricDefinition from '../../measurements/models/catalog/metricDefinition.model.js';
import RawFile from '../../measurements/models/rawFile.model.js';
import {CarePath,CarePathMember,ClinicalRecord,EvaluationPreference} from '../../clinical/models/clinical.model.js';
import {evaluationCapabilities} from '../services/evaluationGuard.js';
import {assertClinicalWriteContext,clinicalChanges} from '../services/clinicalWriteGuard.js';
import {visibleClinicalRows,assertClinicalEvaluationRead,clinicalEvaluationCapabilities} from '../services/clinicalReadGuard.js';
import {reassessEvaluation,createEvaluation} from '../controllers/evaluation.controller.js';
import {authorizedIngestion} from '../../measurements/services/authorizedIngestion.service.js';
import {download} from '../../measurements/controllers/rawFile.controller.js';
import {localStorageAdapter} from '../../measurements/storage/localStorageAdapter.js';

const ids={actor:'10000000-0000-4000-8000-000000000001',peer:'10000000-0000-4000-8000-000000000002',patient:'10000000-0000-4000-8000-000000000003',structure:'10000000-0000-4000-8000-000000000004',tenant:'10000000-0000-4000-8000-000000000005',path:'10000000-0000-4000-8000-000000000006',evaluation:'10000000-0000-4000-8000-000000000007',document:'10000000-0000-4000-8000-000000000008'};
const transaction={LOCK:{SHARE:'SHARE',UPDATE:'UPDATE'}} as any;
const row=(v:any)=>({...v,get:(key:any)=>typeof key==='string'?v[key]:{...v}});
const request=(extra:any={})=>({tenantSchema:'fixture',user:{id:ids.actor,tid:ids.tenant,tenants:[{id:ids.tenant}],sid:ids.structure,perms:['evaluation:read:own','evaluation:create:own','evaluation:update:own']},access:{userId:ids.actor,scope:'own',structureId:ids.structure},body:{},params:{},...extra} as any);
const evaluation=(v:any={})=>row({id:ids.evaluation,patientId:ids.patient,userId:ids.actor,structureId:ids.structure,carePathId:null,status:'DRAFT',createdAt:new Date(),...v});
function invoke(handler:any,req:any):Promise<any>{return new Promise(resolve=>{let status=200;const res={status(n:number){status=n;return res;},json(body:any){resolve({status,body});return res;},setHeader(){return res;},send(body:any){resolve({status,body});return res;}};handler(req,res,(error:any)=>resolve({error}));});}
function context(t:any,{revoked=false,level='CLINICAL',enabled=true,role='THERAPIST'}={}){
 t.mock.method(TenantUser,'findOne',async()=>row({role}));
 t.mock.method(StructureUser,'findOne',async()=>row({role}));
 t.mock.method(User,'findByPk',async()=>row({isActive:true,deactivatedAt:null}));
 t.mock.method(Tenant,'findByPk',async()=>row({featureFlags:{clinical:{enabled,trainingEnabled:enabled}}}));
 t.mock.method(Patient,'schema',()=>({findOne:async()=>row({id:ids.patient,structureId:ids.structure})}));
 t.mock.method(CarePath,'schema',()=>({findOne:async()=>row({id:ids.path,patientId:ids.patient,structureId:ids.structure,status:'ACTIVE',kind:'REHAB',ownerUserId:ids.actor})}));
 t.mock.method(CarePathMember,'schema',()=>({findOne:async()=>revoked?null:row({level})}));
 t.mock.method(EvaluationPreference,'schema',()=>({findOne:async()=>null}));
}
test('daily capabilities use creation day and preserve real zero-free context',()=>{
 const yesterday=new Date();yesterday.setDate(yesterday.getDate()-1);
 assert.equal(evaluationCapabilities(evaluation({date:new Date(),createdAt:yesterday}) as any,request()).lockReason,'DAY_EXPIRED');
 assert.equal(evaluationCapabilities(evaluation({status:'COMPLETED'}) as any,request()).lockReason,'COMPLETED');
 assert.equal(evaluationCapabilities(evaluation({userId:ids.peer}) as any,request()).canEdit,false);
 assert.equal(evaluationCapabilities(evaluation() as any,request()).canEdit,true);
});
test('partial clinical update cannot change patient or evaluation, but accepts identical legacy identifiers',()=>{
 const existing=evaluation({value:0});
 assert.throws(()=>clinicalChanges({patientId:ids.peer,value:1},['value'],existing as any));
 assert.deepEqual(clinicalChanges({patientId:ids.patient,evaluationId:null,value:0},['value'],existing as any),{value:0});
});
test('evaluation and patient chain rejects mismatch before any child save',async t=>{
 t.mock.method(Evaluation,'schema',(()=>({findByPk:async()=>evaluation({patientId:ids.peer})})) as any);
 await assert.rejects(assertClinicalWriteContext(request(),{patientId:ids.patient,evaluationId:ids.evaluation},transaction),(e:any)=>e.statusCode===400);
});
test('revoked membership hides a path evaluation through the legacy read helper',async t=>{
 context(t,{revoked:true});
 const linked=evaluation({carePathId:ids.path});
 t.mock.method(Evaluation,'schema',(()=>({findByPk:async()=>linked})) as any);
 const visible=await visibleClinicalRows(request(),[row({evaluationId:ids.evaluation,value:4}),row({value:0})]);assert.equal(visible.length,1);assert.equal(visible[0].value,0);
 await assert.rejects(assertClinicalEvaluationRead(request(),linked),(e:any)=>e.statusCode===404);
});
test('flag off retains authorized historical reads but disables edit and reassess',async t=>{
 context(t,{enabled:false});
 const linked=evaluation({carePathId:ids.path});
 await assertClinicalEvaluationRead(request(),linked);
 assert.deepEqual(await clinicalEvaluationCapabilities(request(),linked as any),{canEdit:false,canReassess:false,lockReason:'FEATURE_DISABLED'});
 t.mock.method(Evaluation,'schema',(()=>({findByPk:async()=>linked})) as any);
 await assert.rejects(assertClinicalWriteContext(request(),{patientId:ids.patient,evaluationId:ids.evaluation},transaction),(e:any)=>e.statusCode===409);
});
test('operational membership cannot inspect peer completed evaluation; clinical membership can',async t=>{
 context(t,{level:'OPERATIONAL',role:'PERSONAL_TRAINER'});
 await assert.rejects(assertClinicalEvaluationRead(request(),evaluation({carePathId:ids.path,userId:ids.peer,status:'COMPLETED'})),(e:any)=>e.statusCode===404);
 await assert.rejects(assertClinicalEvaluationRead(request(),evaluation({carePathId:ids.path})),(e:any)=>e.statusCode===404);
 await assertClinicalEvaluationRead(request(),evaluation({carePathId:ids.path,clinicalVisibility:'OPERATIONAL'}));
});
test('reassessment preserves setup references and leaves all outcomes empty',async t=>{
 context(t);
 const snapshot={sections:[{id:'rom',enabled:true}]};
 const source=evaluation({carePathId:ids.path,status:'COMPLETED',notes:'old conclusion',title:'Knee',templateVersionId:'template',configurationSnapshot:snapshot,publishedToPatient:true});
 let saved:any;let writes=0;
 t.mock.method(sequelize,'transaction',(async(callback:any)=>callback(transaction)) as any);
 t.mock.method(Evaluation,'schema',(()=>({findOne:async()=>source,create:async(data:any,options:any)=>{assert.equal(options.transaction,transaction);saved=data;writes++;return evaluation(data);}})) as any);
 const response=await invoke(reassessEvaluation,request({params:{evaluationId:ids.evaluation}}));
 assert.equal(response.status,201);assert.equal(writes,1);assert.equal(saved.parentEvaluationId,source.id);
 assert.equal(saved.notes,null);assert.equal(saved.status,'DRAFT');assert.equal(saved.publishedToPatient,false);
 assert.equal(saved.templateVersionId,'template');assert.deepEqual(saved.configurationSnapshot,snapshot);assert.equal(saved.carePathId,ids.path);
 for(const key of ['symptoms','observations','answers','isPositive','value','diagnosis'])assert.equal(key in saved,false);
 assert.equal(source.notes,'old conclusion');assert.equal(source.status,'COMPLETED');
});
test('ingestion checks every patient before writing any measure',async t=>{
 t.mock.method(sequelize,'transaction',(async(callback:any)=>callback(transaction)) as any);
 let writes=0;
 t.mock.method(Patient,'schema',(()=>({findOne:async({where}:any)=>where.id===ids.patient?row({id:ids.patient}):null})) as any);
 t.mock.method(Observation,'schema',(()=>({bulkCreate:async()=>{writes++;return [];}})) as any);
 await assert.rejects(authorizedIngestion(request(),[{patientId:ids.patient,value:0,metricCode:'pain',provenance:'MANUAL'},{patientId:ids.peer,value:1,metricCode:'pain',provenance:'MANUAL'}]),(e:any)=>e.statusCode===404);
 assert.equal(writes,0);
});
test('idempotent ingestion creates once, replays once and rejects changed content',async t=>{
 t.mock.method(sequelize,'transaction',(async(callback:any)=>callback(transaction)) as any);
 t.mock.method(sequelize,'query',(async()=>[]) as any);
 t.mock.method(Patient,'schema',(()=>({findOne:async()=>row({id:ids.patient})})) as any);
 t.mock.method(MetricDefinition,'findAll',(async()=>[row({code:'pain',unit:'score',higherIsBetter:false})]) as any);
 let stored:any[]=[];let writes=0;
 t.mock.method(Observation,'schema',(()=>({findAll:async()=>stored,bulkCreate:async(values:any[],options:any)=>{assert.equal(options.transaction,transaction);writes++;stored=values.map(row);return stored;}})) as any);
 const inputs=[{patientId:ids.patient,metricCode:'pain',value:0,provenance:'MANUAL' as const}];
 assert.equal((await authorizedIngestion(request(),inputs,{operationId:'retry'})).replayed,false);
 assert.equal((await authorizedIngestion(request(),inputs,{operationId:'retry'})).replayed,true);
 await assert.rejects(authorizedIngestion(request(),[{...inputs[0],value:1}],{operationId:'retry'}),(e:any)=>e.statusCode===409);
 assert.equal(writes,1);
});
test('input metadata cannot forge an ingestion receipt',async t=>{
 t.mock.method(sequelize,'transaction',(async(callback:any)=>callback(transaction)) as any);
 t.mock.method(Patient,'schema',(()=>({findOne:async()=>row({id:ids.patient})})) as any);
 t.mock.method(MetricDefinition,'findAll',(async()=>[row({code:'pain',unit:'score'})]) as any);
 let saved:any;
 t.mock.method(Observation,'schema',(()=>({bulkCreate:async(values:any[])=>{saved=values[0];return values;}})) as any);
 await authorizedIngestion(request(),[{patientId:ids.patient,metricCode:'pain',value:0,provenance:'MANUAL',metadata:{ingestionOperationId:'spoof',ingestionFingerprint:'spoof',device:'original'}}]);
 assert.deepEqual(saved.metadata,{device:'original'});
});
test('raw document download checks live path membership even for its uploader',async t=>{
 context(t,{revoked:true});
 t.mock.method(RawFile,'schema',(()=>({findByPk:async()=>row({id:'file',uploadedBy:ids.actor,storagePath:'unused'})})) as any);
 const document=row({id:ids.document,carePathId:ids.path,kind:'DOCUMENT',authorUserId:ids.actor,status:'CONFIRMED',visibility:'CLINICAL'});
 t.mock.method(ClinicalRecord,'schema',(()=>({findAll:async()=>[document],findByPk:async()=>document})) as any);
 let reads=0;t.mock.method(localStorageAdapter,'read',async()=>{reads++;return Buffer.from('secret');});
 const result=await invoke(download,request({params:{id:'file'}}));
 assert.equal(result.status,404);assert.equal(reads,0);
});

test('point and its events stay in the same transaction as the failing import',async t=>{
 let committed=false;let rolledBack=false;let pointWrites=0;let eventWrites=0;
 t.mock.method(sequelize,'transaction',(async(callback:any)=>{try{const result=await callback(transaction);committed=true;return result;}catch(error){rolledBack=true;throw error;}}) as any);
 t.mock.method(Patient,'schema',(()=>({findOne:async()=>row({id:ids.patient})})) as any);
 t.mock.method(MetricDefinition,'findAll',(async()=>[row({code:'pain',unit:'score'})]) as any);
 const point=row({id:'point',patientId:ids.patient,userId:ids.actor,evaluationId:null});
 t.mock.method(HumanBodyPoint,'schema',(()=>({
 create:async(_values:any,options:any)=>{assert.equal(options.transaction,transaction);pointWrites++;return point;},
 findByPk:async()=>point,findOne:async()=>point
 })) as any);
 t.mock.method(HumanBodyEvent,'schema',(()=>({bulkCreate:async(values:any[],options:any)=>{assert.equal(options.transaction,transaction);assert.equal(values[0].humanBodyPointId,'point');eventWrites++;return [];}})) as any);
 await assert.rejects(authorizedIngestion(request(),[{patientId:ids.patient,metricCode:'pain',value:null,provenance:'CSV_IMPORT'}] as any,{pointToCreate:{patientId:ids.patient,humanBodyEvents:[{eventType:'DEVICE'}]}}),(e:any)=>e.statusCode===400);
 assert.equal(pointWrites,1);assert.equal(eventWrites,1);assert.equal(committed,false);assert.equal(rolledBack,true);
});
test('explicit unspecified side is preserved while legacy omitted side remains bilateral',async t=>{
 t.mock.method(MetricDefinition,'findAll',(async()=>[row({code:'pain',unit:'score'})]) as any);
 let saved:any[]=[];
 t.mock.method(Observation,'schema',(()=>({bulkCreate:async(values:any[])=>{saved=values;return values;}})) as any);
 await ingestObservations('fixture',[{patientId:ids.patient,metricCode:'pain',value:0,side:'UNSPECIFIED',provenance:'MANUAL'},{patientId:ids.patient,metricCode:'pain',value:0,provenance:'MANUAL'}],{tenantId:ids.tenant,operatorId:ids.actor});
 assert.deepEqual(saved.map(x=>x.side),['UNSPECIFIED','BILATERAL']);
});
test('a legacy point with a mismatched closed child cannot cascade-delete clinical history',async t=>{
 t.mock.method(TestInstance,'schema',(()=>({count:async()=>0})) as any);
 t.mock.method(UserScaleInstance,'schema',(()=>({count:async()=>0})) as any);
 t.mock.method(sequelize,'transaction',(async(callback:any)=>callback(transaction)) as any);
 t.mock.method(Patient,'schema',(()=>({findOne:async()=>row({id:ids.patient})})) as any);
 let deleted=false;
 const point=row({id:'point',patientId:ids.patient,userId:ids.actor,evaluationId:null});
 t.mock.method(HumanBodyPoint,'schema',(()=>({findOne:async()=>point,destroy:async()=>{deleted=true;}})) as any);
 t.mock.method(HumanBodySymptom,'schema',(()=>({findAll:async()=>[row({id:'symptom',patientId:ids.patient,userId:ids.actor,humanBodyPointId:'point',evaluationId:ids.evaluation})]})) as any);
 t.mock.method(Evaluation,'schema',(()=>({findByPk:async()=>evaluation({status:'COMPLETED'})})) as any);
 await assert.rejects(deleteClinicalRecord(request(),HumanBodyPoint,'point'));
 assert.equal(deleted,false);
});
test('raw measurement download cannot bypass revoked path membership via uploader ownership',async t=>{
 context(t,{revoked:true});
 t.mock.method(RawFile,'schema',(()=>({findByPk:async()=>row({id:'file',uploadedBy:ids.actor,storagePath:'unused'})})) as any);
 t.mock.method(ClinicalRecord,'schema',(()=>({findAll:async()=>[]})) as any);
 const observation=row({id:'observation',evaluationId:ids.evaluation,patientId:ids.patient,operatorId:ids.actor});
 t.mock.method(Observation,'schema',(()=>({findOne:async()=>observation,findAll:async()=>[observation]})) as any);
 t.mock.method(Evaluation,'schema',(()=>({findByPk:async()=>evaluation({carePathId:ids.path})})) as any);
 let reads=0;t.mock.method(localStorageAdapter,'read',async()=>{reads++;return Buffer.from('secret');});
 const result=await invoke(download,request({params:{id:'file'}}));assert.equal(result.status,404);assert.equal(reads,0);
});

test('area symptom snapshot preserves measured zero and missing values without private identifiers',()=>{
 const snapshot=areaSymptomSnapshot({symptom:'PAIN',value:0,morningValue:null,date:'2026-01-02',patientId:'forged',evaluationId:'forged'});
 assert.equal(snapshot?.value,0);assert.equal(snapshot?.morningValue,null);assert.equal(snapshot?.afternoonValue,null);
 assert.equal(snapshot?.patientId,undefined);assert.equal(snapshot?.evaluationId,undefined);
 assert.throws(()=>areaSymptomSnapshot({value:false}));assert.throws(()=>areaSymptomSnapshot({value:''}));
});
test('legacy clone copies results unchanged while reassessment remains a separate operation',async t=>{
 const source=evaluation({status:'COMPLETED',notes:'Old conclusion',configurationSnapshot:{sections:['pain']}});
 const saved:Record<string,any[]>={};
 const models=[HumanBodyArea,HumanBodyPoint,HumanBodySymptom,HumanBodyArticularity,HumanBodyStrength,HumanBodyQuestionnaireInstance,HumanBodyAnswerInstance,UserScaleInstance,UserAnswer,TestInstance,Observation,HumanBodyEvent];
 for(const model of models)t.mock.method(model,'schema',(()=>({
   findAll:async()=>model===HumanBodySymptom?[row({id:'symptom',evaluationId:ids.evaluation,patientId:ids.patient,userId:ids.actor,value:0,morningValue:null})]:[],
   create:async(data:any,options:any)=>{assert.equal(options.transaction,transaction);(saved[model.name]??=[]).push(data);return row({...data,id:'copy-'+model.name});}
 })) as any);
 t.mock.method(Evaluation,'schema',(()=>({findByPk:async()=>source,create:async(data:any)=>{saved.Evaluation=[data];return row({...data,id:'copy-evaluation'});}})) as any);
 await cloneEvaluation('fixture',ids.evaluation,{userId:ids.actor},transaction);
 const symptom=saved[HumanBodySymptom.name][0];
 assert.equal(symptom.value,0);assert.equal(symptom.morningValue,null);assert.equal(symptom.evaluationId,'copy-evaluation');
 assert.equal(saved.Evaluation[0].notes,'Old conclusion');assert.deepEqual(saved.Evaluation[0].configurationSnapshot,{sections:['pain']});
 assert.equal(source.status,'COMPLETED');
});

test('identical ISO timestamps in legacy update payloads do not reparent or reject a clinical record',()=>{
 const createdAt=new Date('2026-01-02T08:09:10.000Z');
 assert.deepEqual(clinicalChanges({createdAt:createdAt.toISOString(),value:0},['value'],row({createdAt}) as any),{value:0});
});
test('reassessment uses read access to a completed colleague evaluation and owns the empty result',async t=>{
 context(t);
 const source=evaluation({carePathId:ids.path,userId:ids.peer,status:'COMPLETED'});
 t.mock.method(sequelize,'transaction',(async(callback:any)=>callback(transaction)) as any);
 let saved:any;
 t.mock.method(Evaluation,'schema',(()=>({findOne:async({where}:any)=>{assert.equal(where.structureId,ids.structure);assert.equal(where.userId,undefined);return source;},create:async(data:any)=>{saved=data;return evaluation(data);}})) as any);
 const req=request({params:{evaluationId:ids.evaluation}});
 req.user.perms=['evaluation:read:structure','evaluation:create:own','evaluation:update:own'];
 const result=await invoke(reassessEvaluation,req);
 assert.equal(result.status,201);assert.equal(saved.userId,ids.actor);assert.equal(saved.notes,null);
});

test('ordinary evaluation creation still works without touching feature flags or clinical-path membership',async t=>{
 t.mock.method(sequelize,'transaction',(async(callback:any)=>callback(transaction)) as any);
 t.mock.method(Patient,'schema',(()=>({findOne:async()=>row({id:ids.patient,structureId:ids.structure})})) as any);
 t.mock.method(Tenant,'findByPk',(async()=>{throw new Error('Legacy creation must not require the new feature');}) as any);
 let saved:any;
 t.mock.method(Evaluation,'schema',(()=>({create:async(data:any,options:any)=>{assert.equal(options.transaction,transaction);saved=data;return evaluation(data);}})) as any);
 const result=await invoke(createEvaluation,request({body:{patientId:ids.patient,title:'Legacy'}}));
 assert.equal(result.status,201);assert.equal(saved.status,'DRAFT');assert.equal(saved.title,'Legacy');assert.equal(saved.notes,null);assert.equal(saved.carePathId,undefined);
});
test('deletion of a point with compiled scales returns a conservative conflict',async t=>{
 t.mock.method(TestInstance,'schema',(()=>({count:async()=>0})) as any);
 t.mock.method(sequelize,'transaction',(async(callback:any)=>callback(transaction)) as any);
 t.mock.method(Patient,'schema',(()=>({findOne:async()=>row({id:ids.patient})})) as any);
 let deleted=false;t.mock.method(HumanBodyPoint,'schema',(()=>({findOne:async()=>row({id:'point',patientId:ids.patient,userId:ids.actor,evaluationId:null}),destroy:async()=>{deleted=true;}})) as any);
 t.mock.method(UserScaleInstance,'schema',(()=>({count:async()=>1})) as any);
 await assert.rejects(deleteClinicalRecord(request(),HumanBodyPoint,'point'),(error:any)=>error.statusCode===409);
 assert.equal(deleted,false);
});
