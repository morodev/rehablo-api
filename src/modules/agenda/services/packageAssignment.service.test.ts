import assert from 'node:assert/strict';
import {it, TestContext} from 'node:test';
import {Op} from 'sequelize';
import AgendaEvent from '../models/agendaEvent.model.js';
import EventType from '../models/eventType.model.js';
import {CarePackage, PackageConsumption} from '../../administration/models/administration.model.js';
import {packageCompatibilityError, syncPackageAssignment, eligibleCarePackages} from './packageAssignment.service.js';

const id = (n: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0');
const packageId=id(1), patientId=id(2), structureId=id(3), serviceId=id(4), eventTypeId=id(5);
const record = (data: Record<string, any>): any => ({...data,
    get(key: string | object) {if (typeof key === 'string') return this[key]; const {get,update,...plain}=this; return plain;},
    async update(patch: Record<string, any>) {Object.assign(this,patch); return this;}});
const packageData = () => ({id:packageId,templateId:id(6),patientId,structureId,serviceId,status:'ACTIVE',remainingUnits:2,purchasedUnits:2,
    purchasedAt:'2025-01-01',expiresAt:'2025-12-31'});
const eventData = (n=7) => ({id:id(n),patientId,structureId,eventTypeId,status:'CONFIRMED',start:'2025-02-01T10:00:00Z',
    carePackageId:null,packageReservationStatus:null});

function fixture(t: TestContext) {
    const pkg=record(packageData()), events=[record(eventData())], movements:any[]=[], locks:any[]=[];
    const req:any={tenantSchema:'rehablo_test',access:{userId:id(9)},user:{sub:id(9),sid:structureId,perms:['care_package:read:structure']}};
    t.mock.method(CarePackage,'schema',(()=>({findAll:async (options:any)=>{
        locks.push(options); if (options.transaction?.acquire) await options.transaction.acquire(); return [pkg];
    }})) as any);
    t.mock.method(EventType,'schema',(()=>({findByPk:async()=>({linkedServiceId:serviceId})})) as any);
    t.mock.method(AgendaEvent,'schema',(()=>({count:async({where}:any)=>events.filter(row=>row.carePackageId===where.carePackageId
        &&row.packageReservationStatus==='RESERVED'&&row.id!==where.id?.[Op.ne]).length,
        findByPk:async(eventId:string)=>events.find(row=>row.id===eventId)})) as any);
    t.mock.method(PackageConsumption,'schema',(()=>({findOne:async({where}:any)=>movements.find(row=>Object.entries(where).every(([key,value])=>row[key]===value)),
        create:async(data:any)=>{const row=record({id:id(20+movements.length),...data});movements.push(row);return row;}})) as any);
    const apply=async(event:any,patch:any,transaction:any={LOCK:{UPDATE:'UPDATE'}})=>{
        await syncPackageAssignment(req,event,patch,transaction);await event.update(patch);return patch;
    };
    return {pkg,events,movements,locks,apply,req};
}

it('requires the patient, site, linked service and appointment date of a current package',()=>{
    const pkg=packageData(), event=eventData();
    assert.equal(packageCompatibilityError(pkg,event,serviceId),null);
    for(const patch of [{patientId:id(99)},{structureId:id(99)},{recurrence:'FREQ=WEEKLY'},{start:'2026-01-01T10:00:00Z'},{start:'2024-12-31T10:00:00Z'}])
        assert.ok(packageCompatibilityError(pkg,{...event,...patch},serviceId));
    assert.ok(packageCompatibilityError(pkg,event,id(99)));
    assert.ok(packageCompatibilityError({...pkg,templateId:null},event,serviceId));
});
it('reserves on saving, preserves a valid move, consumes once on completion, and audits reopening',async t=>{
    const f=fixture(t), event=f.events[0];
    await f.apply(event,{carePackageId:packageId});
    assert.equal(event.packageReservationStatus,'RESERVED');assert.equal(f.pkg.remainingUnits,2);assert.equal(f.movements.length,0);
    await f.apply(event,{start:'2025-02-02T10:00:00Z'});assert.equal(event.carePackageId,packageId);
    await f.apply(event,{status:'COMPLETED'});await f.apply(event,{status:'COMPLETED'});
    assert.equal(f.pkg.remainingUnits,1);assert.equal(f.movements.length,1);assert.equal(event.packageReservationStatus,'CONSUMED');
    await f.apply(event,{status:'CONFIRMED'});
    assert.equal(event.packageReservationStatus,'RESERVED');assert.equal(f.pkg.remainingUnits,2);
    assert.equal(f.movements[0].status,'REVERSED');assert.equal(f.movements[1].reversalOfId,f.movements[0].id);
    assert.ok(f.locks.every(options=>options.lock==='UPDATE'));
});
it('releases reservations on cancellation or no-show and keeps the consumed balance unchanged',async t=>{
    const f=fixture(t),event=f.events[0];
    await f.apply(event,{carePackageId:packageId});await f.apply(event,{status:'CANCELLED'});
    assert.equal(event.packageReservationStatus,'RELEASED');assert.equal(f.pkg.remainingUnits,2);
    await f.apply(event,{status:'CONFIRMED'});await f.apply(event,{status:'NO_SHOW'});
    assert.equal(event.packageReservationStatus,'RELEASED');assert.equal(f.movements.length,0);
});
it('serializes two reservations for the last available session',async t=>{
    const f=fixture(t);f.pkg.remainingUnits=1;f.events.push(record(eventData(8)));
    let tail=Promise.resolve();
    const reserve=async(event:any)=>{const before=tail;let release!:()=>void;tail=new Promise(resolve=>release=resolve);
        try {await f.apply(event,{carePackageId:packageId},{LOCK:{UPDATE:'UPDATE'},acquire:()=>before});}finally {release();}};
    const outcomes=await Promise.allSettled(f.events.map(reserve));
    assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(f.events.filter(event=>event.packageReservationStatus==='RESERVED').length,1);
    assert.equal(f.pkg.remainingUnits,1);
});
it('rejects an incompatible move and cannot consume a future appointment',async t=>{
    const f=fixture(t),event=f.events[0];await f.apply(event,{carePackageId:packageId});
    await assert.rejects(()=>f.apply(event,{start:'2026-01-01T10:00:00Z'}),/validità/);
    f.pkg.expiresAt=null;await assert.rejects(()=>f.apply(event,{start:'2099-01-01T10:00:00Z',status:'COMPLETED'}),/futura/);
    assert.equal(f.pkg.remainingUnits,2);assert.equal(event.packageReservationStatus,'RESERVED');
});
it('does not consume a package by attaching it to an already completed historical appointment',async t=>{
    const f=fixture(t);f.events[0].status='COMPLETED';
    await assert.rejects(()=>f.apply(f.events[0],{carePackageId:packageId}),/Riapri/);
    assert.equal(f.movements.length,0);assert.equal(f.pkg.remainingUnits,2);
});
it('uses the caller tenant schema and refuses package assignment without operational reading rights',async t=>{
    const f=fixture(t);f.req.user.perms=[];
    await assert.rejects(()=>f.apply(f.events[0],{carePackageId:packageId}),/Non puoi/);
    assert.equal(f.locks.length,0);assert.equal(f.events[0].carePackageId,null);
});
it('keeps the assigned exhausted package selectable when correcting its completed appointment',async t=>{
    const f=fixture(t);Object.assign(f.pkg,{remainingUnits:0,status:'EXHAUSTED'});
    Object.assign(f.events[0],{carePackageId:packageId,packageReservationStatus:'CONSUMED'});
    const items=await eligibleCarePackages('rehablo_test',{patientId,structureId,eventTypeId,start:f.events[0].start,agendaEventId:f.events[0].id});
    assert.equal(items.length,1);assert.equal(items[0].availableUnits,1);
});
