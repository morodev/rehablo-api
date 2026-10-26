import assert from 'node:assert/strict';
import {it, TestContext} from 'node:test';
import router from './financialOptions.routes.js';
import {FinancialAccount, PaymentMethod} from '../models/index.js';
import {Structure, Tenant} from '../../auth/models/index.js';
import {sequelize} from '../../../config/database.js';
const site='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tenant='cccccccc-cccc-4ccc-8ccc-cccccccccccc', account='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
function setup(t:TestContext) {
    let settings:any={fiscal:{keep:true},treasury:{keep:'yes'}}; let writes=0;
    const row=(values:any)=>({get:(key:any)=>typeof key==='string'?values[key]:values});
    t.mock.method(Structure,'findOne',(async({where}:any)=>where.id===site && where.tenantId===tenant?row({id:site}):null) as any);
    t.mock.method(Tenant,'findByPk',(async()=>({...row({administrationSettings:settings,featureFlags:{administration:false}}),
        update:async(values:any)=>{writes++;settings=values.administrationSettings;}})) as any);
    t.mock.method(FinancialAccount,'schema',(()=>({findAll:async()=>[row({id:account,name:'Conto',type:'BANK',structureId:site,isActive:true})],
        findOne:async()=>row({id:account,structureId:site})})) as any);
    t.mock.method(PaymentMethod,'schema',(()=>({findAll:async()=>[row({id:other,label:'Carta',type:'CARD',code:'CARD',isTraceable:true})]})) as any);
    t.mock.method(sequelize,'transaction',(async(work:any)=>work({LOCK:{UPDATE:'UPDATE'}})) as any);
    t.mock.method(sequelize,'query',(async(sql:string)=>{assert.match(sql,/pg_advisory_xact_lock/);return [[]];}) as any);
    const req:any={tenantSchema:'rehablo_'+tenant.replaceAll('-',''),user:{tid:tenant,sub:other,sid:site,perms:['payment:create:structure']},
        query:{structureId:site},body:{structureId:site,accountId:account}};
    return {req,getSettings:()=>settings,getWrites:()=>writes};
}
async function run(path:string, req:any) {
    const route=(router as any).stack.find((layer:any)=>layer.route?.path===path).route;
    return new Promise<any>(resolve=>{
        const res:any={statusCode:200,status(code:number){this.statusCode=code;return this;},json(body:any){resolve({status:this.statusCode,body});return this;}};
        let index=0;const next=(error?:any)=>{if(error)return resolve({status:error.statusCode??500,body:{message:error.message}});
            route.stack[index++]?.handle(req,res,next);};next();
    });
}
it('payment-only staff obtain minimal options with administration disabled and no treasury balance data',async t=>{
    const f=setup(t);const response=await run('/financial-options',f.req);
    assert.equal(response.status,200);assert.equal(response.body.data.defaultAccountId,account);
    assert.deepEqual(Object.keys(response.body.data.accounts[0]).sort(),['id','name','structureId','type']);
    assert.equal(f.getWrites(),0);
});
it('structure/own choices cannot address a different site, and tenant choices remain tenant isolated',async t=>{
    const f=setup(t);f.req.query.structureId=other;
    assert.equal((await run('/financial-options',f.req)).status,403);
    f.req.user.perms=['treasury:read:tenant'];
    assert.equal((await run('/financial-options',f.req)).status,404);
});
it('preferred account changes require treasury update and preserve unrelated settings',async t=>{
    const f=setup(t);
    assert.equal((await run('/financial-options/default-account',f.req)).status,403);
    f.req.user.perms=['treasury:update:structure'];
    assert.equal((await run('/financial-options/default-account',f.req)).status,200);
    assert.deepEqual(f.getSettings(),{fiscal:{keep:true},treasury:{keep:'yes',defaultAccountByStructureId:{[site]:account}}});
    f.req.body.accountId=null;
    const cleared=await run('/financial-options/default-account',f.req);
    assert.equal(cleared.status,200);assert.equal(cleared.body.data.preferredAccountId,null);assert.equal(cleared.body.data.defaultAccountId,account);
    assert.deepEqual(f.getSettings().treasury.defaultAccountByStructureId,{});
});
