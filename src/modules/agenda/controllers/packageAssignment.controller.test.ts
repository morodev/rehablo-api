import assert from 'node:assert/strict';
import {it, TestContext} from 'node:test';
import Patient from '../../patients/models/patient.model.js';
import AgendaEvent from '../models/agendaEvent.model.js';
import EventType from '../models/eventType.model.js';
import {CarePackage} from '../../administration/models/administration.model.js';
import {listEligibleCarePackages} from './packageAssignment.controller.js';

const id=(n:number)=>'aaaaaaaa-aaaa-4aaa-8aaa-'+String(n).padStart(12,'0');
const patientId=id(1),structureId=id(2),operatorId=id(3),secretaryId=id(4),eventTypeId=id(5),eventId=id(6);
function fixture(t:TestContext) {
    const event={id:eventId,patientId,structureId,calendarId:operatorId};
    t.mock.method(Patient,'schema',((schema:string)=>{assert.equal(schema,'rehablo_test');return {
        findOne:async({where}:any)=>where.id===patientId&&where.structureId===structureId ? {get:(field:string)=>({id:patientId,structureId,userId:secretaryId} as any)[field]}:null};}) as any);
    t.mock.method(AgendaEvent,'schema',(()=>({findOne:async({where}:any)=>where.id===eventId?{get:()=>event}:null,findByPk:async()=>event})) as any);
    t.mock.method(EventType,'schema',(()=>({findByPk:async()=>({linkedServiceId:id(7)})})) as any);
    t.mock.method(CarePackage,'schema',(()=>({findAll:async()=>[]})) as any);
    const req:any={tenantSchema:'rehablo_test',user:{actor:'staff',sub:operatorId,sid:structureId,
        perms:['care_package:read:own','agenda:create:own','agenda:update:own']},
        query:{patientId,eventTypeId,start:'2030-01-01T10:00:00Z',calendarId:operatorId}};
    const run=()=>new Promise<{status:number;body:any}>(resolve=>{
        const res:any={statusCode:200,status(code:number){this.statusCode=code;return this;},json(body:any){resolve({status:this.statusCode,body});return this;}};
        listEligibleCarePackages(req,res,(error?:any)=>resolve({status:error?.statusCode??500,body:{message:error?.message}}));
    });
    return {req,event,run};
}
it('allows a therapist to choose a package for a first own appointment for a patient created by the secretary',async t=>{
    const f=fixture(t);assert.equal((await f.run()).status,200);
});
it('allows editing the own appointment without depending on the patient record author',async t=>{
    const f=fixture(t);f.req.query.agendaEventId=eventId;assert.equal((await f.run()).status,200);
});
it('refuses a new or existing appointment belonging to a different operator with own rights',async t=>{
    const f=fixture(t);f.req.query.calendarId=secretaryId;assert.equal((await f.run()).status,403);
    f.req.query.agendaEventId=eventId;f.event.calendarId=secretaryId;assert.equal((await f.run()).status,403);
});
it('does not reveal eligible packages for a patient outside the selected site',async t=>{
    const f=fixture(t);f.req.user.sid=id(99);assert.equal((await f.run()).status,404);
});
