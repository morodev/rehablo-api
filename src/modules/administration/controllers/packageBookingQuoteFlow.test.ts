import assert from 'node:assert/strict';
import {it, TestContext} from 'node:test';
import {sequelize} from '../../../config/database.js';
import {CarePackage, PackageConsumption, Quote} from '../models/index.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import controller from './administration.controller.js';

const id=(n:number)=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
const row=(values:any):any=>({...values,get(key:unknown){if(typeof key==='string')return this[key];const{get,update,...data}=this;return data;},
    async update(changes:any){Object.assign(this,changes);return this;}});
function fixture(t:TestContext){
    const quote=row({id:id(1),patientId:id(2),structureId:id(3),number:8,status:'ACCEPTED',total:500,
        lines:[{id:'a',itemType:'SERVICE',itemId:id(4),description:'Fisio',quantity:4,unitPrice:50,total:200},
            {id:'b',itemType:'SERVICE',itemId:id(5),description:'Tecar',quantity:6,unitPrice:50,total:300}]});
    const packages:any[]=[],consumptions:any[]=[],payments:any[]=[],reads:any[]=[];
    t.mock.method(Quote,'schema',(()=>({findOne:async(options:any)=>{reads.push(options);return options.where.status===quote.status?quote:null;}})) as any);
    t.mock.method(CarePackage,'schema',(()=>({findOne:async()=>packages[0]??null,create:async(values:any)=>{
        const model=row({id:id(6),status:'ACTIVE',templateId:null,...values});packages.push(model);return model;}})) as any);
    t.mock.method(PackageConsumption,'schema',(()=>({create:async(values:any)=>{consumptions.push(values);return row(values);}})) as any);
    t.mock.method(InvoicePayment,'schema',(()=>({create:async(values:any)=>{payments.push(values);return row(values);}})) as any);
    t.mock.method(sequelize,'transaction',(async(work:any)=>work({LOCK:{UPDATE:'UPDATE'}})) as any);
    t.mock.method(sequelize,'query',(async()=>[[]]) as any);
    const req:any={tenantSchema:'rehablo_test',params:{id:id(1)},body:{},query:{},access:{scope:'tenant',userId:id(7),structureId:id(3)},user:{sub:id(7),sid:id(3),isSuperAdmin:true}};
    const run=(handler:any)=>new Promise<any>(resolve=>handler(req,{code:200,status(code:number){this.code=code;return this;},json(body:any){resolve({code:this.code,...body});return this;}},(error:any)=>resolve({code:error?.statusCode??500,message:error?.message})));
    return{quote,packages,consumptions,payments,reads,req,run};
}

it('creates an automatically bookable multiple-service quote package once without any receipt',async t=>{
    const f=fixture(t);const created=await f.run(controller.createPackageFromQuote);
    assert.equal(created.code,201,created.message);assert.equal(f.packages.length,1);
    assert.deepEqual(f.packages[0].purchaseSnapshot.booking.services.map((service:any)=>[service.serviceId,service.remainingUnits]),[[id(4),4],[id(5),6]]);
    assert.equal(f.packages[0].totalPrice,500);assert.equal(f.packages[0].templateId,null);
    assert.match(f.packages[0].purchasedAt,/^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(f.packages[0].purchaseSnapshot.quote,{id:f.quote.id,number:8,year:undefined,total:500,lines:f.quote.lines});
    assert.equal((await f.run(controller.createPackageFromQuote)).data.reused,true);
    assert.equal(f.packages.length,1);assert.equal(f.payments.length,0);assert.equal(f.consumptions.length,0);
    assert.ok(f.reads.every(options=>options.lock==='UPDATE'));
});

it('preserves a quote with missing service identifiers for explicit setup instead of matching descriptions',async t=>{
    const f=fixture(t);f.quote.lines[0].itemId=null;const created=await f.run(controller.createPackageFromQuote);
    assert.equal(created.code,201);assert.equal(f.packages[0].purchaseSnapshot.booking,undefined);
    assert.deepEqual(f.packages[0].purchaseSnapshot.quote.lines,f.quote.lines);assert.equal(f.payments.length,0);
});

it('rejects the old manual consumption writer once quote booking has been activated',async t=>{
    const f=fixture(t);await f.run(controller.createPackageFromQuote);f.req.params.id=f.packages[0].id;f.req.body={units:1};
    const result=await f.run(controller.consumePackage);assert.equal(result.code,409,result.message);
    assert.equal(f.packages[0].remainingUnits,10);assert.equal(f.consumptions.length,0);assert.equal(f.payments.length,0);
});
