import assert from 'node:assert/strict';
import {it, TestContext} from 'node:test';
import {sequelize} from '../../../config/database.js';
import {FinancialAccount, PaymentMethod} from '../models/index.js';
import {Tenant} from '../../auth/models/index.js';
import {readFinancialOptions, resolveFinancialAccount} from './financialAccountResolver.service.js';
const schema='rehablo_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa';
const site='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const cash='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const bank='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const row=(values:any)=>({get:(key:any)=>typeof key==='string'?values[key]:{...values}});
function fixture(t:TestContext, accounts:any[], preferred?:string) {
    const trace:string[]=[]; const transaction:any={LOCK:{UPDATE:'UPDATE'}};
    t.mock.method(sequelize,'query',(async (_sql:any,options:any)=>{assert.equal(options.transaction,transaction);trace.push('lock');return [[]];}) as any);
    t.mock.method(Tenant,'findByPk',(async()=>row({administrationSettings:{treasury:{defaultAccountByStructureId:{[site]:preferred}}}})) as any);
    t.mock.method(FinancialAccount,'schema',(()=>({
        findAll:async()=>accounts.filter(a=>a.isActive!==false && (!a.structureId||a.structureId===site)).map(row),
        findOne:async(options:any)=>{assert.equal(options.lock,'UPDATE');trace.push('account-lock');return accounts.filter(a=>a.isActive!==false).map(row).find(a=>a.get('id')===options.where.id)??null;},
        create:async(values:any,options:any)=>{assert.equal(options.transaction,transaction);trace.push('create');accounts.push({id:cash,...values});return row(accounts.at(-1));}
    })) as any);
    t.mock.method(PaymentMethod,'schema',(()=>({findAll:async()=>[row({id:bank,label:'Carta'})]})) as any);
    return {trace,transaction};
}
it('GET options never creates a default account; the writer creates one zero opening cash account under lock',async t=>{
    const accounts:any[]=[];const f=fixture(t,accounts);
    const options=await readFinancialOptions(schema,site);
    assert.equal(options.willCreateDefaultAccount,true);assert.equal(accounts.length,0);
    assert.equal(await resolveFinancialAccount(schema,site,null,f.transaction),cash);
    assert.deepEqual(f.trace,['lock','create','account-lock']);
    assert.equal(accounts[0].openingBalance,0);assert.equal(accounts[0].structureId,site);
    assert.equal(await resolveFinancialAccount(schema,site,null,f.transaction),cash);assert.equal(accounts.length,1);
});
it('requires an explicit choice for ambiguous accounts and honours a valid site preference',async t=>{
    const f=fixture(t,[{id:cash,structureId:site},{id:bank,structureId:null}],bank);
    assert.equal(await resolveFinancialAccount(schema,site,null,f.transaction),bank);
    assert.equal(await resolveFinancialAccount(schema,site,cash,f.transaction),cash);
});
it('rejects a stale preference with multiple accounts, and an explicit inactive or foreign account',async t=>{
    const f=fixture(t,[{id:cash,structureId:site},{id:bank,structureId:null},{id:site,structureId:'other'}],'removed');
    await assert.rejects(resolveFinancialAccount(schema,site,null,f.transaction),{statusCode:422});
    await assert.rejects(resolveFinancialAccount(schema,site,site,f.transaction),{statusCode:422});
    await assert.rejects(resolveFinancialAccount(schema,site,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',f.transaction),{statusCode:422});
});
it('excludes foreign-currency accounts and rejects an explicit USD choice', async t=>{
    const f=fixture(t,[{id:cash,structureId:site,currency:'EUR'},{id:bank,structureId:site,currency:'USD'}],bank);
    const options=await readFinancialOptions(schema,site);
    assert.equal(options.defaultAccountId,cash);assert.equal(options.accounts.length,1);
    await assert.rejects(resolveFinancialAccount(schema,site,bank,f.transaction),{statusCode:422});
});
