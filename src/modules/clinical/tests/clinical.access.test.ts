import test from 'node:test';
import assert from 'node:assert/strict';
import type {Request} from 'express';
import Tenant from '../../auth/models/tenant.model.js';
import TenantUser from '../../auth/models/tenantUser.model.js';
import StructureUser from '../../auth/models/structureUser.model.js';
import User from '../../auth/models/user.model.js';
import Patient from '../../patients/models/patient.model.js';
import Evaluation from '../../evaluations/models/evaluation.model.js';
import {CarePath,CarePathMember,ClinicalRecord} from '../models/clinical.model.js';
import {loadClinicalPath,loadClinicalRecord,getClinicalCapabilities,assertClinicalWrite,assertClinicalEvaluationContext} from '../services/clinical.service.js';
const id='11111111-1111-4111-8111-111111111111',patientId='22222222-2222-4222-8222-222222222222',structureId='33333333-3333-4333-8333-333333333333';
function row(data:any){return {...data,get(key:any){return typeof key==='string'?this[key]:data;}};}
function fixture(t:any,options:any={}){
 const req={tenantSchema:'rehablo_111111111111411181111111111111',user:{id,tid:id,sid:structureId,actor:'staff',role:'THERAPIST',tenants:[{id}]}} as Request;
 const path=row({id,patientId,structureId,ownerUserId:options.owner??id,title:'Percorso',kind:'REHAB',status:options.status??'ACTIVE',version:1});
 t.mock.method(TenantUser,'findOne',async()=>options.revokedTenant?null:row({role:options.role??'THERAPIST',deactivatedAt:null}));
 t.mock.method(StructureUser,'findOne',async()=>options.missingStructure?null:row({role:null}));
 t.mock.method(User,'findByPk',async()=>row({isActive:true,deactivatedAt:null}));
 t.mock.method(Tenant,'findByPk',async()=>row({featureFlags:{clinical:{enabled:options.enabled??false,medicalEnabled:false,trainingEnabled:false}}}));
 t.mock.method(CarePath,'schema',()=>({findOne:async({where}:any)=>where.structureId===structureId?path:null}));
 t.mock.method(CarePathMember,'schema',()=>({findOne:async()=>options.revokedPath?null:row({level:options.level??'CLINICAL',revokedAt:null})}));
 t.mock.method(Patient,'schema',()=>({findOne:async({where}:any)=>where.id===patientId&&where.structureId===structureId?row({id:patientId}):null}));
 return {req,path};
}
test('disabled feature keeps authorized historical reads but prevents writes',async t=>{
 const {req}=fixture(t);const access=await loadClinicalPath(req,id);assert.equal(access.level,'CLINICAL');
 await assert.rejects(assertClinicalWrite(req,access),(e:any)=>e.code==='FEATURE_DISABLED');
 assert.equal((await getClinicalCapabilities(req)).enabled,false);
});
test('revoked path membership blocks owner access too',async t=>{
 const {req}=fixture(t,{revokedPath:true});await assert.rejects(loadClinicalPath(req,id),(e:any)=>e.statusCode===404);
});
test('active token does not bypass revoked tenant membership',async t=>{
 const {req}=fixture(t,{revokedTenant:true});await assert.rejects(loadClinicalPath(req,id),(e:any)=>e.statusCode===403);
});
test('structure membership is rechecked rather than trusting selected context claim',async t=>{
 const {req}=fixture(t,{missingStructure:true});await assert.rejects(loadClinicalPath(req,id),(e:any)=>e.statusCode===403);
});
test('PT membership marked clinical is still reduced to operational',async t=>{
 const {req}=fixture(t,{role:'PERSONAL_TRAINER'});assert.equal((await loadClinicalPath(req,id)).level,'OPERATIONAL');
});
test('secretary cannot obtain clinical access through a stale therapist token',async t=>{
 const {req}=fixture(t,{role:'SECRETARY'});await assert.rejects(loadClinicalPath(req,id),(e:any)=>e.statusCode===403);
});
test('suspended path permits history but forbids new clinical writes',async t=>{
 const {req}=fixture(t,{enabled:true,status:'SUSPENDED'});const access=await loadClinicalPath(req,id);
 await assert.rejects(assertClinicalWrite(req,access),(e:any)=>e.code==='PATH_NOT_ACTIVE');
});
test('other professional draft is not disclosed by a record identifier',async t=>{
 const {req}=fixture(t);
 t.mock.method(ClinicalRecord,'schema',()=>({findByPk:async()=>row({id,carePathId:id,authorUserId:patientId,visibility:'CLINICAL',status:'DRAFT',evaluationId:null})}));
 await assert.rejects(loadClinicalRecord(req,id),(e:any)=>e.statusCode===404);
});
test('confirmed evaluation contributes readable history without changing authorship',async t=>{
 const {req}=fixture(t);
 t.mock.method(ClinicalRecord,'schema',()=>({findByPk:async()=>row({id,carePathId:id,authorUserId:patientId,visibility:'CLINICAL',status:'DRAFT',evaluationId:structureId})}));
 t.mock.method(Evaluation,'schema',()=>({findByPk:async()=>row({status:'COMPLETED'})}));
 const result=await loadClinicalRecord(req,id);assert.equal(result.record.authorUserId,patientId);
});
test('legacy evaluations without path remain independent from clinical feature flags',async()=>{
 const result=await assertClinicalEvaluationContext({} as Request,{patientId});
 assert.deepEqual(result,{carePathId:null,templateVersionId:null,configurationSnapshot:null,clinicalVisibility:null});
});
test('path identity must match the patient when creating an evaluation',async t=>{
 const {req}=fixture(t,{enabled:true});
 await assert.rejects(assertClinicalEvaluationContext(req,{patientId:id,carePathId:id}),/non corrispondono/);
});

test('membership downgrade removes access to own earlier clinical records',async t=>{
 const {req}=fixture(t,{level:'OPERATIONAL'});
 t.mock.method(ClinicalRecord,'schema',()=>({findByPk:async()=>row({id,carePathId:id,authorUserId:id,visibility:'CLINICAL',status:'CONFIRMED',evaluationId:null})}));
 await assert.rejects(loadClinicalRecord(req,id),(e:any)=>e.statusCode===404);
});
test('enable then disable restores read-only history without changing ordinary no-path context',async t=>{
 const options={enabled:false};const {req}=fixture(t,options);const access=await loadClinicalPath(req,id);
 await assert.rejects(assertClinicalWrite(req,access),(e:any)=>e.code==='FEATURE_DISABLED');
 options.enabled=true;await assertClinicalWrite(req,access);
 options.enabled=false;await assert.rejects(assertClinicalWrite(req,access),(e:any)=>e.code==='FEATURE_DISABLED');
 assert.equal((await loadClinicalPath(req,id)).path.id,id);
 assert.deepEqual(await assertClinicalEvaluationContext(req,{patientId}),{carePathId:null,templateVersionId:null,configurationSnapshot:null,clinicalVisibility:null});
});

test('operational membership cannot read medical documents even if a legacy row is mislabeled',async t=>{
 const {req}=fixture(t,{level:'OPERATIONAL'});
 t.mock.method(ClinicalRecord,'schema',()=>({findByPk:async()=>row({id,carePathId:id,kind:'REPORT',authorUserId:id,visibility:'OPERATIONAL',status:'CONFIRMED',evaluationId:null})}));
 await assert.rejects(loadClinicalRecord(req,id),(e:any)=>e.statusCode===404);
});

test('completing an evaluation does not expose another professional cancelled draft',async t=>{
 const {req}=fixture(t);
 t.mock.method(ClinicalRecord,'schema',()=>({findByPk:async()=>row({id,carePathId:id,kind:'FINDING',authorUserId:patientId,visibility:'CLINICAL',status:'CANCELLED',evaluationId:structureId})}));
 t.mock.method(Evaluation,'schema',()=>({findByPk:async()=>row({status:'COMPLETED'})}));
 await assert.rejects(loadClinicalRecord(req,id),(e:any)=>e.statusCode===404);
});
