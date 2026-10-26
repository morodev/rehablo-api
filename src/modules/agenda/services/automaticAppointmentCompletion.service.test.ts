import assert from 'node:assert/strict';
import {it, TestContext} from 'node:test';
import {Op} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import AgendaEvent from '../models/agendaEvent.model.js';
import EventType from '../models/eventType.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import {CarePackage, PackageConsumption} from '../../administration/models/administration.model.js';
import {completeUntouchedAppointmentById} from './automaticAppointmentCompletion.service.js';
import {autoCompleteEndedAppointmentsForSchema, shouldAutoCompleteAppointment} from './missedArrivalAutomation.service.js';
import {syncPackageAssignment} from './packageAssignment.service.js';

const id=(n:number)=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
const now=new Date('2026-09-01T10:00:00Z'), packageId=id(1), patientId=id(2), structureId=id(3), serviceA=id(4), serviceB=id(5);
const record=(value:any):any=>({...value,
    get(key:unknown){return typeof key==='string'?value[key]:{...value};},
    async update(patch:any){Object.assign(value,patch);Object.assign(this,patch);return this;}});
function fixture(t:TestContext,configuration:{schema?:string;missingColumns?:string[]}={}){
    const schema=configuration.schema??'rehablo_test';
    const event:any={id:id(6),patientId,patient:{id:patientId},structureId,calendarId:id(7),eventTypeId:id(8),status:'CONFIRMED',
        start:'2026-09-01T08:00:00Z',end:'2026-09-01T09:00:00Z',recurrence:null,recurringEventId:null,invoiceId:null,
        missedArrivalReportedAt:null,carePackageId:packageId,carePackageServiceId:serviceA,packageReservationStatus:'RESERVED'};
    const pkg:any={id:packageId,templateId:id(9),patientId,structureId,serviceId:serviceA,name:'Pacchetto',status:'ACTIVE',
        purchasedUnits:1,remainingUnits:1,purchasedAt:'2026-01-01',expiresAt:'2026-09-02'};
    const movements:any[]=[],trace:string[]=[],coverage:any[]=[],candidates:any[]=[{id:event.id}];
    const state:{onLock?:()=>void;failEventSave?:boolean;failLookup?:boolean;otherReservations?:number;linkedInvoice?:boolean}={};
    let tail=Promise.resolve();
    const restore=(target:any,snapshot:any)=>{for(const key of Object.keys(target))delete target[key];Object.assign(target,snapshot);};
    const matches=(row:any,where:any)=>Object.entries(where).every(([key,value])=>row[key]===value);
    t.mock.method(sequelize,'transaction',(async(callback:any)=>{
        const transaction:any={LOCK:{UPDATE:'UPDATE'}};let release:(()=>void)|undefined,snapshot:any;
        transaction.acquire=async()=>{const prior=tail;tail=new Promise<void>(resolve=>release=resolve);await prior;
            snapshot=structuredClone({event,pkg,movements});};
        try{const result=await callback(transaction);trace.push('commit');return result;}
        catch(error){if(snapshot){restore(event,snapshot.event);restore(pkg,snapshot.pkg);movements.splice(0,movements.length,...snapshot.movements);}
            trace.push('rollback');throw error;}
        finally{release?.();}
    }) as any);
    t.mock.method(sequelize,'query',(async(sql:string,options:any)=>{
        if(sql.includes('information_schema.columns'))return [...Object.keys(event),'carePackageId','carePackageServiceId','packageReservationStatus',
            'missedArrivalReportedAt','missedArrivalReportedBy','missedArrivalResolvedAt','missedArrivalResolvedBy',
            'missedArrivalResolution','noShowBillingDecision'].filter(key=>!configuration.missingColumns?.includes(key)).map(columnName=>({columnName}));
        assert.match(sql,/pg_advisory_xact_lock/);await options.transaction.acquire();trace.push('patient-lock');return [[],{}];
    }) as any);
    t.mock.method(AgendaEvent,'schema',(()=>({findAll:async()=>candidates,
        findOne:async(options:any)=>{if(state.failLookup&&options.where.id===id(99))throw Error('unavailable row');
            if(options.lock){trace.push('event-lock');state.onLock?.();}
            for(const key of options.attributes??[])assert.equal(configuration.missingColumns?.includes(key)??false,false);
            const selected=options.attributes?Object.fromEntries(options.attributes.map((key:string)=>[key,event[key]])):{...event};
            const result=record(selected),save=result.update;
            result.update=async(patch:any)=>{trace.push('event-save');if(state.failEventSave)throw Error('event save failed');
                Object.assign(event,patch);return save.call(result,patch);};
            return result;},
        count:async({where}:any)=>{assert.equal(where.id[Op.ne],event.id);return state.otherReservations??0;}})) as any);
    t.mock.method(CarePackage,'schema',(()=>({findAll:async(options:any)=>{
        assert.equal(options.lock,'UPDATE');trace.push('package-lock');return [record(pkg)];}})) as any);
    t.mock.method(PackageConsumption,'schema',(()=>({findOne:async({where}:any)=>{
        const value=movements.find(row=>matches(row,where));return value?record(value):null;},
        create:async(values:any)=>{trace.push('consumption');const value={id:id(100+movements.length),...values};movements.push(value);return record(value);}})) as any);
    t.mock.method(InvoicePayment,'schema',(()=>({findOne:async()=>coverage[0]??null})) as any);
    t.mock.method(InvoiceAgendaEvent,'schema',(()=>({findOne:async(options:any)=>{
        assert.ok(options.transaction);assert.equal(options.where.releasedAt,null);return state.linkedInvoice?{invoiceId:id(90)}:null;
    }})) as any);
    t.mock.method(EventType,'schema',(()=>({findByPk:async()=>{trace.push('type-lookup');return {linkedServiceId:serviceB};}})) as any);
    return {event,pkg,movements,trace,state,coverage,candidates,
        complete:(actorId:string|null=null)=>completeUntouchedAppointmentById(schema,event.id,{now,actorId}),
        async change(patch:any){await (sequelize.transaction as any)(async(transaction:any)=>{
            await (sequelize.query as any)('SELECT pg_advisory_xact_lock(1)',{transaction});
            const row=record(event);await syncPackageAssignment({tenantSchema:'rehablo_test',access:{userId:id(7)},
                user:{sub:id(7),sid:structureId,perms:['care_package:read:structure']}} as any,row,patch,transaction);await row.update(patch);
        });}};
}

it('automatically consumes the last reserved package unit with a system actor and existing lock order',async t=>{
    const f=fixture(t);assert.equal(await f.complete(),true);
    assert.equal(f.event.status,'COMPLETED');assert.equal(f.event.packageReservationStatus,'CONSUMED');
    assert.equal(f.pkg.remainingUnits,0);assert.equal(f.pkg.status,'EXHAUSTED');assert.equal(f.movements.length,1);
    assert.equal(f.movements[0].createdByUserId,null);assert.equal(f.movements[0].serviceId,serviceA);
    assert.match(f.movements[0].note,/automatico/);
    assert.deepEqual(f.trace.slice(0,5),['patient-lock','event-lock','package-lock','consumption','event-save']);
    assert.equal(await f.complete(),false);assert.equal(f.movements.length,1);
});

it('completes FK-only patients while projecting only existing tenant columns',async t=>{
    const f=fixture(t,{schema:'rehablo_fkcompletion'});f.event.patient=null;
    assert.equal(await f.complete(),true);assert.equal(f.event.status,'COMPLETED');assert.equal(f.movements.length,1);
});

it('preserves standalone completion on legacy schemas without patientId or package service columns',async t=>{
    const f=fixture(t,{schema:'rehablo_legacycompletion',missingColumns:['patientId','carePackageServiceId']});
    Object.assign(f.event,{carePackageId:null,carePackageServiceId:null,packageReservationStatus:null});
    assert.equal(await f.complete(),true);assert.equal(f.event.status,'COMPLETED');assert.equal(f.movements.length,0);
    assert.equal(f.trace.includes('package-lock'),false);
});

it('refreshes an incomplete projection after a tenant schema upgrade without restarting the worker',async t=>{
    const missingColumns=['patientId'];const f=fixture(t,{schema:'rehablo_upgradingcompletion',missingColumns});
    f.event.patient=null;assert.equal(await f.complete(),false);assert.equal(f.movements.length,0);
    missingColumns.length=0;assert.equal(await f.complete(),true);assert.equal(f.movements.length,1);
});

it('keeps the caller audit actor on automatic completion without package management permissions',async t=>{
    const f=fixture(t);assert.equal(await f.complete(id(40)),true);assert.equal(f.movements[0].createdByUserId,id(40));
});

it('consumes only the frozen quote service and preserves the unrelated service and financial snapshot',async t=>{
    const f=fixture(t);Object.assign(f.pkg,{templateId:null,quoteId:id(50),purchasedUnits:3,remainingUnits:2,totalPrice:450,
        purchaseSnapshot:{totalPrice:450,booking:{version:1,services:[
            {serviceId:serviceA,serviceName:'Fisio',purchasedUnits:2,remainingUnits:1},
            {serviceId:serviceB,serviceName:'Tecar',purchasedUnits:1,remainingUnits:1}]}}});
    assert.equal(await f.complete(),true);assert.equal(f.pkg.remainingUnits,1);assert.equal(f.pkg.totalPrice,450);
    assert.deepEqual(f.pkg.purchaseSnapshot.booking.services.map((row:any)=>row.remainingUnits),[0,1]);
    assert.equal(f.movements[0].serviceId,serviceA);assert.equal(f.trace.includes('type-lookup'),false);
});

it('restores automatic consumption once when reopened and releases the reservation for no-show',async t=>{
    const f=fixture(t);await f.complete();await f.change({status:'CONFIRMED'});
    assert.equal(f.pkg.remainingUnits,1);assert.equal(f.pkg.status,'ACTIVE');assert.equal(f.event.packageReservationStatus,'RESERVED');
    assert.equal(f.movements[0].status,'REVERSED');assert.equal(f.movements[1].type,'REVERSE');
    assert.equal(f.movements[1].reversalOfId,f.movements[0].id);
    f.event.missedArrivalReportedAt=now;await f.change({status:'NO_SHOW'});
    assert.equal(f.event.packageReservationStatus,'RELEASED');assert.equal(f.pkg.remainingUnits,1);assert.equal(f.movements.length,2);
    assert.equal(await f.complete(),false);
});

it('serializes concurrent worker and request completion of one reserved appointment without double consumption',async t=>{
    const f=fixture(t);const results=await Promise.all([f.complete(),f.complete(id(40))]);
    assert.deepEqual(results.sort(),[false,true]);assert.equal(f.movements.length,1);assert.equal(f.pkg.remainingUnits,0);
});

it('rolls back the ledger and residual when attendance save fails and a retry consumes exactly once',async t=>{
    const f=fixture(t);f.state.failEventSave=true;await assert.rejects(()=>f.complete(),/event save failed/);
    assert.equal(f.event.status,'CONFIRMED');assert.equal(f.event.packageReservationStatus,'RESERVED');
    assert.equal(f.pkg.remainingUnits,1);assert.equal(f.movements.length,0);
    f.state.failEventSave=false;assert.equal(await f.complete(),true);assert.equal(f.movements.length,1);assert.equal(f.pkg.remainingUnits,0);
});

it('rechecks rescheduling and explicit ARRIVING after acquiring locks instead of completing stale candidates',async t=>{
    const f=fixture(t);f.state.onLock=()=>{f.event.start='2026-09-02T08:00:00Z';f.event.end='2026-09-02T09:00:00Z';};
    assert.equal(await f.complete(),false);assert.equal(f.event.status,'CONFIRMED');assert.equal(f.movements.length,0);
    f.state.onLock=()=>{f.event.start='2026-09-01T08:00:00Z';f.event.end='2026-09-01T09:00:00Z';
        f.event.missedArrivalReportedAt=now;f.event.missedArrivalResolvedAt=now;f.event.missedArrivalResolution='ARRIVING';};
    assert.equal(await f.complete(),false);assert.equal(f.movements.length,0);
});

it('rolls back invalid package associations and old usage rather than inferring or assigning coverage',async t=>{
    const f=fixture(t);
    for(const change of [{carePackageServiceId:null},{carePackageServiceId:serviceB}]){
        Object.assign(f.event,change);await assert.rejects(()=>f.complete());assert.equal(f.movements.length,0);assert.equal(f.pkg.remainingUnits,1);
    }
    f.event.carePackageServiceId=serviceA;f.pkg.patientId=id(99);await assert.rejects(()=>f.complete(),/paziente/);
    f.pkg.patientId=patientId;f.coverage.push({source:'PACKAGE',status:'POSTED'});await assert.rejects(()=>f.complete(),/registrazione/);
    f.coverage.length=0;f.movements.push({agendaEventId:f.event.id,type:'CONSUME',status:'POSTED'});
    await assert.rejects(()=>f.complete(),/registrazione/);assert.equal(f.pkg.remainingUnits,1);assert.equal(f.event.status,'CONFIRMED');
});

it('keeps incoherent multiservice history and exhausted reservation capacity unchanged',async t=>{
    const f=fixture(t);Object.assign(f.pkg,{templateId:null,purchasedUnits:3,remainingUnits:2,lines:[
        {id:'a',itemType:'SERVICE',itemId:serviceA,description:'Fisio',quantity:2},
        {id:'b',itemType:'SERVICE',itemId:serviceB,description:'Tecar',quantity:1}]});
    await assert.rejects(()=>f.complete(),/prestazione/);assert.equal(f.movements.length,0);assert.equal(f.event.status,'CONFIRMED');
    Object.assign(f.pkg,{templateId:id(9),purchasedUnits:1,remainingUnits:1});f.state.otherReservations=1;
    await assert.rejects(()=>f.complete(),/prenotate/);assert.equal(f.movements.length,0);
});

it('does not consume an appointment with an active canonical invoice link and no legacy invoice field',async t=>{
    const f=fixture(t);f.state.linkedInvoice=true;assert.equal(f.event.invoiceId,null);
    assert.equal(await f.complete(),false);assert.equal(f.event.status,'CONFIRMED');assert.equal(f.pkg.remainingUnits,1);
    assert.equal(f.movements.length,0);assert.equal(f.trace.includes('package-lock'),false);
});

it('isolates a failed sweep candidate and still completes the next appointment without invoking a real database',async t=>{
    const f=fixture(t);f.candidates.unshift({id:id(99)});f.state.failLookup=true;
    const logger=t.mock.method(console,'error',()=>{});
    assert.equal(await autoCompleteEndedAppointmentsForSchema('rehablo_test',now),1);
    assert.equal(logger.mock.callCount(),1);assert.equal(f.event.status,'COMPLETED');assert.equal(f.movements.length,1);
});

it('retains the 24 hour window and rejects nonreserved packages and all manual report markers',()=>{
    const event:any={start:'2026-09-01T08:00:00Z',end:'2026-09-01T09:00:00Z',status:'CONFIRMED',patientId,
        carePackageId:packageId,packageReservationStatus:'RESERVED'};
    assert.equal(shouldAutoCompleteAppointment(event,new Date('2026-09-02T09:00:00Z')),true);
    assert.equal(shouldAutoCompleteAppointment(event,new Date('2026-09-02T09:00:00.001Z')),false);
    for(const packageReservationStatus of [null,'CONSUMED','RELEASED'])
        assert.equal(shouldAutoCompleteAppointment({...event,packageReservationStatus},now),false);
    for(const resolution of [null,'ARRIVING'])assert.equal(shouldAutoCompleteAppointment({...event,
        missedArrivalReportedAt:now,missedArrivalResolution:resolution,missedArrivalResolvedAt:resolution?now:null},now),false);
});
