import assert from 'node:assert/strict';
import {it} from 'node:test';
import {Op} from 'sequelize';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import {CarePackage, PackageConsumption, PatientCredit, TreasuryMovement} from '../../administration/models/index.js';
import {aggregateFinance, aggregateTherapyPayments, financialSelection, financialSelectionForPeriod, loadFinanceData, therapyPaymentsPayload, type FinanceQuery} from './finance.service.js';
import {dateOnly} from './financialFacts.service.js';
import Patient from '../../patients/models/patient.model.js';
import TimeOffRequest from '../../agenda/models/timeOffRequest.model.js';
import {StructureAvailability, StructureUserAvailability, User} from '../../auth/models/index.js';
import {operationalDataset} from './operationalReporting.service.js';
import {getReportTransaction, withReportReadSnapshot} from './reportReadContext.js';
import {sequelize} from '../../../config/database.js';

const query: FinanceQuery = {from: '2026-01-01', to: '2026-01-31', compare: 'none', granularity: 'month',
    structureId: null, operatorId: null, eventTypeId: null, paymentStatus: 'all', documentStatus: 'all', paymentMethod: null};
const scope = {tenantId: 'tenant', userId: 'reader', scope: 'assigned' as const, selectedStructureIds: ['site'], allowedStructureIds: ['site'], structures: []};
const model = (row: any): any => ({...row, get: (key?: unknown) => typeof key === 'string' ? row[key] : ({...row})});

it('empty therapy selection does not load unrelated financial history', async t => {
    for (const entity of [AgendaEvent, Invoice, InvoicePayment, InvoiceAgendaEvent, CarePackage]) {
        t.mock.method(entity, 'schema', (() => {throw new Error('No database work for empty selection');}) as any);
    }
    const result = await loadFinanceData({tenantSchema: 'test_tenant', query: {}} as any, query, scope, []);
    assert.deepEqual(result.events, []); assert.deepEqual(result.payments, []);
});

it('therapy candidates preserve full cumulative invoice evidence, old payments and authorization without loading unrelated packages', async t => {
    const visible = {id: 'visible', patientId: 'patient', structureId: 'site', calendarId: 'operator', invoiceId: 'bill',
        start: '2026-01-10T09:00:00Z', status: 'COMPLETED', appointmentExpectedAmount: 100, appointmentPaymentHistoryKnown: true};
    const hidden = {...visible, id: 'hidden', structureId: 'hidden-site', start: '2025-01-10T09:00:00Z'};
    const invoice = {id: 'bill', patientID: 'patient', structureId: 'site', agendaEventId: 'visible', invoiceTotal: 200,
        invoiceNet: 200, status: 'partial', documentType: 'fattura', emissionDate: '2025-01-01'};
    const oldPayment = {id: 'old', invoiceId: 'bill', agendaEventId: null, amount: 70, status: 'POSTED',
        source: 'USER', method: 'Bonifico', paidAt: '2025-12-01'};
    let eventReads = 0, invoiceReads = 0;
    t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async (options: any) => {
        eventReads++;
        if (options.attributes) return [visible, hidden].map(model);
        assert.deepEqual(options.where.id[Op.in], ['visible']);
        assert.deepEqual(options.where.structureId[Op.in], ['site']);
        return [model(visible)];
    }})) as any);
    t.mock.method(InvoiceAgendaEvent, 'schema', (() => ({findAll: async ({where}: any) =>
        (where.agendaEventId ? ['visible'] : ['visible', 'hidden']).map(agendaEventId => model({invoiceId: 'bill', agendaEventId}))})) as any);
    t.mock.method(Invoice, 'schema', (() => ({findAll: async ({where}: any) => {
        invoiceReads++;
        assert.deepEqual(where.structureId[Op.in], ['site']);
        assert.ok(where[Op.or].some((branch: any) => branch.agendaEventId?.[Op.in].includes('visible')),
            'reverse-only legacy document links remain candidates');
        return [model(invoice)];
    }})) as any);
    t.mock.method(InvoicePayment, 'schema', (() => ({findAll: async ({where}: any) => {
        assert.ok(where[Op.or].some((branch: any) => branch.invoiceId?.[Op.in].includes('bill')));
        assert.equal(where.paidAt, undefined, 'current document balance includes old instalments');
        return [model(oldPayment)];
    }})) as any);
    t.mock.method(CarePackage, 'schema', (() => {throw new Error('Unrelated package history is not needed');}) as any);
    for (const entity of [PatientCredit, TreasuryMovement]) t.mock.method(entity, 'schema', (() => ({findAll: async () => []})) as any);
    const read = () => loadFinanceData({tenantSchema: 'test_tenant', query: {}} as any, {...query, operatorId: 'operator'}, scope, ['visible', 'visible']);
    const first = await read();
    assert.equal(eventReads, 2); assert.equal(invoiceReads, 1);
    assert.equal(first.scopeCompleteInvoiceIds?.has('bill'), false);
    assert.equal(first.attributableInvoiceIds.has('bill'), false);
    const result = aggregateTherapyPayments(first, query, [{...visible, sourceEventId: 'visible'}]);
    assert.equal(result.details[0].invoicePaymentStatus, 'partial');
    assert.equal(result.totals.invoiceCount, 0, 'mixed document is not assigned to the visible operator');
    oldPayment.amount = 200;
    const updated = aggregateTherapyPayments(await read(), query, [{...visible, sourceEventId: 'visible'}]);
    assert.equal(updated.details[0].invoicePaymentStatus, 'paid', 'a new read sees new ledger evidence');
});

it('reusing selection within one read preserves current debt and old document cash across comparison periods', () => {
    const data = {events: [], packages: [], invoices: [{id: 'bill', invoiceTotal: 100, invoiceNet: 100,
        status: 'partial', documentType: 'fattura', emissionDate: '2025-01-01'}],
        payments: [{id: 'receipt', invoiceId: 'bill', amount: 30, status: 'POSTED', source: 'USER', paidAt: '2026-01-05'}],
        attributableInvoiceIds: new Set(['bill']), excludedMixedInvoiceCount: 0};
    const selected = financialSelection(data, query);
    for (const period of [query, {...query, from: '2026-01-05', to: '2026-01-05'}, {...query, from: '2025-01-01', to: '2025-01-31'}]) {
        assert.deepEqual(aggregateFinance(data, period, financialSelectionForPeriod(selected, period)), aggregateFinance(data, period));
    }
    assert.equal(aggregateFinance(data, query, selected).totals.invoiceOutstanding, 70);
    data.payments[0].amount = 100;
    assert.equal(aggregateFinance(data, query).totals.invoiceOutstanding, 0, 'selection is never cached across reads');
});

it('shared date formatter preserves Rome midnight, summer time and date-only legacy values', () => {
    assert.equal(dateOnly('2026-01-10T23:30:00Z'), '2026-01-11');
    assert.equal(dateOnly('2026-07-10T22:30:00Z'), '2026-07-11');
    assert.equal(dateOnly('2026-03-29T01:30:00Z'), '2026-03-29');
    assert.equal(dateOnly('2026-10-25T01:30:00Z'), '2026-10-25');
    assert.equal(dateOnly('2026-01-10'), '2026-01-10');
    assert.equal(dateOnly(null), ''); assert.equal(dateOnly('invalid'), '');
});

it('session candidate loading keeps previous-period comparison and global cash warnings on the same read snapshot', async t => {
    const previousFlag = process.env.REPORTS_LIVE_READS_ENABLED;
    t.after(() => {if(previousFlag === undefined) delete process.env.REPORTS_LIVE_READS_ENABLED; else process.env.REPORTS_LIVE_READS_ENABLED=previousFlag;});
    const transaction = {id: 'snapshot'} as any;
    t.mock.method(sequelize, 'transaction', (async (options: any, run: any) => {
        assert.equal(options.readOnly,undefined); assert.equal(options.isolationLevel,'REPEATABLE READ'); return run(transaction);
    }) as any);
    t.mock.method(sequelize,'query',(async(sql:string,options:any)=>{
        assert.equal(sql,'SET TRANSACTION READ ONLY'); assert.equal(options.transaction,transaction);return [];
    }) as any);
    const current = {id:'current',structureId:'site',patientId:'patient',calendarId:'operator',start:'2026-01-15T09:00:00Z',
        end:'2026-01-15T10:00:00Z',recurrence:null,status:'COMPLETED',appointmentExpectedAmount:100,appointmentPaymentHistoryKnown:true};
    const prior = {...current,id:'prior',start:'2025-12-15T09:00:00Z',end:'2025-12-15T10:00:00Z'};
    const historic = {...current,id:'historic',start:'2023-01-01T09:00:00Z',end:'2023-01-01T10:00:00Z'};
    const all = [current,prior,historic];
    const candidateSets: string[][] = [];
    let identityReads = 0;
    t.mock.method(AgendaEvent, 'schema', (() => ({findAll:async (options:any) => {
        assert.equal(options.transaction,transaction);
        if(options.where.id){candidateSets.push(options.where.id[Op.in]);return all.filter(row=>options.where.id[Op.in].includes(row.id)).map(model);}
        if(options.attributes?.length === 1){identityReads++;return all.map(model);}
        const range = options.where[Op.or]?.[0]?.start?.[Op.between];
        return (range ? all.filter(row=>row.start>=range[0] && row.start<=range[1]) : all).map(model);
    }})) as any);
    for(const entity of [Invoice,InvoiceAgendaEvent,CarePackage,PatientCredit,TreasuryMovement]) t.mock.method(entity,'schema',(()=>({findAll:async(options:any)=>{
        assert.equal(options.transaction,transaction);return [];
    }})) as any);
    t.mock.method(InvoicePayment,'schema',(()=>({findAll:async(options:any)=>{
        assert.equal(options.transaction,transaction);
        return options.where[Op.or].some((branch:any)=>branch.agendaEventId?.[Op.in].includes('historic'))
            ? [model({id:'undated',agendaEventId:'historic',amount:40,status:'POSTED',source:'USER',paidAt:null})] : [];
    }})) as any);
    t.mock.method(User,'findAll',(async(options:any)=>{assert.equal(options.transaction,transaction);return [model({id:'operator',name:'Anna'})];}) as any);
    for(const entity of [StructureAvailability,StructureUserAvailability]) t.mock.method(entity,'findAll',(async()=>{throw new Error('Session rows do not need capacity schedules');}) as any);
    t.mock.method(TimeOffRequest,'schema',(()=>{throw new Error('Session rows do not need capacity absences');}) as any);
    const req = {tenantSchema:'test_tenant',reportScope:scope,access:{scope:'tenant'},query:{from:'2026-01-01',to:'2026-01-31',compare:'previous_period'}} as any;
    process.env.REPORTS_LIVE_READS_ENABLED='true';
    const optimized = await withReportReadSnapshot(req,snapshot=>{
        assert.equal(getReportTransaction(snapshot),transaction);return operationalDataset(snapshot,'sessions');
    });
    assert.equal(getReportTransaction(req),undefined,'original request is not mutated');
    assert.deepEqual(candidateSets,[['current','prior']]); assert.equal(identityReads,1);
    assert.equal(optimized.summary.find(row=>row.key==='completed')?.previousValue,1);
    assert.equal((optimized.meta.warnings.find(row=>typeof row !== 'string' && row.code==='undated-payments') as any)?.count,1,
        'a warning from 2023 stays visible in the January report');
    process.env.REPORTS_LIVE_READS_ENABLED='false';
    const legacy = await withReportReadSnapshot(req,snapshot=>operationalDataset(snapshot,'sessions'));
    const normalized = (value:any)=>({...value,meta:{...value.meta,generatedAt:undefined}});
    assert.deepEqual(normalized(optimized),normalized(legacy));
});

it('candidate therapy payload preserves package purchase evidence without double counting its cumulative invoice', async t => {
    const previousFlag = process.env.REPORTS_LIVE_READS_ENABLED;
    t.after(() => {if(previousFlag === undefined) delete process.env.REPORTS_LIVE_READS_ENABLED; else process.env.REPORTS_LIVE_READS_ENABLED=previousFlag;});
    const pack = {id:'pack',patientId:'patient',structureId:'site',templateId:'template',serviceId:'service',name:'Percorso',
        purchasedUnits:2,totalPrice:100,invoiceId:'purchase'};
    const invoice = {id:'purchase',patientID:'patient',structureId:'site',carePackageId:'pack',invoiceTotal:100,invoiceNet:100,
        status:'paid',documentType:'fattura',emissionDate:'2025-12-01'};
    const events = ['RESERVED','CONSUMED'].map((packageReservationStatus,n)=>({id:`session-${n}`,patientId:'patient',structureId:'site',
        start:`2026-01-${n+10}T09:00:00Z`,end:`2026-01-${n+10}T10:00:00Z`,recurrence:null,status:'COMPLETED',
        carePackageId:'pack',carePackageServiceId:'service',packageReservationStatus,appointmentExpectedAmount:70}));
    const payments = [model({id:'deposit',carePackageId:'pack',invoiceId:'purchase',amount:30,status:'POSTED',source:'PACKAGE_PURCHASE',method:'Bonifico',paidAt:'2025-12-01'}),
        model({id:'balance',invoiceId:'purchase',amount:70,status:'POSTED',source:'USER',method:'Contanti',paidAt:'2025-12-02'})];
    t.mock.method(AgendaEvent,'schema',(()=>({findAll:async(options:any)=>options.attributes ? [] : events.map(model)})) as any);
    t.mock.method(Invoice,'schema',(()=>({findAll:async({where}:any)=> {
        const selected = !where[Op.or] || where[Op.or].some((branch:any)=>branch.id==='purchase' || branch.id?.[Op.in]?.includes('purchase'));
        return selected ? [model(invoice)] : [];
    }})) as any);
    t.mock.method(InvoicePayment,'schema',(()=>({findAll:async({where}:any)=>where[Op.or].some((branch:any)=>branch.invoiceId?.[Op.in]?.includes('purchase') || branch.carePackageId?.[Op.in]?.includes('pack')) ? payments : []})) as any);
    t.mock.method(CarePackage,'schema',(()=>({findAll:async()=>[model(pack)]})) as any);
    for(const entity of [InvoiceAgendaEvent,PackageConsumption,PatientCredit,TreasuryMovement]) t.mock.method(entity,'schema',(()=>({findAll:async()=>[]})) as any);
    t.mock.method(Patient,'schema',(()=>({findAll:async()=>[model({id:'patient',structureId:'site'})]})) as any);
    const req={tenantSchema:'test_tenant',reportScope:scope,access:{scope:'tenant'},user:{sub:'reader',isSuperAdmin:true},query:{}} as any;
    const filtered={...query,paymentStatus:'paid' as const,documentStatus:'invoiced' as const};
    process.env.REPORTS_LIVE_READS_ENABLED='true';
    const optimized=await therapyPaymentsPayload(req,filtered,1,25);
    process.env.REPORTS_LIVE_READS_ENABLED='false';
    const legacy=await therapyPaymentsPayload(req,filtered,1,25);
    assert.deepEqual(optimized,legacy);
    assert.equal(optimized.totals.packageCount,2); assert.equal(optimized.totals.packageValue,100);
    assert.equal(optimized.totals.collected,0); assert.equal(optimized.totals.invoiceCollected,0);
    assert.equal(optimized.details[0].packageSummary?.paymentStatus,'paid');
    assert.equal(optimized.details[0].packageSummary?.invoiceId,'purchase');
});
