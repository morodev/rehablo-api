import assert from 'node:assert/strict';
import {it, TestContext} from 'node:test';
import {Op} from 'sequelize';
import AgendaEvent from '../models/agendaEvent.model.js';
import EventType from '../models/eventType.model.js';
import Patient from '../../patients/models/patient.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import {CarePackage, PackageConsumption} from '../../administration/models/administration.model.js';
import {syncPackageAssignment, appointmentCarePackageOptions, eligibleCarePackages} from './packageAssignment.service.js';

const id=(n:number)=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
const packageId=id(1),patientId=id(2),structureId=id(3),serviceA=id(4),serviceB=id(5),eventTypeId=id(6),userId=id(7);
const record=(data:any):any=>({...data,get(key:unknown){if(typeof key==='string')return this[key];const {get,update,...plain}=this;return plain;},
    async update(changes:any){Object.assign(this,changes);return this;}});
function fixture(t:TestContext){
    const pkg=record({id:packageId,quoteId:id(8),templateId:null,patientId,structureId,name:'4 sedute da preventivo',
        purchasedUnits:4,remainingUnits:4,status:'ACTIVE',purchasedAt:'2020-01-01',expiresAt:null,
        lines:[{id:'a',itemType:'SERVICE',itemId:serviceA,description:'Fisio',quantity:2},{id:'b',itemType:'SERVICE',itemId:serviceB,description:'Tecar',quantity:2}]});
    const events=[record({id:id(10),patientId,structureId,calendarId:userId,eventTypeId,status:'CONFIRMED',start:'2020-02-01T10:00:00Z',carePackageId:null,packageReservationStatus:null})];
    const movements:any[]=[],coverage:any[]=[],locks:any[]=[];const type={linkedServiceId:serviceA};
    const matches=(row:any,where:any):boolean=>Reflect.ownKeys(where??{}).every(key=>{
        const expected=where[key];if(key===Op.or)return expected.some((part:any)=>matches(row,part));
        if(typeof key!=='string')return true;
        if(expected&&typeof expected==='object'){
            if(expected[Op.in])return expected[Op.in].includes(row[key]);if(expected[Op.notIn])return row[key]!=null&&!expected[Op.notIn].includes(row[key]);if(Object.hasOwn(expected,Op.ne))return row[key]!==expected[Op.ne];
        }return (row[key]??null)===(expected??null);
    });
    t.mock.method(CarePackage,'schema',(()=>({findAll:async(options:any)=>{locks.push(options);if(options.transaction?.acquire)await options.transaction.acquire();return[pkg];}})) as any);
    t.mock.method(EventType,'schema',(()=>({findByPk:async()=>type})) as any);
    t.mock.method(Patient,'schema',(()=>({findOne:async()=>record({id:patientId,structureId})})) as any);
    t.mock.method(AgendaEvent,'schema',(()=>({count:async({where}:any)=>events.filter(row=>matches(row,where)).length,
        findAll:async({where}:any)=>events.filter(row=>matches(row,where)),findByPk:async(key:string)=>events.find(row=>row.id===key)})) as any);
    t.mock.method(PackageConsumption,'schema',(()=>({findOne:async({where}:any)=>movements.find(row=>matches(row,where))??null,
        create:async(values:any)=>{const row=record({id:id(100+movements.length),...values});movements.push(row);return row;}})) as any);
    t.mock.method(InvoicePayment,'schema',(()=>({findOne:async()=>coverage[0]??null})) as any);
    const req:any={tenantSchema:'rehablo_test',query:{},access:{userId},user:{sub:userId,sid:structureId,perms:['quote:read:structure']}};
    const apply=async(event:any,changes:any,transaction:any={LOCK:{UPDATE:'UPDATE'}})=>{await syncPackageAssignment(req,event,changes,transaction);await event.update(changes);};
    return{pkg,events,movements,coverage,locks,type,req,apply};
}

it('reserves and consumes only the quoted service quantity while total units remain for another service',async t=>{
    const f=fixture(t);f.events.push(record({...f.events[0].get({plain:true}),id:id(11)}),record({...f.events[0].get({plain:true}),id:id(12)}));
    await f.apply(f.events[0],{carePackageId:packageId});await f.apply(f.events[1],{carePackageId:packageId});
    await assert.rejects(()=>f.apply(f.events[2],{carePackageId:packageId}),/prestazione/);
    await f.apply(f.events[0],{status:'COMPLETED'});await f.apply(f.events[0],{status:'COMPLETED'});
    assert.equal(f.pkg.remainingUnits,3);assert.equal(f.movements.length,1);assert.equal(f.movements[0].serviceId,serviceA);
    assert.deepEqual(f.pkg.purchaseSnapshot.booking.services.map((row:any)=>row.remainingUnits),[1,2]);
    f.type.linkedServiceId=serviceB;await f.apply(f.events[2],{carePackageId:packageId});
    assert.equal(f.events[2].carePackageServiceId,serviceB);assert.ok(f.locks.every(options=>options.lock==='UPDATE'));
});

it('restores the frozen service on reopening even if the appointment type has been relinked',async t=>{
    const f=fixture(t);await f.apply(f.events[0],{carePackageId:packageId});await f.apply(f.events[0],{status:'COMPLETED'});
    f.type.linkedServiceId=serviceB;await f.apply(f.events[0],{status:'CONFIRMED',eventTypeId});
    assert.equal(f.movements[1].serviceId,serviceA);assert.equal(f.events[0].carePackageServiceId,serviceA);
    assert.deepEqual(f.pkg.purchaseSnapshot.booking.services.map((row:any)=>row.remainingUnits),[2,2]);assert.equal(f.pkg.remainingUnits,4);
    await f.apply(f.events[0],{eventTypeId:id(20)});assert.equal(f.events[0].carePackageServiceId,serviceB);
});

it('does not charge an old package consumption or existing noncash package coverage a second time',async t=>{
    const f=fixture(t);f.coverage.push(record({source:'PACKAGE',status:'POSTED'}));
    await assert.rejects(()=>f.apply(f.events[0],{carePackageId:packageId}),/già stata utilizzata/);
    assert.equal(f.pkg.remainingUnits,4);assert.equal(f.movements.length,0);
    f.coverage.length=0;f.movements.push(record({packageId,agendaEventId:f.events[0].id,type:'CONSUME',status:'POSTED'}));
    await assert.rejects(()=>f.apply(f.events[0],{carePackageId:packageId}),/già stata utilizzata/);
});

it('ignores client service snapshots and clears them when the package is absent',async t=>{
    const f=fixture(t);await f.apply(f.events[0],{carePackageId:packageId,carePackageServiceId:id(99)});
    assert.equal(f.events[0].carePackageServiceId,serviceA);
    await f.apply(f.events[0],{carePackageId:null,carePackageServiceId:id(99)});assert.equal(f.events[0].carePackageServiceId,null);
    await f.apply(f.events[0],{carePackageServiceId:id(99)});assert.equal(f.events[0].carePackageServiceId,null);
});

it('uses quote patient read scope independently from the authorized colleague calendar',async t=>{
    const f=fixture(t);f.req.user.perms=['quote:read:own','agenda:update:structure'];f.events[0].calendarId=id(99);
    await f.apply(f.events[0],{carePackageId:packageId});assert.equal(f.events[0].carePackageId,packageId);
    f.req.user.perms=['care_package:read:structure'];
    await assert.rejects(()=>f.apply(f.events[0],{status:'COMPLETED'}),error=>(error as any).statusCode===403);
});

it('returns quote origin and service-specific capacities without mutating the snapshot or returning money',async t=>{
    const f=fixture(t);f.events[0].carePackageId=packageId;f.events[0].carePackageServiceId=serviceA;f.events[0].packageReservationStatus='RESERVED';
    const [row]=await appointmentCarePackageOptions('rehablo_test',{patientId,structureId,calendarId:userId,eventTypeId,start:'2020-02-01',includeLegacy:true,includeCatalog:false});
    assert.equal(row.origin,'QUOTE');assert.equal(row.quoteId,id(8));assert.equal(row.availableUnits,1);
    assert.deepEqual(row.booking.services.map(service=>[service.serviceId,service.reservedUnits,service.availableUnits]),[[serviceA,1,1],[serviceB,0,2]]);
    assert.equal((row as any).totalPrice,undefined);assert.equal(f.pkg.purchaseSnapshot,undefined);
});

it('treats a reservation with an unknown service snapshot conservatively in both the preview and the locked writer',async t=>{
    const f=fixture(t);f.events[0].carePackageId=packageId;f.events[0].carePackageServiceId=id(99);f.events[0].packageReservationStatus='RESERVED';
    f.events.push(record({...f.events[0].get({plain:true}),id:id(11),carePackageId:null,carePackageServiceId:null,packageReservationStatus:null}),
        record({...f.events[0].get({plain:true}),id:id(12),carePackageId:null,carePackageServiceId:null,packageReservationStatus:null}));
    const [row]=await appointmentCarePackageOptions('rehablo_test',{patientId,structureId,calendarId:userId,eventTypeId,start:'2020-02-01',includeLegacy:true});
    assert.deepEqual(row.booking.services.map(service=>service.availableUnits),[1,1]);
    await f.apply(f.events[1],{carePackageId:packageId});
    await assert.rejects(()=>f.apply(f.events[2],{carePackageId:packageId}),/prestazione/);
});

it('serializes reservations for the last unit of one service while another service still has capacity',async t=>{
    const f=fixture(t);f.pkg.remainingUnits=3;f.pkg.purchaseSnapshot={booking:{version:1,services:[
        {serviceId:serviceA,serviceName:'Fisio',purchasedUnits:2,remainingUnits:1},
        {serviceId:serviceB,serviceName:'Tecar',purchasedUnits:2,remainingUnits:2}]}};
    f.events.push(record({...f.events[0].get({plain:true}),id:id(11)}));
    let tail=Promise.resolve();
    const reserve=async(event:any)=>{const before=tail;let release!:()=>void;tail=new Promise(resolve=>release=resolve);
        try{await f.apply(event,{carePackageId:packageId},{LOCK:{UPDATE:'UPDATE'},acquire:()=>before});}finally{release();}};
    const outcomes=await Promise.allSettled(f.events.map(reserve));
    assert.equal(outcomes.filter(outcome=>outcome.status==='fulfilled').length,1);
    assert.equal(f.events.filter(event=>event.packageReservationStatus==='RESERVED').length,1);assert.equal(f.pkg.remainingUnits,3);
});

it('keeps edit previews and eligible choices on the frozen service after an appointment type is relinked',async t=>{
    const f=fixture(t);await f.apply(f.events[0],{carePackageId:packageId});await f.apply(f.events[0],{status:'COMPLETED'});
    f.type.linkedServiceId=serviceB;
    const context={patientId,structureId,calendarId:userId,eventTypeId,start:'2020-02-01',agendaEventId:f.events[0].id,includeLegacy:true};
    const [option]=await appointmentCarePackageOptions('rehablo_test',{...context,currentEvent:f.events[0].get({plain:true})});
    const [eligible]=await eligibleCarePackages('rehablo_test',context);
    assert.equal(option.serviceId,serviceA);assert.equal(eligible.serviceId,serviceA);assert.equal(option.availableUnits,2);assert.equal(option.selectable,true);
    const [changed]=await appointmentCarePackageOptions('rehablo_test',{...context,eventTypeId:id(25),currentEvent:f.events[0].get({plain:true})});
    assert.equal(changed.serviceId,serviceB);assert.equal(changed.availableUnits,2);
});
