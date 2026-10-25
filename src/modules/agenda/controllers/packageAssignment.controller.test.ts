import assert from 'node:assert/strict';
import {it, TestContext} from 'node:test';
import Patient from '../../patients/models/patient.model.js';
import AgendaEvent from '../models/agendaEvent.model.js';
import EventType from '../models/eventType.model.js';
import {CarePackage} from '../../administration/models/administration.model.js';
import {Op} from 'sequelize';
import administrationRouter from '../../administration/routes/administration.routes.js';
import {listEligibleCarePackages, listAppointmentCarePackageOptions} from './packageAssignment.controller.js';

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

function appointmentOptionsFixture(t: TestContext) {
    const row = (data: Record<string, any>): any => ({...data, get: (key: unknown) => typeof key === 'string' ? data[key] : data});
    const patient = {id: patientId, structureId, userId: secretaryId};
    const event: any = {id: eventId, patientId, structureId, calendarId: operatorId, status: 'CONFIRMED'};
    const packages = [{id: id(10), patientId, structureId, templateId: id(11), serviceId: id(7), serviceName: 'Fisioterapia',
        name: 'Pacchetto', purchasedUnits: 10, remainingUnits: 5, status: 'ACTIVE', purchasedAt: '2025-01-01', expiresAt: null},
        {id: id(12), patientId, structureId, templateId: null, name: 'Storico', purchasedUnits: 5, remainingUnits: 2, status: 'ACTIVE', purchasedAt: '2025-01-01'}];
    const legacyLookups: any[] = [];
    let allowLegacy = false;
    t.mock.method(Patient, 'schema', (() => ({findOne: async ({where}: any) => {
        if (where[Op.and]) {legacyLookups.push(where); return allowLegacy ? row(patient) : null;}
        return where.id === patientId && where.structureId === patient.structureId ? row(patient) : null;
    }})) as any);
    t.mock.method(AgendaEvent, 'schema', (() => ({findOne: async ({where}: any) => {
        const target = where[Op.and][0]; return target.id === event.id && target.structureId === event.structureId
            && (event.patientId ?? event.patient?.id) === patientId ? row(event) : null;
    }, findAll: async () => []})) as any);
    t.mock.method(EventType, 'schema', (() => ({findByPk: async () => ({linkedServiceId: id(7)})})) as any);
    t.mock.method(CarePackage, 'schema', (() => ({findAll: async ({where}: any) => packages.filter(pkg =>
        pkg.patientId === where.patientId && pkg.structureId === where.structureId && (!where.templateId || pkg.templateId != null)).map(row)})) as any);
    const req: any = {tenantSchema: 'rehablo_test', user: {actor: 'staff', sub: operatorId, sid: structureId,
        perms: ['care_package:read:own', 'agenda:create:own', 'agenda:update:own']},
        query: {patientId, calendarId: operatorId, eventTypeId, start: '2025-02-01T10:00:00Z'}};
    const run = () => new Promise<{status: number; body: any}>(resolve => {
        const res: any = {statusCode: 200, status(value: number) {this.statusCode = value; return this;},
            json(body: any) {resolve({status: this.statusCode, body}); return this;}};
        listAppointmentCarePackageOptions(req, res, (error?: any) => resolve({status: error?.statusCode ?? 500, body: {message: error?.message}}));
    });
    return {req, patient, event, packages, legacyLookups, run, allowLegacy: () => {allowLegacy = true;}};
}

it('appointment options allow a first own appointment for a secretary-created patient without returning legacy or financial data', async t => {
    const f = appointmentOptionsFixture(t), response = await f.run();
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.items.map((item: any) => item.id), [id(10)]);
    assert.equal(response.body.data.items[0].selectable, true);
    assert.equal(response.body.data.items[0].totalPrice, undefined);
    assert.equal(f.legacyLookups.length, 0);
});

it('appointment options accept absent optional context but reject malformed supplied values', async t => {
    const f = appointmentOptionsFixture(t);
    delete f.req.query.eventTypeId; delete f.req.query.start;
    const incomplete = await f.run();
    assert.equal(incomplete.status, 200); assert.equal(incomplete.body.data.items[0].selectable, false);
    for (const patch of [{eventTypeId: ''}, {eventTypeId: ['bad']}, {agendaEventId: 'bad'}, {start: ''},
        {start: '2025-02-30T10:00:00Z'}, {start: ['2025-01-01']}, {recurring: 'sometimes'}, {calendarId: {id: operatorId}}]) {
        const saved = f.req.query; f.req.query = {patientId, calendarId: operatorId, ...patch};
        assert.equal((await f.run()).status, 422, JSON.stringify(patch)); f.req.query = saved;
    }
});

it('appointment options authorize both the requested calendar and the original appointment calendar', async t => {
    const f = appointmentOptionsFixture(t);
    f.req.query.calendarId = secretaryId; assert.equal((await f.run()).status, 403);
    f.req.query.agendaEventId = eventId; f.req.query.calendarId = operatorId;
    f.event.calendarId = secretaryId; assert.equal((await f.run()).status, 403);
    f.event.calendarId = operatorId; assert.equal((await f.run()).status, 200);
    f.req.query.calendarId = secretaryId; assert.equal((await f.run()).status, 403);
    f.req.query.calendarId = operatorId; f.req.user.perms = ['agenda:update:own'];
    assert.equal((await f.run()).status, 403);
});

it('appointment options isolate patient and appointment by selected structure', async t => {
    const f = appointmentOptionsFixture(t);
    f.req.user.sid = id(99); assert.equal((await f.run()).status, 404);
    f.req.user.sid = structureId; f.req.query.agendaEventId = eventId; f.event.structureId = id(99);
    assert.equal((await f.run()).status, 404);
    f.event.structureId = structureId; f.event.patientId = id(99);
    assert.equal((await f.run()).status, 404);
});

it('appointment options expose legacy only when existing quote patient scope admits the requested patient', async t => {
    const f = appointmentOptionsFixture(t);
    f.req.user.perms.push('quote:read:own');
    let response = await f.run();
    assert.equal(response.status, 200); assert.equal(response.body.data.items.length, 1);
    assert.equal(f.legacyLookups.length, 1);
    const predicate = f.legacyLookups[0][Op.and][1].id[Op.in].val;
    assert.match(predicate, /agenda_events/); assert.ok(predicate.includes(operatorId)); assert.ok(predicate.includes(structureId));
    f.allowLegacy();
    response = await f.run();
    assert.equal(response.body.data.items.length, 2);
    assert.equal(response.body.data.items[1].selectable, false);
    assert.match(response.body.data.items[1].reason, /precedente non è abilitato/);
});

it('appointment options mark recurring requests unavailable instead of omitting patient packages', async t => {
    const f = appointmentOptionsFixture(t); f.req.query.recurring = 'true';
    const response = await f.run(); assert.equal(response.status, 200);
    assert.equal(response.body.data.items.length, 1); assert.equal(response.body.data.items[0].selectable, false);
    assert.match(response.body.data.items[0].reason, /serie/);
});

it('mounts contextual package options before the ID route and retains the unchanged eligible handler', () => {
    const routes = (administrationRouter as any).stack.filter((layer: any) => layer.route).map((layer: any) => layer.route);
    const options = routes.find((route: any) => route.path === '/administration/care-packages/appointment-options');
    assert.ok(options); assert.ok(routes.indexOf(options) < routes.findIndex((route: any) => route.path === '/administration/care-packages/:id'));
    assert.equal(options.stack[options.stack.length - 1].handle, listAppointmentCarePackageOptions);
    const eligible = routes.find((route: any) => route.path === '/administration/care-packages/eligible');
    assert.equal(eligible.stack[eligible.stack.length - 1].handle, listEligibleCarePackages);
    let denied = 0, next = false;
    options.stack[0].handle({user: {sub: operatorId, sid: structureId, perms: ['agenda:create:own']}},
        {status(code: number) {denied = code; return this;}, json() {}}, () => {next = true;});
    assert.equal(denied, 403); assert.equal(next, false);
});
