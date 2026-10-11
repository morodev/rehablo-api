import assert from 'node:assert/strict';
import { it, TestContext } from 'node:test';
import { Op } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { Structure, StructureAvailability, StructureUser, StructureUserAvailability, TenantUser, User } from '../models/index.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import AgendaEventException from '../../agenda/models/agendaEventException.model.js';
import {ActivityBoard} from '../../activities/models/index.js';
import { updateTeamMemberProfile, updateUser } from './user.controller.js';

const id=(n:number)=>'bbbbbbbb-bbbb-4bbb-8bbb-'+String(n).padStart(12,'0');
const target=id(1), tenant=id(2), a=id(3), b=id(4);
function record(data:any):any{return new Proxy({get:(key:any)=>typeof key==='string'?data[key]:{...data},update:async(patch:any)=>Object.assign(data,patch)}, {get(object:any,key:any){return key in object?object[key]:data[key];}});}
function run(handler:any,req:any):Promise<any>{return new Promise(resolve=>{const res:any={statusCode:200,status(code:number){this.statusCode=code;return this;},json(body:any){resolve({status:this.statusCode,body});return this;}};handler(req,res,(error:any)=>resolve({status:500,body:{message:error?.message}}));});}
function fixture(t:TestContext){
 t.mock.method(sequelize,'query',(async(sql:string)=>{if(!sql.includes('activities-membership-gate'))throw new Error('Unexpected unmocked SQL in unit fixture');return [[],{}];}) as any);
 t.mock.method(ActivityBoard,'schema',(()=>({findAll:async()=>[]})) as any);
 const identity:any={id:target,name:'Test',surname:'User',email:'test@example.org',isTenant:false,deactivatedAt:null};
 const membership:any={tenantId:tenant,userId:target,role:'OWNER',deactivatedAt:null};
 const agendas:any[]=[{userId:target,structureId:a,calendarEnabled:true,availabilityMode:'CUSTOM'}, {userId:target,structureId:b,calendarEnabled:true,availabilityMode:'INHERIT_STRUCTURE'}];
 let rows:any[]=Array.from({length:7},(_,day)=>({userId:target,structureId:a,day,enabled:day===0,rangeOneStart:day===0?'09:00:00':null,rangeOneFinish:day===0?'12:00:00':null}));
 const future:any[]=[];
 const match=(row:any,where:any)=>Object.entries(where).every(([key,value]:[string,any])=>typeof value==='object' && value!==null ? !value[Op.in]||value[Op.in].includes(row[key]):row[key]===value);
 t.mock.method(sequelize,'transaction',(async(callback:any)=>{const before=JSON.stringify({identity,membership,agendas,rows});try{return await callback({LOCK:{UPDATE:'UPDATE'}});}catch(error){const saved=JSON.parse(before);Object.assign(identity,saved.identity);Object.assign(membership,saved.membership);agendas.forEach((row,i)=>Object.assign(row,saved.agendas[i]));rows=saved.rows;throw error;}}) as any);
 t.mock.method(User,'findOne',(async()=>record({id:id(9),deactivatedAt:null})) as any);
 t.mock.method(User,'findByPk',(async()=>record(identity)) as any);
 t.mock.method(User,'findAll',(async()=>[]) as any);
 t.mock.method(TenantUser,'findOne',(async()=>record(membership)) as any);
 t.mock.method(TenantUser,'findAll',(async()=>[]) as any);
 t.mock.method(Structure,'findAll',(async()=>[record({id:a,tenantId:tenant}),record({id:b,tenantId:tenant})]) as any);
 t.mock.method(Structure,'findOne',(async({where}:any)=>where.tenantId===tenant?[a,b].includes(where.id)?record({id:where.id,tenantId:tenant}):null:null) as any);
 t.mock.method(StructureUser,'findAll',(async({where}:any)=>agendas.filter(row=>match(row,where)).map(record)) as any);
 t.mock.method(StructureUser,'findOne',(async({where}:any)=>{if(where.userId===id(9))return record({userId:id(9),structureId:where.structureId,role:null});const found=agendas.find(row=>match(row,where));return found?record(found):null;}) as any);
 t.mock.method(StructureUserAvailability,'findAll',(async({where}:any)=>rows.filter(row=>match(row,where)).map(record)) as any);
 t.mock.method(StructureUserAvailability,'destroy',(async({where}:any)=>{rows=rows.filter(row=>!match(row,where));return 7;}) as any);
 t.mock.method(StructureUserAvailability,'bulkCreate',(async(input:any[])=>{rows.push(...input);return input;}) as any);
 t.mock.method(StructureAvailability,'findAll',(async()=>[record({day:0,enabled:true,open:'08:00:00',close:'18:00:00'})]) as any);
 t.mock.method(AgendaEvent,'schema',(()=>({findAll:async({where}:any)=>future.filter(row=>!where.structureId||row.structureId===where.structureId).map(record)})) as any);
 t.mock.method(AgendaEventException,'schema',(()=>({findAll:async()=>[]})) as any);
 const req:any={params:{userId:target},tenantSchema:'schema',user:{sub:id(9),tid:tenant,sid:a},body:{},access:{structureId:a,userId:id(9),scope:'tenant'}};
 return {req,identity,membership,agendas,rows:()=>rows,future};
}
it('Team refuses silent disable when current premise still has future appointments and rolls back the profile',async t=>{
 const f=fixture(t);f.future.push({id:id(8),calendarId:target,structureId:a,start:'2099-01-01T10:00:00Z',end:'2099-01-01T11:00:00Z',status:'CONFIRMED',patient:{id:id(7)}});
 f.req.body={user:{name:'Changed',calendarEnabled:false}};const result=await run(updateTeamMemberProfile,f.req);
 assert.equal(result.status,409);assert.equal(result.body.error?.code,'FUTURE_APPOINTMENTS_REQUIRE_REASSIGNMENT');assert.equal(f.identity.name,'Test');assert.equal(f.agendas[0].calendarEnabled,true);
});
it('deferred disable affects only selected agenda, preserves mode and future events, and keeps login active',async t=>{
 const f=fixture(t);f.future.push({id:id(8),calendarId:target,structureId:a,start:'2099-01-01T10:00:00Z'});
 const saved=JSON.stringify(f.rows());f.req.body={user:{calendarEnabled:false},deferReassignment:true};
 const result=await run(updateTeamMemberProfile,f.req);assert.equal(result.status,200);assert.equal(result.body.data.calendarEnabled,false);
 assert.equal(f.agendas[0].availabilityMode,'CUSTOM');assert.equal(f.agendas[1].calendarEnabled,true);assert.equal(JSON.stringify(f.rows()),saved);
 assert.equal(f.membership.deactivatedAt,null);assert.equal(f.identity.deactivatedAt,null);assert.equal(f.future[0].calendarId,target);
});
it('future appointments in another premise do not block current-premise disable',async t=>{
 const f=fixture(t);f.future.push({id:id(8),calendarId:target,structureId:b,start:'2099-01-01T10:00:00Z',end:'2099-01-01T11:00:00Z',patient:{id:id(7)}});
 f.req.body={user:{calendarEnabled:false}};const result=await run(updateTeamMemberProfile,f.req);
 assert.equal(result.status,200);assert.equal(f.agendas[0].calendarEnabled,false);assert.equal(f.agendas[1].calendarEnabled,true);
});
it('legacy profile updates use the same selected-premise schedule validation',async t=>{
 const f=fixture(t);f.membership.role='SECRETARY';f.req.body={user:{availabilityMode:'CUSTOM',userAvailabilities:f.rows().map(row=>({...row,rangeOneStart:row.enabled?'07:00':null}))}};
 const result=await run(updateUser,f.req);assert.equal(result.status,400);assert.equal(f.rows()[0].rangeOneStart,'09:00:00');
});
it('missing current premise allows identity-only changes but refuses calendar writes',async t=>{
 const f=fixture(t);delete f.req.user.sid;f.req.body={user:{calendarEnabled:false}};
 assert.equal((await run(updateTeamMemberProfile,f.req)).status,400);
 f.req.body={user:{name:'Changed'}};const result=await run(updateTeamMemberProfile,f.req);
 assert.equal(result.status,200);assert.equal(f.identity.name,'Changed');assert.equal(result.body.data.calendarEnabled,false);assert.deepEqual(result.body.data.userAvailabilities,[]);
});

it('invalid replacement identifier is rejected before querying UUID membership locks', async t => {
 const f=fixture(t);f.req.body={user:{calendarEnabled:false},replacementUserId:'not-a-uuid'};
 const result=await run(updateTeamMemberProfile,f.req);assert.equal(result.status,400);assert.equal(f.agendas[0].calendarEnabled,true);
});
