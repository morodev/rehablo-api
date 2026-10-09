import assert from 'node:assert/strict';
import { it, TestContext } from 'node:test';
import { Op } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { Structure, StructureUser, CalendarPreference } from '../models/index.js';
import { getCalendarPreferences, updateCalendarPreferences } from './calendarPreference.controller.js';
const id=(n:number)=>'aaaaaaaa-aaaa-4aaa-8aaa-'+String(n).padStart(12,'0');
function run(handler: any, req: any): Promise<any> {return new Promise(resolve=>{const res:any={statusCode:200,status(code:number){this.statusCode=code;return this;},json(body:any){resolve({status:this.statusCode,body});return this;}};handler(req,res,(err:any)=>resolve({status:500,body:err}));});}
function fixture(t:TestContext) {
 const rows:any[]=[];
 const availableCalendarIds=new Set([id(9),id(10)]);
 t.mock.method(Structure,'findOne',(async ({where}:any)=>where.tenantId===id(1)?{id:where.id}:null) as any);
 t.mock.method(StructureUser,'findOne',(async ()=>({calendarEnabled:true})) as any);
 t.mock.method(StructureUser,'findAll',(async ({where}:any)=>(where.userId[Op.in] as string[])
     .filter(userId=>availableCalendarIds.has(userId)).map(userId=>({userId,get:(key:string)=>key==='userId'?userId:undefined}))) as any);
 t.mock.method(sequelize,'transaction',(async (callback:any)=>callback({})) as any);
 const match=(row:any,where:any)=>Object.entries(where).every(([k,v])=>{
  const values=v && typeof v==='object'?(v as any)[Op.in]:null;
  return values?values.includes(row[k]):row[k]===v;
 });
 t.mock.method(CalendarPreference,'findAll',(async ({where}:any)=>rows.filter(row=>match(row,where))) as any);
 t.mock.method(CalendarPreference,'findOrCreate',(async ({where}:any)=>{if(!rows.some(row=>match(row,where)))rows.push(where);return [where,true];}) as any);
 t.mock.method(CalendarPreference,'bulkCreate',(async (input:any[])=>{for(const row of input)if(!rows.some(existing=>match(existing,row)))rows.push(row);return input;}) as any);
 t.mock.method(CalendarPreference,'destroy',(async ({where}:any)=>{let removed=0;for(let i=rows.length-1;i>=0;i--)if(match(rows[i],where)){rows.splice(i,1);removed++;}return removed;}) as any);
 const req=(viewer:number,site:number,body:any={})=>({user:{sub:id(viewer),tid:id(1),sid:id(site)},body});
 return {rows,req};
}
it('sidebar preference is isolated by viewer and selected premise; default is all visible',async t=>{
 const f=fixture(t);const body={calendarId:id(9),visible:false,structureId:id(99),viewerUserId:id(99)};
 assert.equal((await run(updateCalendarPreferences,f.req(2,3,body))).status,200);
 const mine=await run(getCalendarPreferences,f.req(2,3));const otherViewer=await run(getCalendarPreferences,f.req(4,3));const otherSite=await run(getCalendarPreferences,f.req(2,5));
 assert.deepEqual(mine.body.data.hiddenCalendarIds,[id(9)]);assert.deepEqual(otherViewer.body.data.hiddenCalendarIds,[]);assert.deepEqual(otherSite.body.data.hiddenCalendarIds,[]);
 assert.deepEqual(f.rows[0],{viewerUserId:id(2),structureId:id(3),calendarId:id(9)});
 await run(updateCalendarPreferences,f.req(2,3,{calendarId:id(9),visible:true}));assert.equal(f.rows.length,0);
});
it('preferences refuse missing context, foreign tenant and invalid input',async t=>{
 const f=fixture(t);const noSite=f.req(2,3);delete (noSite.user as any).sid;
 assert.equal((await run(getCalendarPreferences,noSite)).status,400);
 const foreign=f.req(2,3);foreign.user.tid=id(99);assert.equal((await run(getCalendarPreferences,foreign)).status,400);
 assert.equal((await run(updateCalendarPreferences,f.req(2,3,{calendarId:'invalid',visible:false}))).status,400);assert.equal(f.rows.length,0);
});
it('updates a role group atomically while keeping the single payload compatible',async t=>{
 const f=fixture(t);
 const hidden=await run(updateCalendarPreferences,f.req(2,3,{calendarIds:[id(9),id(10),id(9)],visible:false}));
 assert.equal(hidden.status,200);assert.deepEqual(new Set(hidden.body.data.hiddenCalendarIds),new Set([id(9),id(10)]));
 const shown=await run(updateCalendarPreferences,f.req(2,3,{calendarId:id(9),visible:true}));
 assert.equal(shown.status,200);assert.deepEqual(shown.body.data.hiddenCalendarIds,[id(10)]);
});
it('rejects the whole bulk update when one agenda is outside the selected premise',async t=>{
 const f=fixture(t);
 const response=await run(updateCalendarPreferences,f.req(2,3,{calendarIds:[id(9),id(99)],visible:false}));
 assert.equal(response.status,404);assert.deepEqual(f.rows,[]);
});
