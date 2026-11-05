
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Op} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import Patient from '../../patients/models/patient.model.js';
import Evaluation from '../models/evaluation.model.js';
import HumanBodyPoint from '../../human-body/models/humanBodyPoint.model.js';
import HumanBodyEvent from '../../human-body/models/humanBodyEvent.model.js';
import TestInstance from '../../human-body/models/testInstance.model.js';
import {Test} from '../../human-body/models/catalog/index.js';
import {ClinicalOperation} from '../../clinical/models/clinical.model.js';
import {saveTest,getUserTestInstances} from '../../human-body/controllers/testInstance.controller.js';

const transaction={LOCK:{SHARE:'SHARE',UPDATE:'UPDATE'}} as any;
const ids={actor:'30000000-0000-4000-8000-000000000001',patient:'30000000-0000-4000-8000-000000000002',evaluation:'30000000-0000-4000-8000-000000000003',test:'30000000-0000-4000-8000-000000000004',point:'30000000-0000-4000-8000-000000000005',operation:'30000000-0000-4000-8000-000000000006'};
const row=(v:any)=>({...v,get:(key:any)=>typeof key==='string'?v[key]:{...v}});
function request(body:any={}){return {tenantSchema:'fixture',user:{id:ids.actor},access:{scope:'own',userId:ids.actor,structureId:null},body:{patientId:ids.patient,testId:ids.test,...body},query:{},params:{}} as any;}
function invoke(handler:any,req:any):Promise<any>{return new Promise(resolve=>{let status=200;const res={status(n:number){status=n;return res;},json(body:any){resolve({status,body});return res;}};handler(req,res,(error:any)=>resolve({error}));});}
function fixture(t:any,{failSave=false,closed=false}={}){
 const state={points:[] as any[],tests:[] as any[],rollback:false,where:null as any};
 const catalog={id:ids.test,name:'Original test',description:'Original description',positiveText:'Original positive',negativeText:'Original negative',patientText:'Patient instructions',operatorText:'Operator instructions',isFullBody:false,type:'orthopedic',image:Buffer.from('binary'),isPositive:true};
 const operations=new Map<string,any>();
 t.mock.method(sequelize,'transaction',async(callback:any)=>{try{return await callback(transaction);}catch(error){state.rollback=true;throw error;}});
 t.mock.method(sequelize,'query',async()=>[]);
 t.mock.method(Patient,'schema',()=>({findOne:async()=>row({id:ids.patient,structureId:null})}));
 t.mock.method(Evaluation,'schema',()=>({findByPk:async()=>row({id:ids.evaluation,patientId:ids.patient,userId:ids.actor,status:closed?'COMPLETED':'DRAFT',createdAt:new Date(),structureId:null})}));
 t.mock.method(Test,'findByPk',async()=>row(catalog));
 t.mock.method(HumanBodyPoint,'schema',()=>({
 create:async(values:any,options:any)=>{assert.equal(options.transaction,transaction);const point=row({...values,id:ids.point});state.points.push(point);return point;},
 findByPk:async()=>state.points[0]??null,findOne:async()=>state.points[0]??null
 }));
 t.mock.method(HumanBodyEvent,'schema',()=>({bulkCreate:async(_v:any,options:any)=>{assert.equal(options.transaction,transaction);return [];}}));
 t.mock.method(TestInstance,'schema',()=>({
 create:async(values:any,options:any)=>{assert.equal(options.transaction,transaction);if(failSave)throw new Error('Test persistence failed');const instance=row({...values,id:'instance-'+state.tests.length});state.tests.push(instance);return instance;},
 findOne:async({where}:any)=>state.tests.find(x=>x.id===where.id)??null,
 findByPk:async(id:string)=>state.tests.find(x=>x.id===id)??null,
 findAll:async({where}:any)=>{state.where=where;return state.tests.map(x=>row({...x.get({plain:true}),test:catalog}));}
 }));
 t.mock.method(ClinicalOperation,'schema',()=>({findOne:async({where}:any)=>operations.get(where.operationId)??null,create:async(v:any)=>{operations.set(v.operationId,row(v));return row(v);}}));
 return {state,catalog};
}
const point={patientId:ids.patient,evaluationId:ids.evaluation,cxCoordinate:10,cyCoordinate:20,rDimension:4,bodyPart:'KNEE',idSvg:'point@knee',humanBodyEvents:[{eventType:'TEST'}]};
test('test and point are saved in one transaction with catalog snapshot and explicit negative outcome',async t=>{
 const {state}=fixture(t);
 const result=await invoke(saveTest,request({evaluationId:ids.evaluation,pointToCreate:point,isPositive:false}));
 assert.equal(result.status,201);assert.equal(state.points.length,1);assert.equal(state.tests[0].humanBodyPointId,ids.point);
 assert.equal(state.tests[0].isPositive,false);assert.equal(result.body.data.humanBodyPoint.id,ids.point);
 assert.equal(state.tests[0].testSnapshot.name,'Original test');assert.equal(state.tests[0].testSnapshot.operatorText,'Operator instructions');
 assert.equal(state.tests[0].testSnapshot.image,undefined);assert.equal(state.tests[0].testSnapshot.isPositive,undefined);
});
test('missing test outcome stays null and legacy point-less payload remains valid',async t=>{
 const {state}=fixture(t);
 const result=await invoke(saveTest,request());
 assert.equal(result.status,201);assert.equal(state.tests[0].isPositive,null);assert.equal(state.points.length,0);
});
test('a failure saving test rolls back the point transaction',async t=>{
 const {state}=fixture(t,{failSave:true});
 const result=await invoke(saveTest,request({evaluationId:ids.evaluation,pointToCreate:point,isPositive:true}));
 assert.ok(result.error);assert.equal(state.points.length,1);assert.equal(state.rollback,true);assert.equal(state.tests.length,0);
});
test('a nested point cannot bypass a closed evaluation when top-level evaluationId is omitted',async t=>{
 const {state}=fixture(t,{closed:true});
 const result=await invoke(saveTest,request({pointToCreate:point,isPositive:false}));
 assert.equal(result.error?.statusCode,409);assert.equal(state.tests.length,0);assert.equal(state.points.length,0);
});
test('test retry is idempotent and changed data conflicts with the existing operation',async t=>{
 const {state}=fixture(t);
 const body={operationId:ids.operation,evaluationId:ids.evaluation,pointToCreate:point,isPositive:false};
 const first=await invoke(saveTest,request(body));const again=await invoke(saveTest,request(body));
 assert.equal(first.status,201);assert.equal(again.status,201);assert.equal(again.body.data.id,first.body.data.id);
 assert.equal(state.tests.length,1);assert.equal(state.points.length,1);
 const conflict=await invoke(saveTest,request({...body,isPositive:true}));assert.equal(conflict.error?.statusCode,409);
});
test('historical test text comes from its snapshot and point filters retain own scope',async t=>{
 const {state,catalog}=fixture(t);
 await invoke(saveTest,request({pointToCreate:point,evaluationId:ids.evaluation,isPositive:false}));
 catalog.name='Renamed catalog';catalog.negativeText='Changed negative';
 const req=request();req.query={patientId:ids.patient,evaluationId:ids.evaluation,humanBodyPointId:ids.point};
 const result=await invoke(getUserTestInstances,req);
 assert.equal(result.status,200);assert.equal(result.body.data[0].test.name,'Original test');assert.equal(result.body.data[0].test.negativeText,'Original negative');
 assert.deepEqual(state.where[Op.and],[{userId:ids.actor},{patientId:ids.patient,evaluationId:ids.evaluation,humanBodyPointId:ids.point}]);
});
