
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import media from '../routes/clinicalMedia.routes.js';
import portal from '../routes/clinicalPortal.routes.js';
import {sequelize} from '../../../config/database.js';
import Tenant from '../../auth/models/tenant.model.js';
import TenantUser from '../../auth/models/tenantUser.model.js';
import StructureUser from '../../auth/models/structureUser.model.js';
import User from '../../auth/models/user.model.js';
import PatientPortalAccess from '../../auth/models/patientPortalAccess.model.js';
import Patient from '../../patients/models/patient.model.js';
import Evaluation from '../../evaluations/models/evaluation.model.js';
import RawFile from '../../measurements/models/rawFile.model.js';
import {localStorageAdapter} from '../../measurements/storage/localStorageAdapter.js';
import {CarePath,CarePathMember,ClinicalRecord,ClinicalOperation,ClinicalAudit,ClinicalPublication,ClinicalHomeFeedback} from '../models/clinical.model.js';

const ids={actor:'20000000-0000-4000-8000-000000000001',patient:'20000000-0000-4000-8000-000000000002',path:'20000000-0000-4000-8000-000000000003',record:'20000000-0000-4000-8000-000000000004',operation:'20000000-0000-4000-8000-000000000005',tenant:'20000000-0000-4000-8000-000000000006',structure:'20000000-0000-4000-8000-000000000007',evaluation:'20000000-0000-4000-8000-000000000008',access:'20000000-0000-4000-8000-000000000009'};
const transaction={LOCK:{SHARE:'SHARE',UPDATE:'UPDATE'}} as any;
const row=(v:any)=>({...v,get:(key:any)=>typeof key==='string'?v[key]:{...v}});
const buffer=Buffer.from('%PDF-fixture');
function invoke(router:any,path:string,method:string,req:any,failResponse=false):Promise<any>{
 const handler=router.stack.find((x:any)=>x.route?.path===path&&x.route?.methods[method]).route.stack.at(-1).handle;
 return new Promise(resolve=>{let status=200;const res={status(n:number){status=n;return res;},json(body:any){if(failResponse)throw new Error('Connection closed after commit');resolve({status,body});return res;}};handler(req,res,(error:any)=>resolve({error}));});
}
function uploadRequest(){return {tenantSchema:'fixture',user:{id:ids.actor,tid:ids.tenant,sid:ids.structure},params:{pathId:ids.path},body:{operationId:ids.operation,title:'Document'},file:{buffer,originalname:'original.pdf',mimetype:'application/pdf'}} as any;}
function uploadFixture(t:any,{operational=false,previous=false,committed=false,lookupError=false,metadataError=false}={}){
 const state={saves:0,removes:0,rawCreated:false};
 const document=row({id:ids.record,carePathId:ids.path,patientId:ids.patient,structureId:ids.structure,authorUserId:ids.actor,kind:'DOCUMENT',title:'Document',visibility:'CLINICAL',status:'DRAFT',version:1,data:{rawFileId:'raw',fileName:'original.pdf'}});
 t.mock.method(sequelize,'transaction',async(callback:any)=>callback(transaction));
 t.mock.method(sequelize,'query',async()=>[]);
 t.mock.method(TenantUser,'findOne',async()=>row({role:operational?'PERSONAL_TRAINER':'THERAPIST'}));
 t.mock.method(StructureUser,'findOne',async()=>row({role:operational?'PERSONAL_TRAINER':'THERAPIST'}));
 t.mock.method(User,'findByPk',async()=>row({isActive:true,deactivatedAt:null}));
 t.mock.method(Tenant,'findByPk',async()=>row({featureFlags:{clinical:{enabled:true,trainingEnabled:true}}}));
 t.mock.method(Patient,'schema',()=>({findOne:async()=>row({id:ids.patient})}));
 t.mock.method(CarePath,'schema',()=>({findOne:async()=>row({id:ids.path,patientId:ids.patient,structureId:ids.structure,status:'ACTIVE',kind:'REHAB'})}));
 t.mock.method(CarePathMember,'schema',()=>({findOne:async()=>row({level:operational?'OPERATIONAL':'CLINICAL'})}));
 t.mock.method(ClinicalRecord,'schema',()=>({create:async(v:any)=>row({...v,id:ids.record}),findByPk:async()=>document}));
 const fingerprint=createHash('sha256').update(JSON.stringify({label:'document-upload',input:{pathId:ids.path,title:'Document',originalName:'original.pdf',checksumSha256:createHash('sha256').update(buffer).digest('hex'),evaluationId:null}})).digest('hex');
 t.mock.method(ClinicalOperation,'schema',()=>({findOne:async()=>previous?row({fingerprint,result:document.get({plain:true})}):null,create:async()=>({})}));
 t.mock.method(ClinicalAudit,'schema',()=>({create:async()=>({})}));
 t.mock.method(localStorageAdapter,'save',async()=>{state.saves++;return {storagePath:'private/original',sizeBytes:buffer.length,checksumSha256:'checksum'};});
 t.mock.method(localStorageAdapter,'remove',async()=>{state.removes++;});
 t.mock.method(RawFile,'schema',()=>({
 create:async(v:any)=>{if(metadataError)throw new Error('Metadata failed');state.rawCreated=true;return row({...v,id:'raw'});},
 findOne:async()=>{if(lookupError)throw new Error('Database unavailable');return committed?row({id:'raw',storagePath:'private/original'}):null;}
 }));
 return state;
}
test('successful upload response failure never deletes the committed original',async t=>{
 const state=uploadFixture(t,{committed:true});
 const result=await invoke(media,'/care-paths/:pathId/documents/upload','post',uploadRequest(),true);
 assert.ok(result.error);assert.equal(state.rawCreated,true);assert.equal(state.removes,0);
});
test('ambiguous commit retains an original whose RawFile metadata exists',async t=>{
 const state=uploadFixture(t,{committed:true});
 t.mock.method(sequelize,'transaction',async(callback:any)=>{await callback(transaction);throw new Error('Commit reply lost');});
 const result=await invoke(media,'/care-paths/:pathId/documents/upload','post',uploadRequest());
 assert.ok(result.error);assert.equal(state.removes,0);
});
test('ambiguous commit retains the original when cleanup cannot verify database state',async t=>{
 const state=uploadFixture(t,{lookupError:true});
 t.mock.method(sequelize,'transaction',async(callback:any)=>{await callback(transaction);throw new Error('Connection lost');});
 const result=await invoke(media,'/care-paths/:pathId/documents/upload','post',uploadRequest());
 assert.ok(result.error);assert.equal(state.removes,0);
});
test('failed metadata persistence removes only the verified unreferenced upload',async t=>{
 const state=uploadFixture(t,{metadataError:true});
 const result=await invoke(media,'/care-paths/:pathId/documents/upload','post',uploadRequest());
 assert.ok(result.error);assert.equal(state.saves,1);assert.equal(state.removes,1);
});
test('operational access cannot upload to a previous own clinical evaluation',async t=>{
 const state=uploadFixture(t,{operational:true});
 t.mock.method(Evaluation,'schema',(()=>({findByPk:async()=>row({id:ids.evaluation,patientId:ids.patient,carePathId:ids.path,userId:ids.actor,status:'DRAFT',createdAt:new Date(),clinicalVisibility:'CLINICAL'})})) as any);
 const req=uploadRequest();req.body.evaluationId=ids.evaluation;
 const result=await invoke(media,'/care-paths/:pathId/documents/upload','post',req);
 assert.equal(result.error?.statusCode,404);assert.equal(state.saves,0);
});
test('upload replay cannot expose a clinical receipt after operational downgrade',async t=>{
 const state=uploadFixture(t,{operational:true,previous:true});
 const result=await invoke(media,'/care-paths/:pathId/documents/upload','post',uploadRequest());
 assert.equal(result.error?.statusCode,404);assert.equal(state.saves,0);
});
function feedbackFixture(t:any,revoked=false){
 const state={writes:0,accessChecks:0,pathLocked:false,tenantLocked:false};
 t.mock.method(sequelize,'transaction',(async(callback:any)=>callback(transaction)) as any);
 t.mock.method(sequelize,'query',(async()=>[]) as any);
 t.mock.method(PatientPortalAccess,'findOne',(async(options:any)=>{state.accessChecks++;assert.equal(options.transaction,transaction);assert.equal(options.lock,'SHARE');assert.equal(options.where.status,'ACTIVE');assert.equal(options.where.patientId,ids.patient);return revoked?null:row({id:ids.access,patientId:ids.patient,status:'ACTIVE'});}) as any);
 t.mock.method(ClinicalPublication,'schema',(()=>({findOne:async()=>row({id:'publication',recordId:ids.record,patientId:ids.patient,carePathId:ids.path,structureId:ids.structure,sourceVersion:1})})) as any);
 t.mock.method(ClinicalRecord,'schema',(()=>({findByPk:async()=>row({id:ids.record,patientId:ids.patient,carePathId:ids.path,structureId:ids.structure,kind:'PROGRAM',status:'CONFIRMED',version:1})})) as any);
 t.mock.method(CarePath,'schema',(()=>({findByPk:async(_id:string,options:any)=>{state.pathLocked=options.transaction===transaction&&options.lock==='SHARE';return row({id:ids.path,patientId:ids.patient,structureId:ids.structure,kind:'REHAB',status:'ACTIVE'});}})) as any);
 t.mock.method(Tenant,'findByPk',(async(_id:string,options:any)=>{state.tenantLocked=options.transaction===transaction&&options.lock==='SHARE';return row({featureFlags:{clinical:{enabled:true}}});}) as any);
 t.mock.method(ClinicalOperation,'schema',(()=>({findOne:async()=>null,create:async()=>({})})) as any);
 t.mock.method(ClinicalHomeFeedback,'schema',(()=>({create:async(v:any)=>{state.writes++;return row({...v,id:'feedback',createdAt:new Date()});}})) as any);
 return state;
}
function feedbackRequest(){return {tenantSchema:'fixture',user:{id:ids.actor,tid:ids.tenant,pid:ids.patient,patientAccessId:ids.access,actor:'patient'},patientPortalAccess:row({id:ids.access,status:'ACTIVE',patientId:ids.patient}),params:{id:ids.record},body:{operationId:ids.operation,status:'PERFORMED',pain:null,effort:null}} as any;}
test('feedback rechecks access after middleware so a concurrent revocation blocks the write',async t=>{
 const state=feedbackFixture(t,true);
 const result=await invoke(portal,'/patient-portal/clinical-records/:id/feedback','post',feedbackRequest());
 assert.equal(result.error?.statusCode,403);assert.equal(state.accessChecks,1);assert.equal(state.writes,0);
});
test('feedback holds current access, path and feature configuration until commit',async t=>{
 const state=feedbackFixture(t);
 const result=await invoke(portal,'/patient-portal/clinical-records/:id/feedback','post',feedbackRequest());
 assert.equal(result.status,201);assert.equal(state.accessChecks,1);assert.equal(state.pathLocked,true);assert.equal(state.tenantLocked,true);assert.equal(state.writes,1);
});

test('authorized upload retry reuses the receipt without creating a second original',async t=>{
 const state=uploadFixture(t,{previous:true});
 const result=await invoke(media,'/care-paths/:pathId/documents/upload','post',uploadRequest());
 assert.equal(result.status,201);assert.equal(result.body.data.id,ids.record);assert.equal(state.saves,0);
});
test('PT feedback in a rehab path still requires the training feature',async t=>{
 const state=feedbackFixture(t);
 t.mock.method(ClinicalRecord,'schema',(()=>({findByPk:async()=>row({id:ids.record,patientId:ids.patient,carePathId:ids.path,structureId:ids.structure,kind:'PROGRAM',status:'CONFIRMED',version:1,data:{discipline:'PT'}})})) as any);
 const result=await invoke(portal,'/patient-portal/clinical-records/:id/feedback','post',feedbackRequest());
 assert.equal(result.error?.statusCode,409);assert.equal(state.writes,0);
});
test('PT publication in a rehab path requires the training feature',async t=>{
 uploadFixture(t);
 t.mock.method(Tenant,'findByPk',(async()=>row({featureFlags:{clinical:{enabled:true,trainingEnabled:false}}})) as any);
 t.mock.method(ClinicalRecord,'schema',(()=>({findByPk:async()=>row({id:ids.record,carePathId:ids.path,patientId:ids.patient,structureId:ids.structure,authorUserId:ids.actor,kind:'PROGRAM',visibility:'CLINICAL',status:'CONFIRMED',version:1,data:{discipline:'PT'}})})) as any);
 let writes=0;t.mock.method(ClinicalPublication,'schema',(()=>({findOne:async()=>null,create:async()=>{writes++;return row({});}})) as any);
 const req=uploadRequest();req.params={patientId:ids.patient,id:ids.record};req.body={published:true,expectedVersion:1};
 const result=await invoke(portal,'/staff/patients/:patientId/portal/clinical-records/:id','patch',req);
 assert.equal(result.error?.statusCode,409);assert.equal(writes,0);
});
test('publication revoked between initial lookup and locking is not accepted for feedback',async t=>{
 const state=feedbackFixture(t);let reads=0;
 t.mock.method(ClinicalPublication,'schema',(()=>({findOne:async(options:any)=>{
   reads++;if(reads===1){assert.equal(options.lock,undefined);return row({id:'publication',recordId:ids.record,patientId:ids.patient,carePathId:ids.path,structureId:ids.structure,sourceVersion:1});}
   assert.equal(options.lock,'SHARE');return null;
 }})) as any);
 const result=await invoke(portal,'/patient-portal/clinical-records/:id/feedback','post',feedbackRequest());
 assert.equal(result.error?.statusCode,404);assert.equal(state.writes,0);assert.equal(reads,2);
});

test('feedback locks path before record and publication to match staff mutations',async t=>{
 feedbackFixture(t);const locked:string[]=[];
 const record=row({id:ids.record,patientId:ids.patient,carePathId:ids.path,structureId:ids.structure,kind:'PROGRAM',status:'CONFIRMED',version:1});
 t.mock.method(ClinicalRecord,'schema',(()=>({findByPk:async(_id:string,options:any)=>{if(options.lock)locked.push('record');return record;}})) as any);
 t.mock.method(CarePath,'schema',(()=>({findByPk:async(_id:string,options:any)=>{if(options.lock)locked.push('path');return row({id:ids.path,patientId:ids.patient,structureId:ids.structure,kind:'REHAB',status:'ACTIVE'});}})) as any);
 t.mock.method(ClinicalPublication,'schema',(()=>({findOne:async(options:any)=>{if(options.lock)locked.push('publication');return row({id:'publication',recordId:ids.record,patientId:ids.patient,carePathId:ids.path,structureId:ids.structure,sourceVersion:1});}})) as any);
 const result=await invoke(portal,'/patient-portal/clinical-records/:id/feedback','post',feedbackRequest());
 assert.equal(result.status,201);assert.deepEqual(locked,['path','record','publication']);
});
