import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Request} from 'express';
import {sequelize} from '../../../config/database.js';
import Tenant from '../../auth/models/tenant.model.js';
import TenantUser from '../../auth/models/tenantUser.model.js';
import StructureUser from '../../auth/models/structureUser.model.js';
import User from '../../auth/models/user.model.js';
import Patient from '../../patients/models/patient.model.js';
import Evaluation from '../../evaluations/models/evaluation.model.js';
import RawFile from '../../measurements/models/rawFile.model.js';
import Observation from '../../measurements/models/observation.model.js';
import {CarePath,CarePathMember,ClinicalRecord,ClinicalOperation,ClinicalAudit,ClinicalPublication,EvaluationTemplate} from '../models/clinical.model.js';
import {createRecord,updateRecord,recordCommand,withClinicalOperation,updateTemplate} from '../services/clinical.service.js';
const userId=randomUUID(),patientId=randomUUID(),structureId=randomUUID(),pathId=randomUUID(),evaluationId=randomUUID(),programId=randomUUID(),itemId=randomUUID();
function row(data:any):any{return Object.assign(data,{get(key:any){return typeof key==='string'?this[key]:Object.fromEntries(Object.entries(this).filter(([,v])=>typeof v!=='function'));},async update(values:any){Object.assign(this,values);return this;}});}
function fixture(t:any,options:any={}){
 const req={tenantSchema:'rehablo_11111111111141118111111111111111',user:{id:userId,tid:userId,sid:structureId,actor:'staff',role:'THERAPIST'}} as Request;
 const transaction={LOCK:{SHARE:'SHARE',UPDATE:'UPDATE'}};
 const path=row({id:pathId,patientId,structureId,ownerUserId:userId,title:'Percorso',kind:'REHAB',status:'ACTIVE',version:1});
 const evaluation=row({id:evaluationId,carePathId:pathId,patientId,structureId,userId,status:options.completed?'COMPLETED':'DRAFT',createdAt:options.old?new Date(2000,0,1):new Date()});
 const records=new Map<string,any>(),observations=new Map<string,any>(),operations=new Map<string,any>(),rawFiles=new Map<string,any>();
 const program=row({id:programId,carePathId:pathId,patientId,structureId,authorUserId:userId,kind:'PROGRAM',title:'Programma',visibility:'OPERATIONAL',status:'CONFIRMED',version:2,evaluationId:null,data:{discipline:'PHYSIO',items:[{id:itemId,category:'EXERCISE',title:'Squat',sets:3,reps:8}]}});records.set(program.id,program);
 t.mock.method(sequelize,'transaction',async(work:any)=>work(transaction));t.mock.method(sequelize,'query',async()=>[[]]);
 t.mock.method(TenantUser,'findOne',async()=>row({role:options.role??'THERAPIST',deactivatedAt:null}));
 t.mock.method(StructureUser,'findOne',async()=>row({role:null}));t.mock.method(User,'findByPk',async()=>row({isActive:true,deactivatedAt:null}));
 t.mock.method(Tenant,'findByPk',async()=>row({featureFlags:{clinical:{enabled:true,medicalEnabled:true,trainingEnabled:options.trainingEnabled??true}}}));
 t.mock.method(CarePath,'schema',()=>({findOne:async()=>path}));t.mock.method(CarePathMember,'schema',()=>({findOne:async()=>row({level:'CLINICAL'})}));
 t.mock.method(Patient,'schema',()=>({findOne:async()=>row({id:patientId})}));t.mock.method(Evaluation,'schema',()=>({findByPk:async(id:string)=>id===evaluationId?evaluation:null}));
 t.mock.method(ClinicalRecord,'schema',()=>({findByPk:async(id:string)=>records.get(id)??null,findAll:async({where}:any)=>[...records.values()].filter(r=>(!where.kind||r.kind===where.kind)&&(!where.status||r.status===where.status)),create:async(data:any)=>{const value=row({id:randomUUID(),...data});records.set(value.id,value);return value;}}));
 t.mock.method(RawFile,'schema',()=>({findByPk:async(id:string)=>rawFiles.get(id)??null}));
 t.mock.method(Observation,'schema',()=>({findByPk:async(id:string)=>observations.get(id)??null,findOne:async({where}:any)=>observations.get(where.id)??null,create:async(data:any)=>{const value=row({id:randomUUID(),...data});observations.set(value.id,value);return value;}}));
 t.mock.method(ClinicalOperation,'schema',()=>({findOne:async({where}:any)=>operations.get(where.operationId)??null,create:async(data:any)=>{operations.set(data.operationId,data);return data;}}));
 t.mock.method(ClinicalAudit,'schema',()=>({create:async()=>({})}));t.mock.method(ClinicalPublication,'schema',()=>({findOne:async()=>null}));
 return {req,transaction,records,observations,rawFiles,program,evaluation};
}
test('session snapshots confirmed program and confirmation never marks unrecorded work performed',async t=>{
 const f=fixture(t);const result:any=await createRecord(f.req,pathId,'SESSION',{operationId:randomUUID(),title:'Seduta',evaluationId,visibility:'OPERATIONAL',data:{programId,results:[],programSnapshot:{items:[{id:'forged'}]}}});
 assert.equal(result.data.programSnapshot.version,2);assert.equal(result.data.programSnapshot.items[0].id,itemId);assert.deepEqual(result.data.results,[]);
 f.program.data.items[0].reps=99;assert.equal(result.data.programSnapshot.items[0].reps,8);
 const confirmed:any=await recordCommand(f.req,result.id,'SESSION','confirm',{operationId:randomUUID(),expectedVersion:1});
 assert.deepEqual(confirmed.data.results,[{itemId,status:'NOT_RECORDED'}]);assert.equal(confirmed.status,'CONFIRMED');
 await assert.rejects(updateRecord(f.req,result.id,'SESSION',{expectedVersion:2,title:'Overwrite'}),(e:any)=>e.code==='RECORD_LOCKED');
});
test('daily lock prevents creating today results in yesterday draft and completed evaluation',async t=>{
 for(const options of [{old:true},{completed:true}]){const f=fixture(t,options);
 await assert.rejects(createRecord(f.req,pathId,'SESSION',{operationId:randomUUID(),title:'Seduta',evaluationId,visibility:'OPERATIONAL',data:{programId,results:[]}}),(e:any)=>e.statusCode===409);
 assert.equal(f.records.size,1);t.mock.restoreAll();}
});
test('absent intensity creates no quantitative result, explicit zero creates one, replay creates none',async t=>{
 const f=fixture(t);const body={operationId:randomUUID(),title:'Dolore',evaluationId,data:{code:'pain',source:'PATIENT',collectionState:'NOT_COLLECTED',side:'UNKNOWN'}};
 await createRecord(f.req,pathId,'FINDING',body);assert.equal(f.observations.size,0);
 const zero={...body,operationId:randomUUID(),data:{...body.data,collectionState:'PRESENT',intensity:0}};
 const result:any=await createRecord(f.req,pathId,'FINDING',zero);assert.equal(f.observations.size,1);
 const observation=[...f.observations.values()][0];assert.equal(observation.value,0);assert.equal(observation.side,'UNSPECIFIED');
 const replay:any=await createRecord(f.req,pathId,'FINDING',zero);assert.equal(replay.id,result.id);assert.equal(f.observations.size,1);
});
test('linked imported Observation is reused and cannot be silently overwritten',async t=>{
 const f=fixture(t);const id=randomUUID();f.observations.set(id,row({id,patientId,evaluationId,operatorId:userId,value:4,provenance:'IMPORT',metadata:{}}));
 const body={operationId:randomUUID(),title:'Rilevazione',evaluationId,data:{code:'pain',source:'DEVICE',collectionState:'PRESENT',intensity:4,observationId:id}};
 const result:any=await createRecord(f.req,pathId,'FINDING',body);assert.equal(result.data.observationId,id);assert.equal(f.observations.size,1);
 await assert.rejects(createRecord(f.req,pathId,'FINDING',{...body,operationId:randomUUID(),data:{...body.data,intensity:5}}),/corrispondere/);
});
test('operation replay is deterministic and rejects reuse for a different command',async t=>{
 const f=fixture(t);const operationId=randomUUID();let calls=0;const run=async()=>({id:++calls});
 assert.deepEqual(await withClinicalOperation(f.req,operationId,'create',{value:1},f.transaction as any,run),{id:1});
 assert.deepEqual(await withClinicalOperation(f.req,operationId,'create',{value:1},f.transaction as any,run),{id:1});
 await assert.rejects(withClinicalOperation(f.req,operationId,'create',{value:2},f.transaction as any,run),(e:any)=>e.code==='OPERATION_CONFLICT');assert.equal(calls,1);
});
test('PT operations remain gated even inside a rehabilitation path',async t=>{
 const f=fixture(t,{role:'PERSONAL_TRAINER',trainingEnabled:false});await assert.rejects(createRecord(f.req,pathId,'PROGRAM',{operationId:randomUUID(),title:'Allenamento',visibility:'OPERATIONAL',data:{discipline:'PT',items:[]}}),(e:any)=>e.code==='FEATURE_DISABLED');
});
test('document review preserves original storage metadata and forbids caller metadata injection',async t=>{
 const f=fixture(t);const id=randomUUID(),rawId=randomUUID();
 f.rawFiles.set(rawId,row({id:rawId,tenantId:userId,uploadedBy:userId,originalName:'documento.pdf',mimeType:'application/pdf',sizeBytes:123,checksumSha256:'original'}));
 f.records.set(id,row({id,carePathId:pathId,patientId,structureId,authorUserId:userId,kind:'DOCUMENT',title:'Documento',status:'DRAFT',visibility:'CLINICAL',version:1,evaluationId:null,data:{rawFileId:rawId,documentType:'DOCUMENT',reviewStatus:'UNREAD',fileName:'documento.pdf',mimeType:'application/pdf',sizeBytes:123,checksumSha256:'original'}}));
 const saved:any=await updateRecord(f.req,id,'DOCUMENT',{expectedVersion:1,data:{reviewStatus:'READ'}});
 assert.equal(saved.data.fileName,'documento.pdf');assert.equal(saved.data.checksumSha256,'original');assert.equal(saved.data.reviewStatus,'READ');
 await assert.rejects(updateRecord(f.req,id,'DOCUMENT',{expectedVersion:2,data:{checksumSha256:'forged'}}),/Campi non ammessi/);
});

test('published templates cannot be rewritten through archive and command replay preserves one version',async t=>{
 const f=fixture(t);const template=row({id:randomUUID(),ownerUserId:userId,structureId,name:'Modello',scope:'PERSONAL',status:'PUBLISHED',version:2,data:{items:[{code:'pain',group:'SYMPTOMS',label:'Dolore',visibility:'PRIMARY',order:0,fields:[]}]}});
 t.mock.method(EvaluationTemplate,'schema',()=>({findOne:async()=>template}));
 await assert.rejects(updateTemplate(f.req,template.id,{operationId:randomUUID(),expectedVersion:2,data:{items:[]}},'archive'),/Modifica prima/);
 assert.equal(template.data.items.length,1);
 const command={operationId:randomUUID(),expectedVersion:2};await updateTemplate(f.req,template.id,command,'archive');await updateTemplate(f.req,template.id,command,'archive');assert.equal(template.version,3);assert.equal(template.data.items.length,1);
});
test('program revision creates a new draft without changing the confirmed source',async t=>{
 const f=fixture(t);const revision:any=await recordCommand(f.req,programId,'PROGRAM','revise',{operationId:randomUUID(),expectedVersion:2});
 assert.notEqual(revision.id,programId);assert.equal(revision.parentId,programId);assert.equal(revision.status,'DRAFT');assert.equal(f.program.status,'CONFIRMED');assert.equal(f.program.version,2);
});

test('cancelling a draft finding retains but withdraws its generated quantitative observation',async t=>{
 const f=fixture(t);const created:any=await createRecord(f.req,pathId,'FINDING',{operationId:randomUUID(),title:'Dolore',evaluationId,data:{code:'pain',source:'PATIENT',collectionState:'PRESENT',intensity:3}});
 await recordCommand(f.req,created.id,'FINDING','cancel',{operationId:randomUUID(),expectedVersion:1});
 assert.equal(f.observations.size,1);const original=[...f.observations.values()][0];assert.equal(original.value,3);assert.equal(original.quality,'INVALID');assert.equal(original.metadata.withdrawnReason,'FINDING_CANCELLED');
});
