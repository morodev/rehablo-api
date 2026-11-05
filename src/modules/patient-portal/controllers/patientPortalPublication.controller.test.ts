import Observation from '../../measurements/models/observation.model.js';
import Patient from '../../patients/models/patient.model.js';
import {Evaluation} from '../../evaluations/models/index.js';
import PatientPortalAudit from '../models/patientPortalAudit.model.js';
import {publishEvaluation} from './patientPortalPublication.controller.js';
import {evaluations,evaluationDetail} from './patientPortal.controller.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Request, Response, NextFunction } from 'express';
import PatientSharedDocument from '../models/patientSharedDocument.model.js';
import { localStorageAdapter } from '../../measurements/storage/localStorageAdapter.js';
import { downloadDocument } from './patientPortalPublication.controller.js';

it('does not read a document belonging to another patient', async t => {
    const patientId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
    let fileReads = 0;
    t.mock.method(PatientSharedDocument, 'schema', (() => ({
        findOne: async ({ where }: any) => {
            assert.equal(where.patientId, patientId);
            return null;
        }
    })) as any);
    t.mock.method(localStorageAdapter, 'read', (async () => { fileReads++; throw new Error('File leaked'); }) as any);
    const req: any = { tenantSchema: 'rehablo_test', params: { id: 'another-document' }, user: { pid: patientId } };
    const status = await new Promise<number>(resolve => {
        const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; },
            json() { resolve(this.statusCode); return this; } };
        downloadDocument(req as Request, res as Response, ((error?: any) => resolve(error?.statusCode ?? 500)) as NextFunction);
    });
    assert.equal(status, 404);
    assert.equal(fileReads, 0);
});

function publicationInvoke(handler:any,req:any):Promise<any>{return new Promise(resolve=>{let status=200;const res={status(code:number){status=code;return res;},json(body:any){resolve({status,body});return res;}};handler(req,res,(error:any)=>resolve({error}));});}
it('legacy publication cannot expose an entire care-path evaluation',async t=>{
 t.mock.method(Patient,'schema',(()=>({findOne:async()=>({id:'patient'})})) as any);
 let writes=0;
 t.mock.method(Evaluation,'schema',(()=>({findOne:async()=>({carePathId:'path',get:()=> 'COMPLETED',update:async()=>{writes++;}})})) as any);
 const result=await publicationInvoke(publishEvaluation,{tenantSchema:'fixture',params:{patientId:'patient',id:'evaluation'},body:{published:true},access:{scope:'tenant',userId:'actor'}});
 assert.equal(result.status,409);assert.equal(writes,0);
});
it('legacy publication keeps the completed unscoped flow available',async t=>{
 t.mock.method(Patient,'schema',(()=>({findOne:async()=>({id:'patient'})})) as any);
 let published=false;
 t.mock.method(Evaluation,'schema',(()=>({findOne:async()=>({carePathId:null,get:(key:string)=>key==='status'?'COMPLETED':published,update:async(v:any)=>{published=v.publishedToPatient;}})})) as any);
 const result=await publicationInvoke(publishEvaluation,{tenantSchema:'fixture',params:{patientId:'patient',id:'evaluation'},body:{published:true},access:{scope:'tenant',userId:'actor'}});
 assert.equal(result.status,200);assert.equal(published,true);
});
it('legacy patient list and direct detail restrict care-path evaluations',async t=>{
 t.mock.method(PatientPortalAudit,'schema',(()=>({create:async()=>({})})) as any);
 t.mock.method(Evaluation,'schema',(()=>({
 findAll:async({where}:any)=>{assert.equal(where.carePathId,null);assert.equal(where.patientId,'patient');return [];},
 findOne:async({where}:any)=>{assert.equal(where.carePathId,null);assert.equal(where.patientId,'patient');return null;}
 })) as any);
 const req:any={ip:'127.0.0.1',get:()=>undefined,tenantSchema:'fixture',params:{evaluationId:'evaluation'},query:{},user:{id:'patient-user',pid:'patient',tid:'tenant'},patientPortalAccess:{patientId:'patient',get:(key:string)=>key==='patientId'?'patient':'ACTIVE'}};
 const list=await publicationInvoke(evaluations,req);assert.equal(list.status,200);
 const detail=await publicationInvoke(evaluationDetail,req);assert.equal(detail.status,404);
});

it('legacy portal uses frozen test text without exposing private snapshot fields',async t=>{
 t.mock.method(PatientPortalAudit,'schema',(()=>({create:async()=>({})})) as any);
 t.mock.method(Observation,'schema',(()=>({findAll:async()=>[]})) as any);
 const snapshot={id:'catalog',name:'Original public name',description:'Original description',patientText:'Public instruction',type:'orthopedic',isFullBody:false,note:'secret note',operatorText:'secret operator instruction',positiveText:'secret positive interpretation',negativeText:'secret negative interpretation'};
 t.mock.method(Evaluation,'schema',(()=>({findOne:async()=>({get:()=>({id:'evaluation',testInstances:[{id:'instance',isPositive:false,notes:'secret note',testSnapshot:snapshot,test:{name:'Renamed catalog',operatorText:'secret current instruction'}}]})})})) as any);
 const req:any={ip:'127.0.0.1',get:()=>undefined,tenantSchema:'fixture',params:{evaluationId:'evaluation'},query:{},user:{id:'patient-user',pid:'patient',tid:'tenant'},patientPortalAccess:{patientId:'patient',get:()=> 'ACTIVE'}};
 const result=await publicationInvoke(evaluationDetail,req);
 assert.equal(result.status,200);const instance=result.body.data.testInstances[0];
 assert.equal(instance.test.name,'Original public name');assert.equal(instance.testSnapshot.name,'Original public name');assert.equal(instance.isPositive,false);
 assert.equal(JSON.stringify(result.body.data).includes('secret'),false);
 assert.equal(instance.test.positiveText,undefined);assert.equal(instance.testSnapshot.positiveText,undefined);
});
