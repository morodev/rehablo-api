import assert from 'node:assert/strict';
import {describe, it, TestContext} from 'node:test';
import {Op} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {Structure, StructureUser, TenantUser} from '../../auth/models/index.js';
import {TreasuryMovement} from '../models/index.js';
import {TreasuryCategory, TreasuryTag, TreasuryClassification, TreasuryMovementTag} from '../models/treasuryClassification.model.js';
import {categoryAnalysis, classificationEditable, classificationFilters, classificationValue, decorateTreasuryClassification,
    matchesClassification, readCategoryAnalysis, readTaxonomy, saveClassification, saveTaxonomy, taxonomyValue} from './treasuryClassification.service.js';
import {getTreasuryCategoryAnalysis} from '../controllers/treasuryClassification.controller.js';
import {balanceEffectiveMovements} from './treasuryLedger.service.js';

const uuid = (n: number) => '11111111-1111-4111-8111-' + String(n).padStart(12, '0');
const tenantId=uuid(1), userId=uuid(2), site=uuid(3), otherSite=uuid(4), accountId=uuid(5), movementId=uuid(6), categoryId=uuid(7), tagId=uuid(8), secondTag=uuid(9);
const schema='rehablo_'+tenantId.replaceAll('-','');
const baseMovement=()=>({id:movementId,accountId,structureId:site,direction:'OUT',category:'SUPPLIER_PAYMENT',amount:'12.35',status:'POSTED',occurredAt:'2026-11-17T12:00:00Z',createdByUserId:userId});
function matches(row: any, where: any): boolean {
    return Reflect.ownKeys(where??{}).every(key=>{
        const value=where[key];
        if(key===Op.and)return value.every((term:any)=>matches(row,term));
        if(typeof key!=='string')return true;
        if(value&&typeof value==='object'&&value[Op.in])return value[Op.in].includes(row[key]);
        return row[key]===value;
    });
}
function fixture(t: TestContext) {
    const rows={movements:[baseMovement()] as any[],categories:[{id:categoryId,name:'Materiali',normalizedName:'materiali',direction:'OUT',color:'#6366f1',isActive:true}] as any[],
        tags:[{id:tagId,name:'Sala',isActive:true},{id:secondTag,name:'Progetto',isActive:true}] as any[],classifications:[] as any[],links:[] as any[]};
    const writes:any[]=[],locks:any[]=[],queries:any[]=[];
    const tx={LOCK:{UPDATE:'UPDATE'}};
    t.mock.method(sequelize,'transaction',(async(callback:any)=>callback(tx)) as any);
    const wrap=(row:any,kind:string)=>({get:(key:any)=>typeof key==='string'?row[key]:{...row},update:async(value:any,options:any)=>{
        assert.notEqual(kind,'movements','The financial ledger must never be updated by classification');
        assert.equal(options.transaction,tx);writes.push({kind,value});Object.assign(row,value);return wrap(row,kind);
    }});
    for(const [model,kind] of [[TreasuryMovement,'movements'],[TreasuryCategory,'categories'],[TreasuryTag,'tags'],[TreasuryClassification,'classifications'],[TreasuryMovementTag,'links']] as const){
        t.mock.method(model,'schema',((requested:string)=>{
            assert.equal(requested,schema,'Every read and write stays in the authenticated tenant schema');
            const values=rows[kind];
            return {
                findByPk:async(id:string,options:any={})=>{if(options.lock)locks.push({kind,id,lock:options.lock,transaction:options.transaction});const row=values.find(row=>(row.id??row.movementId)===id);return row?wrap(row,kind):null;},
                findAll:async(options:any={})=>{queries.push({kind,options});return values.filter(row=>matches(row,options.where)).map(row=>wrap(row,kind));},
                count:async(options:any={})=>values.filter(row=>matches(row,options.where)).length,
                create:async(value:any,options:any)=>{assert.notEqual(kind,'movements');assert.equal(options.transaction,tx);if(value.normalizedName&&values.some(row=>row.normalizedName===value.normalizedName))throw Object.assign(new Error(),{name:'SequelizeUniqueConstraintError'});const row={id:uuid(100+values.length),isActive:true,...value};values.push(row);writes.push({kind,value});return wrap(row,kind);},
                destroy:async(options:any)=>{assert.equal(kind,'links');assert.equal(options.transaction,tx);rows.links=rows.links.filter(row=>!matches(row,options.where));},
                bulkCreate:async(values:any[],options:any)=>{assert.equal(kind,'links');assert.equal(options.transaction,tx);rows.links.push(...values);}
            };
        }) as any);
    }
    const req:any={tenantSchema:schema,params:{id:movementId},body:{businessCategoryId:categoryId,tagIds:[tagId]},query:{},
        user:{tid:tenantId,sub:userId,sid:site,role:'OWNER',perms:['treasury:read:tenant','treasury:update:structure','analytics:read:tenant']},
        access:{resource:'treasury',action:'read',scope:'tenant',structureId:site,userId}};
    return {rows,req,writes,locks,queries,tx,wrap};
}
describe('business classification metadata',()=>{
    it('validates fields without accepting financial changes, arbitrary tags or duplicated money rows',()=>{
        assert.throws(()=>classificationValue({businessCategoryId:categoryId,tagIds:[],amount:1}),/non può modificare/);
        assert.throws(()=>classificationValue({businessCategoryId:categoryId,tagIds:['foreign']}),/Tag non valido/);
        assert.deepEqual(classificationValue({businessCategoryId:null,tagIds:[tagId,tagId]}),{businessCategoryId:null,tagIds:[tagId]});
        assert.throws(()=>classificationFilters({tagIds:[tagId]}),/Filtro tag/);
        assert.throws(()=>classificationFilters({classificationEditable:['true']}),/modificabile/);
        assert.throws(()=>classificationFilters({classificationEditable:true}),/modificabile/);
        assert.throws(()=>classificationFilters({classificationEditable:'false'}),/modificabile/);
        assert.throws(()=>classificationFilters({businessCategoryId:categoryId,classificationState:'unclassified'}),/discordanti/);
        assert.throws(()=>taxonomyValue({name:'Materiali',direction:'BOTH'},true,true),/Entrate o Uscite/);
        assert.throws(()=>taxonomyValue({name:'Materiali',color:'url(javascript:1)',direction:'OUT'},true,true),/Colore/);
        assert.equal(taxonomyValue({name:'  Sala   Nuova ',direction:'OUT'},true,true).normalizedName,'sala nuova');
    });
    it('writes only metadata atomically, deduplicates tags and locks ledger plus catalog rows',async t=>{
        const f=fixture(t),before=JSON.stringify(f.rows.movements);
        f.req.body.tagIds=[secondTag,tagId,secondTag];
        const result=await saveClassification(f.req);
        assert.equal(JSON.stringify(f.rows.movements),before);
        assert.equal(result.businessCategoryId,categoryId);assert.equal(result.category,'SUPPLIER_PAYMENT');
        assert.deepEqual(result.tagIds,[tagId,secondTag]);assert.equal(f.rows.links.length,2);
        assert.deepEqual(f.locks.map(item=>item.kind),['movements','categories','tags','tags']);
        assert.ok(f.locks.every(item=>item.lock==='UPDATE'&&item.transaction===f.tx));
        assert.ok(f.writes.every(item=>item.kind!=='movements'));
    });
    it('rejects unauthorized structures and own scopes before any metadata write',async t=>{
        const f=fixture(t);f.rows.movements[0].structureId=otherSite;
        await assert.rejects(saveClassification(f.req),(e:any)=>e.statusCode===403);assert.equal(f.writes.length,0);
        f.rows.movements[0].structureId=site;f.rows.movements[0].createdByUserId=uuid(555);
        f.req.user.perms=['treasury:update:own'];
        await assert.rejects(saveClassification(f.req),(e:any)=>e.statusCode===403);assert.equal(f.writes.length,0);
    });
    it('rejects a category absent from the tenant, incompatible direction or archived new assignments',async t=>{
        const f=fixture(t);f.req.body.businessCategoryId=uuid(999);
        await assert.rejects(saveClassification(f.req),/Categoria non disponibile/);
        f.req.body.businessCategoryId=categoryId;f.rows.categories[0].direction='IN';
        await assert.rejects(saveClassification(f.req),/Categoria non disponibile/);
        f.rows.categories[0].direction='OUT';f.rows.categories[0].isActive=false;
        await assert.rejects(saveClassification(f.req),/Categoria non disponibile/);assert.equal(f.writes.length,0);
    });
    it('preserves archived historical classifications and tags while preventing new archived tags',async t=>{
        const f=fixture(t);f.rows.categories[0].isActive=false;f.rows.tags[0].isActive=false;
        f.rows.classifications.push({movementId,businessCategoryId:categoryId});f.rows.links.push({movementId,tagId});
        const saved=await saveClassification(f.req);assert.equal(saved.businessCategoryId,categoryId);assert.deepEqual(saved.tagIds,[tagId]);
        f.rows.tags[1].isActive=false;f.req.body.tagIds=[tagId,secondTag];
        await assert.rejects(saveClassification(f.req),/Tag non disponibile/);
    });
    it('locks archive and category-direction updates and rejects changes to the direction of used categories',async t=>{
        const f=fixture(t);f.req.params.id=categoryId;f.req.body={isActive:false};
        await saveTaxonomy(f.req,true);assert.equal(f.locks[0].kind,'categories');assert.equal(f.rows.categories[0].isActive,false);
        f.rows.classifications.push({movementId,businessCategoryId:categoryId});f.req.body={direction:'IN'};
        await assert.rejects(saveTaxonomy(f.req,true),(e:any)=>e.statusCode===409);
        f.req.params={};f.req.body={name:' MATERIALI ',direction:'OUT'};
        await assert.rejects(saveTaxonomy(f.req,true),(e:any)=>e.statusCode===409);
    });
    it('cannot classify transfer legs or reversal rows and inherits original metadata across dates',async t=>{
        const f=fixture(t);f.rows.movements[0].sourceType='TRANSFER_OUT';
        await assert.rejects(saveClassification(f.req),/giroconti/);
        delete f.rows.movements[0].sourceType;f.rows.movements[0].reversalOfId=uuid(777);
        await assert.rejects(saveClassification(f.req),/originale/);
        delete f.rows.movements[0].reversalOfId;
        const original=baseMovement(),reversal={...original,id:uuid(77),reversalOfId:movementId,direction:'IN',occurredAt:'2026-12-03T12:00:00Z'};
        f.rows.classifications.push({movementId,businessCategoryId:categoryId});f.rows.links.push({movementId,tagId});
        const decorated=await decorateTreasuryClassification(f.req,[reversal]);
        assert.equal(decorated[0].businessCategory.name,'Materiali');assert.deepEqual(decorated[0].tagIds,[tagId]);assert.equal(decorated[0].classificationEditable,false);
        const wrongSite = await decorateTreasuryClassification(f.req,[{...reversal,structureId:otherSite}]);
        assert.equal(wrongSite[0].businessCategory,null);assert.deepEqual(wrongSite[0].tagIds,[]);
    });
    it('never exposes another structure in taxonomy movement counts',async t=>{
        const f=fixture(t);f.req.access.scope='structure';
        f.rows.movements.push({...baseMovement(),id:uuid(80),structureId:otherSite});
        f.rows.classifications.push({movementId,businessCategoryId:categoryId},{movementId:uuid(80),businessCategoryId:categoryId});
        f.rows.links.push({movementId,tagId},{movementId:uuid(80),tagId});
        const data=await readTaxonomy(f.req);assert.equal(data.categories[0].movementCount,1);assert.equal(data.tags[0].movementCount,1);
        f.req.access.scope='own';const none=await readTaxonomy(f.req);assert.equal(none.categories[0].movementCount,0);
    });
    it('keeps treasury read distinct from classification update capabilities',async t=>{
        const f=fixture(t);f.req.user.perms=['treasury:read:tenant'];
        assert.equal(classificationEditable(f.req,baseMovement()),false);
        f.req.user.perms=['treasury:update:structure'];assert.equal(classificationEditable(f.req,baseMovement()),true);
        assert.equal(classificationEditable(f.req,{...baseMovement(),structureId:otherSite}),false);
    });
});
describe('category analysis',()=>{
    it('excludes both transfer legs and both transfer reversals through the shared financial policy',async t=>{
        const f=fixture(t),rows=['TRANSFER_OUT','TRANSFER_IN','TRANSFER_VOID_OUT','TRANSFER_VOID_IN'].map((sourceType,index)=>({...baseMovement(),id:uuid(300+index),sourceType,direction:index%2?'IN':'OUT'}));
        assert.ok(rows.every(row=>!classificationEditable(f.req,row)));
        const totals=categoryAnalysis(rows,'OUT');
        assert.equal(totals.income,0);assert.equal(totals.outcome,0);assert.equal(totals.movementCount,0);
    });
    it('limits the queue to editable rows without changing the ordinary unclassified breakdown',()=>{
        const original={...baseMovement(),businessCategoryId:null,classificationEditable:true},
            reversal={...baseMovement(),id:uuid(89),reversalOfId:movementId,direction:'IN',businessCategoryId:null,classificationEditable:false};
        const rows=[reversal,original],ordinary=classificationFilters({classificationState:'unclassified'}),queue=classificationFilters({classificationState:'unclassified',classificationEditable:'true'});
        assert.equal(rows.filter(row=>matchesClassification(row,ordinary)).length,2);
        assert.deepEqual(rows.filter(row=>matchesClassification(row,queue)).map(row=>row.id),[movementId]);
    });
    it('rejects compound report parameters before any ledger read',async t=>{
        const f=fixture(t);f.req.query={direction:['IN']};
        await assert.rejects(readCategoryAnalysis(f.req,{}),(e:any)=>e.statusCode===400);
        f.req.query={from:['2026-11-01']};
        await assert.rejects(readCategoryAnalysis(f.req,{}),(e:any)=>e.statusCode===400);
        assert.equal(f.queries.length,0);
    });
    it('counts each movement once for overlapping OR tags and excludes transfer legs',()=>{
        const rows=[{...baseMovement(),businessCategoryId:categoryId,businessCategory:{name:'Materiali',color:'#6366f1'},tagIds:[tagId,secondTag]},
            {...baseMovement(),id:uuid(22),amount:'0.15',businessCategoryId:null,tagIds:[secondTag]},
            {...baseMovement(),id:uuid(23),direction:'IN',amount:'20.00',businessCategoryId:null,tagIds:[secondTag]},
            {...baseMovement(),id:uuid(24),amount:'500',sourceType:'TRANSFER_OUT',tagIds:[tagId]}];
        const result=categoryAnalysis(rows.filter(row=>matchesClassification(row,classificationFilters({tagIds:tagId+','+secondTag}))), 'OUT');
        assert.equal(result.outcome,12.50);assert.equal(result.income,20);assert.equal(result.net,7.50);
        assert.equal(result.movementCount,2);assert.equal(result.classifiedCount,1);assert.equal(result.unclassifiedAmount,0.15);
        assert.equal(result.groups.reduce((sum:number,group:any)=>sum+group.movementCount,0),2);
    });
    it('resolves legacy VOID originals before date filtering and keeps date-specific reversal cash flows',async t=>{
        const f=fixture(t);f.rows.movements[0].status='VOID';f.rows.movements.push({...baseMovement(),id:uuid(88),direction:'IN',reversalOfId:movementId,occurredAt:'2026-12-04T12:00:00Z'});
        f.rows.classifications.push({movementId,businessCategoryId:categoryId});
        f.req.query={from:'2026-11-01',to:'2026-11-30',direction:'OUT'};
        assert.equal((await readCategoryAnalysis(f.req,{})).outcome,12.35);
        f.req.query={from:'2026-12-01',to:'2026-12-31',direction:'IN'};
        const december=await readCategoryAnalysis(f.req,{});assert.equal(december.income,12.35);assert.equal(december.groups[0].categoryId,categoryId);
        assert.equal(balanceEffectiveMovements(f.rows.movements).length,2);
    });
    it('intersects report scopes with the selected-site treasury read scope',async t=>{
        const f=fixture(t);f.req.access.scope='structure';f.req.user.perms=['analytics:read:tenant','treasury:read:structure'];
        f.rows.movements.push({...baseMovement(),id:uuid(99),structureId:otherSite,amount:'999'});
        t.mock.method(TenantUser,'findOne',(async()=>f.wrap({role:'OWNER'},'membership')) as any);
        t.mock.method(Structure,'findAll',(async()=>[f.wrap({id:site,name:'Visible'},'site'),f.wrap({id:otherSite,name:'Other'},'site')]) as any);
        t.mock.method(StructureUser,'findAll',(async()=>[]) as any);
        const response=await new Promise<any>((resolve,reject)=>{const res:any={status(){return this;},json(value:any){resolve(value);}};getTreasuryCategoryAnalysis(f.req,res,reject);});
        assert.equal(response.data.outcome,12.35);assert.equal(response.data.movementCount,1);
    });
});
