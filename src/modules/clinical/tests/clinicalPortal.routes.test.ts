
import assert from 'node:assert/strict';
import {test} from 'node:test';
import router from '../routes/clinicalPortal.routes.js';
import {CarePath,ClinicalRecord,ClinicalPublication,ClinicalHomeFeedback} from '../models/clinical.model.js';
import Tenant from '../../auth/models/tenant.model.js';
const id='10000000-0000-4000-8000-000000000001',patient='10000000-0000-4000-8000-000000000002',pathId='10000000-0000-4000-8000-000000000003';
const row=(v:any)=>({...v,get:(key:any)=>typeof key==='string'?v[key]:{...v}});
function invoke(path:string,method:string,req:any):Promise<any>{
 const route=(router as any).stack.find((x:any)=>x.route?.path===path&&x.route?.methods[method]).route;
 const handler=route.stack.at(-1).handle;
 return new Promise(resolve=>{let status=200;const res={status(n:number){status=n;return res;},json(body:any){resolve({status,body});return res;}};handler(req,res,(error:any)=>resolve({error}));});
}
const req=()=>({tenantSchema:'fixture',user:{id:patient,tid:'tenant'},patientPortalAccess:{patientId:patient,status:'ACTIVE'},params:{id},body:{}} as any);
function fixture(t:any,{mismatch=false,revoked=false,stale=false,enabled=true}={}){
 const publication=row({id:'publication',recordId:id,patientId:patient,carePathId:pathId,structureId:'structure',sourceVersion:1,publishedAt:new Date()});
 t.mock.method(ClinicalPublication,'schema',()=>({
 findAll:async()=>[publication],
 findOne:async({where}:any)=>{assert.equal(where.patientId,patient);assert.equal(where.revokedAt,null);return revoked?null:publication;}
 }));
 const record=row({id,patientId:mismatch?'other':patient,carePathId:pathId,structureId:'structure',kind:'PROGRAM',status:'CONFIRMED',version:stale?2:1,title:'Home plan',data:{instructions:'Walk',internalNotes:'secret',objectiveIds:['private-goal'],items:[{id:'item',title:'Walk',internalDiagnosis:'secret'}]}});
 t.mock.method(ClinicalRecord,'schema',()=>({findByPk:async()=>record}));
 t.mock.method(CarePath,'schema',()=>({findByPk:async()=>row({id:pathId,patientId:patient,structureId:'structure',kind:'REHAB',status:'ACTIVE'})}));
 t.mock.method(ClinicalHomeFeedback,'schema',()=>({findAll:async()=>[]}));
 t.mock.method(Tenant,'findByPk',async()=>row({featureFlags:{clinical:{enabled}}}));
}
test('patient gets only public fields of explicitly published matching record',async t=>{
 fixture(t);
 const result=await invoke('/patient-portal/clinical-records','get',req());
 assert.equal(result.status,200);assert.equal(result.body.data.length,1);
 const data=result.body.data[0].data;
 assert.equal(data.instructions,'Walk');assert.equal(data.internalNotes,undefined);assert.equal(data.objectiveIds,undefined);assert.equal(data.items[0].internalDiagnosis,undefined);
});
for(const option of ['mismatch','revoked','stale'] as const)test('patient list excludes '+option+' publication',async t=>{
 fixture(t,{[option]:true});
 const result=await invoke('/patient-portal/clinical-records','get',req());
 assert.equal(result.status,200);assert.deepEqual(result.body.data,[]);
});
test('revoked publication denies direct document access',async t=>{
 fixture(t,{revoked:true});
 const result=await invoke('/patient-portal/clinical-records/:id/download','get',req());
 assert.equal(result.error?.statusCode,404);
});
test('disabled feature retains published history while disabling feedback',async t=>{
 fixture(t,{enabled:false});
 const result=await invoke('/patient-portal/clinical-records','get',req());
 assert.equal(result.body.data.length,1);assert.equal(result.body.data[0].canSendFeedback,false);
});
