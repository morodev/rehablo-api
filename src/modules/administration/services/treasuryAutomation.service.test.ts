import assert from 'node:assert/strict';
import {describe,it,TestContext} from 'node:test';
import {Op} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {TreasuryCategory,TreasuryCategoryDefault,TreasuryCategorySnapshot,TreasuryClassification,TreasuryMovementTag,TreasuryTag} from '../models/treasuryClassification.model.js';
import {allocateTreasuryAmount,allocateTreasuryIncrement,choiceShares,normalizeTreasuryClassificationChoice} from './treasuryAutomation.policy.js';
import {assertTreasuryClassificationChoice,classifyTreasuryMovement,copyTreasuryClassification,invoiceTreasuryLineAmounts,previewPaymentClassification,previewTreasuryHistory,saveSourceTreasuryDefault,treasuryCategoryOptions} from './treasuryAutomation.service.js';
import {categoryAnalysis,classificationFilters,matchesClassification} from './treasuryClassification.service.js';
import {migrateTreasuryAutomationTenant} from '../../../database/treasuryAutomationMigration.js';

const uuid=(n:number)=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0');
const tenant=uuid(1),user=uuid(2),site=uuid(3),catA=uuid(4),catB=uuid(5),service=uuid(6),eventType=uuid(7),event=uuid(8),invoice=uuid(9);
const schema='rehablo_'+tenant.replaceAll('-','');
const tx:any={LOCK:{UPDATE:'UPDATE'}};
function fixture(t:TestContext){
    const rows:any={categories:[{id:catA,name:'Fisioterapia',direction:'IN',isActive:true},{id:catB,name:'Prodotti',direction:'IN',isActive:true}],defaults:[],snapshots:[],classifications:[],tags:[],links:[],movements:[],sources:{
        services:[{id:service,name:'Visita'}],event_types:[{id:eventType,linkedServiceId:service,title:'Visita'}],agenda_events:[{id:event,eventTypeId:eventType,structureId:site,calendarId:user,appointmentExpectedAmount:'80.00'}],
        invoices:[{id:invoice,structureId:site,invoiceTotal:100,invoiceNet:100,invoiceVAT:0}],invoice_services:[],invoice_products:[],invoice_agenda_events:[],invoice_payments:[],care_packages:[],expenses:[],package_templates:[],products:[]}};
    const writes:any[]=[],queries:string[]=[];
    const match=(row:any,where:any):boolean=>Reflect.ownKeys(where??{}).every(key=>{
        if(key===Op.or)return where[key].some((term:any)=>match(row,term));
        if(key===Op.and)return where[key].every((term:any)=>match(row,term));
        if(typeof key!=='string')return true;
        const value=where[key];
        if(value&&typeof value==='object'&&value[Op.in])return value[Op.in].includes(row[key]);
        return row[key]===value;
    });
    const wrap=(value:any,kind:string)=>({get:(key:any)=>typeof key==='string'?value[key]:structuredClone(value),update:async(patch:any)=>{Object.assign(value,patch);writes.push({kind,patch});return wrap(value,kind);}});
    for(const [model,kind] of [[TreasuryCategory,'categories'],[TreasuryCategoryDefault,'defaults'],[TreasuryCategorySnapshot,'snapshots'],[TreasuryClassification,'classifications'],[TreasuryTag,'tags'],[TreasuryMovementTag,'links']] as const){
        t.mock.method(model,'schema',((asked:string)=>{assert.equal(asked,schema);return {
            findByPk:async(id:string)=>{const row=rows[kind].find((item:any)=>(item.id??item.movementId)===id);return row?wrap(row,kind):null;},
            findOne:async(options:any)=>{const row=rows[kind].find((item:any)=>match(item,options.where));return row?wrap(row,kind):null;},
            findAll:async(options:any={})=>rows[kind].filter((item:any)=>match(item,options.where)).map((row:any)=>wrap(row,kind)),
            create:async(value:any,options:any)=>{assert.equal(options.transaction,tx);rows[kind].push(structuredClone(value));writes.push({kind,value});return wrap(rows[kind].at(-1),kind);},
            upsert:async(value:any,options:any)=>{assert.equal(options.transaction,tx);const existing=rows[kind].find((row:any)=>row.sourceKind===value.sourceKind&&row.sourceId===value.sourceId);if(existing)Object.assign(existing,value);else rows[kind].push({...value});writes.push({kind,value});},
            destroy:async(options:any)=>{rows[kind]=rows[kind].filter((item:any)=>!match(item,options.where));},
            bulkCreate:async(values:any[],options:any)=>{assert.equal(options.transaction,tx);rows[kind].push(...values);writes.push({kind,values});}
        };}) as any);
    }
    t.mock.method(sequelize,'query',(async(sql:string,options:any={})=>{
        queries.push(sql);assert.ok(!/INSERT INTO.*treasury_movements|UPDATE.*treasury_movements|DELETE FROM.*treasury_movements/i.test(sql),'Classification never writes money');
        if(sql.includes('pg_advisory_xact_lock'))return [[],{}];
        const args=options.replacements??{};
        if(sql.includes('JOIN')&&sql.includes('treasury_classifications')){
            assert.ok(sql.includes("c.\"origin\" IN ('AUTOMATIC','SNAPSHOT')"),'Manual receipt choices must not be compensated by later automatic receipts');
            return [rows.classifications.filter((item:any)=>item.sourceKind===args.kind&&item.sourceId===args.id&&['AUTOMATIC','SNAPSHOT'].includes(item.origin)).map((item:any)=>({...item,amount:item.allocations.reduce((sum:number,part:any)=>sum+part.amount,0)})),{}];
        }
        if(sql.includes('treasury_movements'))return [rows.movements.filter((item:any)=>item.id===args.id),{}];
        const table=Object.keys(rows.sources).find(name=>sql.includes('"'+name+'"'));
        assert.ok(table,'Unexpected query '+sql);
        return [rows.sources[table!].filter((item:any)=>!args.id||(sql.includes('"InvoiceId"')?item.InvoiceId===args.id:sql.includes('"invoiceId"')?item.invoiceId===args.id:item.id===args.id)),{}];
    }) as any);
    t.mock.method(sequelize,'transaction',(async(callback:any)=>callback(tx)) as any);
    const req:any={tenantSchema:schema,user:{id:user,perms:['payment:create:structure','treasury:update:structure'],structureId:site},access:{scope:'structure',structureId:site},query:{},params:{},body:{}};
    return {rows,writes,queries,req};
}
describe('treasury automation allocation policy',()=>{
    it('conserves cents across repeated partial payments and carries rounding to later receipts',()=>{
        const weights=[{businessCategoryId:catA,weight:1},{businessCategoryId:catB,weight:1}];let previous:any[]=[];
        for(let i=0;i<100;i++){const shares=allocateTreasuryIncrement(.01,weights,previous);assert.equal(shares.reduce((sum,item)=>sum+Math.round(item.amount*100),0),1);previous.push(...shares);}
        assert.equal(previous.filter(item=>item.businessCategoryId===catA).reduce((s,item)=>s+item.amount,0).toFixed(2),'0.50');
        assert.equal(previous.filter(item=>item.businessCategoryId===catB).reduce((s,item)=>s+item.amount,0).toFixed(2),'0.50');
    });
    it('supports decimal strings from DB in weights, unknown portions and explicit manual splits',()=>{
        assert.deepEqual(allocateTreasuryAmount(50,[{businessCategoryId:catA,weight:60},{businessCategoryId:null,weight:40}]),[{businessCategoryId:null,amount:20},{businessCategoryId:catA,amount:30}]);
        assert.throws(()=>choiceShares(10,{businessCategoryId:null,allocations:[{businessCategoryId:catA,amount:9}]}),/coincidere/);
        assert.throws(()=>normalizeTreasuryClassificationChoice({businessCategoryId:catA,allocations:[{businessCategoryId:catB,amount:1}]}),/Ripartizione/);
        assert.throws(()=>normalizeTreasuryClassificationChoice({businessCategoryId:null,allocations:[{businessCategoryId:catA,amount:1.001}]}),/Importo/);
        assert.deepEqual(normalizeTreasuryClassificationChoice({businessCategoryId:null,tagIds:[catA,catA]}),{businessCategoryId:null,tagIds:[catA]});
    });
    it('uses frozen product VAT, service contribution and document discount in mixed invoice weights',()=>{
        const policy={fund:'INPS_GS',mode:'EXCLUDED',rate:4};
        const values=invoiceTreasuryLineAmounts({invoiceVAT:22,issuer:{taxRegime:'RF01'},discountType:'percentage',discountAmount:10,socialSecuritySnapshot:{policy}},
            [{servicePrice:'100.00',quantity:1,serviceVat:'N4',socialSecurity:policy}], [{productPrice:'100.00',quantity:1,productVat:'22'}]);
        assert.deepEqual(values.map(value=>Number(value.toFixed(2))),[109.8,93.6]);
        const forfeit=invoiceTreasuryLineAmounts({invoiceVAT:0,issuer:{taxRegime:'RF19'},socialSecuritySnapshot:{policy}},
            [{servicePrice:'100.00',quantity:1,serviceVat:'N4',socialSecurity:policy}], [{productPrice:'100.00',quantity:1,productVat:'22'}]);
        assert.deepEqual(forfeit,[100,104]);
    });
});
describe('automatic classification transaction',()=>{
    it('leaves ordinary payments unclassified when no defaults exist',async t=>{
        const f=fixture(t);
        await classifyTreasuryMovement({schema,movementId:uuid(20),amount:80,direction:'IN',actorId:user,source:{kind:'APPOINTMENT',id:event}},tx);
        assert.equal(f.rows.classifications.length,0);assert.equal(f.rows.snapshots.length,0);assert.equal(f.writes.length,0);
    });
    it('inherits service from event type, freezes the source and preserves it for subsequent installments',async t=>{
        const f=fixture(t);f.rows.defaults.push({sourceKind:'SERVICE',sourceId:service,businessCategoryId:catA});
        await classifyTreasuryMovement({schema,movementId:uuid(20),amount:20,direction:'IN',actorId:user,source:{kind:'APPOINTMENT',id:event}},tx);
        f.rows.defaults[0].businessCategoryId=catB;
        await classifyTreasuryMovement({schema,movementId:uuid(21),amount:60,direction:'IN',actorId:user,source:{kind:'APPOINTMENT',id:event}},tx);
        assert.deepEqual(f.rows.classifications.map((row:any)=>row.businessCategoryId),[catA,catA]);assert.equal(f.rows.snapshots.length,1);
        assert.equal(f.rows.classifications[1].origin,'SNAPSHOT');
    });
    it('creates category shares for a mixed invoice and does not repeat a movement classification',async t=>{
        const f=fixture(t);f.rows.sources.invoice_services.push({id:uuid(30),InvoiceId:invoice,ServiceId:service,quantity:1,servicePrice:'60.00',serviceVat:'N4'});
        f.rows.sources.invoice_products.push({id:uuid(31),InvoiceId:invoice,ProductId:uuid(32),quantity:1,productPrice:'40.00',productVat:'N4'});
        f.rows.defaults.push({sourceKind:'SERVICE',sourceId:service,businessCategoryId:catA},{sourceKind:'PRODUCT',sourceId:uuid(32),businessCategoryId:catB});
        const input:any={schema,movementId:uuid(20),amount:50,direction:'IN',actorId:user,source:{kind:'INVOICE',id:invoice}};
        await classifyTreasuryMovement(input,tx);await classifyTreasuryMovement(input,tx);
        assert.equal(f.rows.classifications.length,1);assert.equal(f.rows.classifications[0].businessCategoryId,null);
        assert.deepEqual(f.rows.classifications[0].allocations,[{businessCategoryId:catA,amount:30},{businessCategoryId:catB,amount:20}]);
    });
    it('keeps an appointment advance category when the balance is collected through a legacy invoice after catalogue changes',async t=>{
        const f=fixture(t);f.rows.defaults.push({sourceKind:'SERVICE',sourceId:service,businessCategoryId:catA});
        await classifyTreasuryMovement({schema,movementId:uuid(20),amount:20,direction:'IN',actorId:user,source:{kind:'APPOINTMENT',id:event}},tx);
        f.rows.defaults[0].businessCategoryId=catB;f.rows.sources.invoices[0].agendaEventId=event;
        f.rows.sources.invoice_services.push({id:uuid(30),InvoiceId:invoice,ServiceId:service,quantity:1,servicePrice:'80.00',serviceVat:'N4'});
        await classifyTreasuryMovement({schema,movementId:uuid(21),amount:60,direction:'IN',actorId:user,source:{kind:'INVOICE',id:invoice}},tx);
        assert.deepEqual(f.rows.classifications.map((row:any)=>row.businessCategoryId),[catA,catA]);
    });
    it('uses each frozen visit category when a multi-appointment invoice groups the same service at different prices',async t=>{
        const f=fixture(t);f.rows.sources.agenda_events[0].appointmentExpectedAmount='60.00';
        f.rows.sources.agenda_events.push({...f.rows.sources.agenda_events[0],id:uuid(18),appointmentExpectedAmount:'40.00'});
        f.rows.snapshots.push({sourceKind:'APPOINTMENT',sourceId:event,weights:[{businessCategoryId:catA,weight:1}]},{sourceKind:'APPOINTMENT',sourceId:uuid(18),weights:[{businessCategoryId:catB,weight:1}]});
        f.rows.sources.invoice_agenda_events.push({invoiceId:invoice,agendaEventId:event,serviceId:service},{invoiceId:invoice,agendaEventId:uuid(18),serviceId:service});
        f.rows.sources.invoice_services.push({id:uuid(31),InvoiceId:invoice,ServiceId:service,quantity:1,servicePrice:'40.00',serviceVat:'N4'},{id:uuid(30),InvoiceId:invoice,ServiceId:service,quantity:1,servicePrice:'60.00',serviceVat:'N4'});
        await classifyTreasuryMovement({schema,movementId:uuid(20),amount:50,direction:'IN',actorId:user,source:{kind:'INVOICE',id:invoice}},tx);
        assert.deepEqual(f.rows.classifications[0].allocations,[{businessCategoryId:catA,amount:30},{businessCategoryId:catB,amount:20}]);
    });
    it('allocates only residual invoice services after linked appointment coverage, retaining product income across installments',async t=>{
        const f=fixture(t);f.rows.sources.invoices[0].invoiceNet=200;f.rows.sources.invoices[0].invoiceTotal=200;
        f.rows.sources.agenda_events[0].appointmentExpectedAmount='100.00';
        f.rows.snapshots.push({sourceKind:'APPOINTMENT',sourceId:event,weights:[{businessCategoryId:catA,weight:1}]});
        // The catalogue changed after the visit, and its prior receipt was explicitly overridden.
        f.rows.defaults.push({sourceKind:'SERVICE',sourceId:service,businessCategoryId:catB},{sourceKind:'PRODUCT',sourceId:uuid(32),businessCategoryId:catB});
        f.rows.sources.invoice_agenda_events.push({invoiceId:invoice,agendaEventId:event,serviceId:service});
        f.rows.sources.invoice_services.push({id:uuid(30),InvoiceId:invoice,ServiceId:service,quantity:1,servicePrice:'100.00',serviceVat:'N4'});
        f.rows.sources.invoice_products.push({id:uuid(31),InvoiceId:invoice,ProductId:uuid(32),quantity:1,productPrice:'100.00',productVat:'N4'});
        f.rows.sources.invoice_payments.push({id:uuid(70),invoiceId:invoice,agendaEventId:event,status:'POSTED',amount:'80.00'}, {id:uuid(71),invoiceId:invoice,agendaEventId:event,status:'VOID',amount:'20.00'});
        f.rows.classifications.push({movementId:uuid(19),sourceKind:'APPOINTMENT',sourceId:event,origin:'MANUAL',allocations:[{businessCategoryId:catB,amount:80}]});
        await classifyTreasuryMovement({schema,movementId:uuid(20),amount:50,direction:'IN',actorId:user,source:{kind:'INVOICE',id:invoice}},tx);
        await classifyTreasuryMovement({schema,movementId:uuid(21),amount:70,direction:'IN',actorId:user,source:{kind:'INVOICE',id:invoice}},tx);
        const shares=f.rows.classifications.slice(1).flatMap((row:any)=>row.allocations);
        assert.equal(shares.filter((part:any)=>part.businessCategoryId===catA).reduce((sum:number,part:any)=>sum+part.amount,0),20);
        assert.equal(shares.filter((part:any)=>part.businessCategoryId===catB).reduce((sum:number,part:any)=>sum+part.amount,0),100);
        assert.equal(f.rows.classifications[0].allocations[0].amount,80);
    });
    it('attributes manual invoice service lines through the linked appointment type without requiring a catalogue service',async t=>{
        const f=fixture(t);f.rows.sources.event_types[0].linkedServiceId=null;
        f.rows.defaults.push({sourceKind:'EVENT_TYPE',sourceId:eventType,businessCategoryId:catA});
        f.rows.sources.invoices[0].agendaEventId=event;
        f.rows.sources.invoice_services.push({id:uuid(30),InvoiceId:invoice,ServiceId:null,quantity:1,servicePrice:'80.00',serviceVat:'N4'});
        f.rows.sources.invoice_agenda_events.push({invoiceId:invoice,agendaEventId:event,serviceId:null});
        await classifyTreasuryMovement({schema,movementId:uuid(20),amount:80,direction:'IN',actorId:user,source:{kind:'INVOICE',id:invoice}},tx);
        assert.equal(f.rows.classifications[0].businessCategoryId,catA);
    });
    it('inherits a package frozen category when its invoice is paid after its template changes',async t=>{
        const f=fixture(t);f.rows.sources.invoices[0].carePackageId=uuid(50);
        f.rows.sources.care_packages.push({id:uuid(50),templateId:uuid(51),totalPrice:100});
        f.rows.defaults.push({sourceKind:'PACKAGE_TEMPLATE',sourceId:uuid(51),businessCategoryId:catB});
        f.rows.snapshots.push({sourceKind:'PACKAGE',sourceId:uuid(50),weights:[{businessCategoryId:catA,weight:100}]});
        await classifyTreasuryMovement({schema,movementId:uuid(20),amount:80,direction:'IN',actorId:user,source:{kind:'INVOICE',id:invoice}},tx);
        assert.equal(f.rows.classifications[0].businessCategoryId,catA);
    });
    it('does not compensate a manual receipt override in the next automatic partial receipt',async t=>{
        const f=fixture(t);f.rows.snapshots.push({sourceKind:'INVOICE',sourceId:invoice,weights:[{businessCategoryId:catA,weight:1},{businessCategoryId:catB,weight:1}]});
        const base={schema,amount:50,direction:'IN' as const,actorId:user,source:{kind:'INVOICE' as const,id:invoice}};
        await classifyTreasuryMovement({...base,movementId:uuid(20),classification:{businessCategoryId:catA}},tx);
        await classifyTreasuryMovement({...base,movementId:uuid(21)},tx);
        assert.deepEqual(f.rows.classifications[1].allocations,[{businessCategoryId:catA,amount:25},{businessCategoryId:catB,amount:25}]);
    });
    it('uses the configured generic income default for an invoice line without a catalogue category',async t=>{
        const f=fixture(t);f.rows.defaults.push({sourceKind:'OPERATION',sourceId:'INVOICE_PAYMENT',businessCategoryId:catA});
        f.rows.sources.invoice_services.push({id:uuid(30),InvoiceId:invoice,ServiceId:null,quantity:1,servicePrice:'80.00',serviceVat:'N4'});
        await classifyTreasuryMovement({schema,movementId:uuid(20),amount:80,direction:'IN',actorId:user,source:{kind:'INVOICE',id:invoice}},tx);
        assert.equal(f.rows.classifications[0].businessCategoryId,catA);
    });
    it('manual choice wins for that payment, explicit unclassified suppresses auto, and tags are atomic metadata',async t=>{
        const f=fixture(t);f.rows.defaults.push({sourceKind:'SERVICE',sourceId:service,businessCategoryId:catA});f.rows.tags.push({id:uuid(40),isActive:true});
        await classifyTreasuryMovement({schema,movementId:uuid(20),amount:80,direction:'IN',actorId:user,source:{kind:'APPOINTMENT',id:event},classification:{businessCategoryId:catB,tagIds:[uuid(40)]}},tx);
        await classifyTreasuryMovement({schema,movementId:uuid(21),amount:80,direction:'IN',actorId:user,source:{kind:'APPOINTMENT',id:event},classification:{businessCategoryId:null}},tx);
        assert.deepEqual(f.rows.classifications.map((row:any)=>row.businessCategoryId),[catB,null]);assert.equal(f.rows.links.length,1);assert.equal(f.rows.snapshots.length,0);
    });
    it('keeps automatic defaults for tags-only choices, including tags with no category configured',async t=>{
        const f=fixture(t);f.rows.tags.push({id:uuid(40),isActive:true});
        f.rows.defaults.push({sourceKind:'OPERATION',sourceId:'MANUAL_IN',businessCategoryId:catA});
        const base={schema,amount:80,direction:'IN' as const,actorId:user,classification:{tagIds:[uuid(40)]}};
        await classifyTreasuryMovement({...base,movementId:uuid(20),source:{kind:'OPERATION',id:'MANUAL_IN'}},tx);
        await classifyTreasuryMovement({...base,movementId:uuid(21),source:{kind:'OPERATION',id:'PATIENT_ADVANCE'}},tx);
        assert.deepEqual(f.rows.classifications.map((row:any)=>row.businessCategoryId),[catA,null]);
        assert.deepEqual(f.rows.classifications.map((row:any)=>row.origin),['AUTOMATIC','AUTOMATIC']);assert.equal(f.rows.links.length,2);
        await classifyTreasuryMovement({...base,movementId:uuid(22),source:{kind:'OPERATION',id:'MANUAL_IN'},classification:{businessCategoryId:null,tagIds:[uuid(40)]}},tx);
        assert.equal(f.rows.classifications[2].businessCategoryId,null);assert.equal(f.rows.classifications[2].origin,'MANUAL');
    });
    it('ignores archived defaults but prevents explicit wrong-direction or archived assignment',async t=>{
        const f=fixture(t);f.rows.categories[0].isActive=false;f.rows.defaults.push({sourceKind:'SERVICE',sourceId:service,businessCategoryId:catA});
        const input:any={schema,movementId:uuid(20),amount:80,direction:'IN',actorId:user,source:{kind:'APPOINTMENT',id:event}};
        await classifyTreasuryMovement(input,tx);assert.equal(f.rows.classifications.length,0);
        await assert.rejects(classifyTreasuryMovement({...input,classification:{businessCategoryId:catA}},tx),/Categoria non disponibile/);
        await assert.rejects(classifyTreasuryMovement({...input,direction:'OUT',classification:{businessCategoryId:catB}},tx),/Categoria non disponibile/);
    });
    it('copies the original shares and tags on date correction without altering either money entry',async t=>{
        const f=fixture(t);f.rows.classifications.push({movementId:uuid(20),businessCategoryId:null,allocations:[{businessCategoryId:catA,amount:60},{businessCategoryId:catB,amount:40}],sourceKind:'INVOICE',sourceId:invoice,origin:'AUTOMATIC',updatedByUserId:user});f.rows.links.push({movementId:uuid(20),tagId:uuid(40)});
        await copyTreasuryClassification(schema,uuid(20),uuid(21),user,tx);await copyTreasuryClassification(schema,uuid(20),uuid(21),user,tx);
        assert.equal(f.rows.classifications.length,2);assert.deepEqual(f.rows.classifications[1].allocations,f.rows.classifications[0].allocations);assert.equal(f.rows.links.length,2);
    });
});
describe('classification access and projections',()=>{
    it('groups unrounded draft source weights by category before allocating the last cent',async t=>{
        const f=fixture(t);const service2=uuid(60),product=uuid(61);
        f.rows.sources.services.push({id:service2});f.rows.sources.products.push({id:product});
        f.rows.defaults.push({sourceKind:'SERVICE',sourceId:service,businessCategoryId:catA},{sourceKind:'SERVICE',sourceId:service2,businessCategoryId:catA},{sourceKind:'PRODUCT',sourceId:product,businessCategoryId:catB});
        f.req.body={direction:'IN',allocationMode:'WEIGHTED',amount:.01,sources:[{kind:'SERVICE',id:service,amount:1},{kind:'SERVICE',id:service2,amount:1},{kind:'PRODUCT',id:product,amount:1}]};
        const result=await previewPaymentClassification(f.req);
        assert.deepEqual(result.allocations,[{businessCategoryId:catA,amount:.01,name:'Fisioterapia'}]);assert.equal(f.writes.length,0);
    });
    it('does not require classification permissions when omitted and rejects unauthorized overrides',t=>{
        const f=fixture(t);f.req.user.perms=['payment:create:structure'];assert.equal(assertTreasuryClassificationChoice(f.req,undefined,site),undefined);
        assert.throws(()=>assertTreasuryClassificationChoice(f.req,{businessCategoryId:catA},site),(e:any)=>e.statusCode===403);
    });
    it('exposes no ledger counts in payment options and rejects cross-site preview',async t=>{
        const f=fixture(t);f.req.user.perms=['payment:create:structure'];
        const options=await treasuryCategoryOptions(f.req,'IN');assert.equal(options.canOverride,false);assert.equal(options.categories.length,2);assert.ok(options.categories.every((row:any)=>!('movementCount'in row)));assert.equal(f.queries.length,0);
        f.rows.sources.agenda_events[0].structureId=uuid(90);f.req.body={direction:'IN',sources:[{kind:'APPOINTMENT',id:event,amount:80}]};
        await assert.rejects(previewPaymentClassification(f.req),(e:any)=>e.statusCode===403);
    });
    it('never overwrites manual historical classifications and only proposes accessible source links',async t=>{
        const f=fixture(t);f.rows.movements.push({id:uuid(20),structureId:site,createdByUserId:user,status:'POSTED'});f.rows.classifications.push({movementId:uuid(20),businessCategoryId:catA});f.req.body={movementIds:[uuid(20)]};
        const result=await previewTreasuryHistory(f.req);assert.equal(result.proposals.length,0);assert.equal(result.skipped.length,1);assert.equal(f.writes.length,0);
    });
    it('returns category labels for a historical preview without writing snapshots or classifications',async t=>{
        const f=fixture(t);f.rows.defaults.push({sourceKind:'SERVICE',sourceId:service,businessCategoryId:catA});
        f.rows.movements.push({id:uuid(20),structureId:site,createdByUserId:user,status:'POSTED',direction:'IN',amount:'80.00',sourceType:'INVOICE_PAYMENT',sourceId:uuid(70)});
        f.rows.sources.invoice_payments.push({id:uuid(70),agendaEventId:event});f.req.body={movementIds:[uuid(20)]};
        const result=await previewTreasuryHistory(f.req);assert.equal(result.proposals[0].allocations[0].name,'Fisioterapia');assert.equal(f.writes.length,0);
    });
    it('only the existing tenant manager may configure defaults, omitted source fields remain no-ops',async t=>{
        const f=fixture(t);await saveSourceTreasuryDefault(f.req,'SERVICE',service,undefined,tx);assert.equal(f.writes.length,0);
        await assert.rejects(saveSourceTreasuryDefault(f.req,'SERVICE',service,catA,tx),(e:any)=>e.statusCode===403);
        f.req.user.perms=['tenant:update:tenant'];await saveSourceTreasuryDefault(f.req,'SERVICE',service,catA,tx);assert.equal(f.rows.defaults[0].businessCategoryId,catA);
    });
    it('filters mixed rows by each category and counts only their unclassified monetary share',()=>{
        const row={id:uuid(20),direction:'IN',amount:100,businessCategoryId:null,classificationState:'partial',classificationAllocations:[{businessCategoryId:catA,amount:60,businessCategory:{name:'Fisioterapia'}},{businessCategoryId:null,amount:40,businessCategory:null}]};
        assert.equal(matchesClassification(row,classificationFilters({businessCategoryId:catA})),true);
        const report=categoryAnalysis([row],'IN');assert.equal(report.income,100);assert.equal(report.movementCount,1);assert.equal(report.unclassifiedAmount,40);assert.equal(report.groups.reduce((sum:number,item:any)=>sum+item.amount,0),100);
    });
});
it('migration adds only metadata and never backfills or changes the financial ledger',async()=>{
    const statements:string[]=[];await migrateTreasuryAutomationTenant({query:async(sql:string,options:any)=>{assert.equal(options.transaction,tx);statements.push(sql);}} as any,schema,tx);
    assert.ok(statements.every(sql=>/^ALTER TABLE|^CREATE /i.test(sql)));assert.ok(statements.every(sql=>!sql.includes('"treasury_movements"')));assert.ok(statements.some(sql=>sql.includes('treasury_category_snapshots')));
});
