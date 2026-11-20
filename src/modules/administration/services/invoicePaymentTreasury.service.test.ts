import assert from 'node:assert/strict';
import {it, TestContext} from 'node:test';
import {sequelize} from '../../../config/database.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import {mirrorInvoicePaymentToTreasury, mirrorVoidedInvoicePaymentToTreasury} from './invoicePaymentTreasury.service.js';
import {FinancialAccount} from '../models/index.js';
import {Tenant} from '../../auth/models/index.js';
import {mockTreasuryAutomation} from './treasuryAutomation.fixture.js';

function cashClassificationFixture(t: TestContext) {
    const automation = mockTreasuryAutomation(t), money: Record<string, any>[] = [];
    const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
    const schema = 'rehablo_0123456789abcdef0123456789abcdef', transaction = {LOCK: {UPDATE: 'UPDATE'}} as any;
    const structureId = id(1), accountId = id(2), actorId = id(3), categoryA = id(4), categoryB = id(5);
    const sources: Record<string, any[]> = {invoices: [], invoice_services: [], invoice_products: [], invoice_agenda_events: [],
        care_packages: [], package_templates: [], services: [], products: [], agenda_events: [], event_types: []};
    const record = (row: any) => ({get: (key: any) => typeof key === 'string' ? row[key] : row});
    automation.categories.push({id: categoryA, direction: 'IN', isActive: true}, {id: categoryB, direction: 'IN', isActive: true});
    t.mock.method(FinancialAccount, 'schema', (() => ({findAll: async () => [record({id: accountId, structureId})],
        findOne: async () => record({id: accountId, structureId})})) as any);
    t.mock.method(Tenant, 'findByPk', (async () => record({administrationSettings: {}})) as any);
    t.mock.method(sequelize, 'query', (async (sql: string, options: any) => {
        assert.equal(options.transaction, transaction);
        const args = options.replacements;
        if (sql.includes('INSERT INTO') && sql.includes('treasury_movements')) {
            if (money.some(row => row.sourceId === args.sourceId)) return [[], {}];
            money.push({...args}); return [[{id: args.id}], {}];
        }
        if (sql.includes('JOIN ') && sql.includes('"treasury_classifications"')) return [automation.classifications
            .filter(row => row.sourceKind === args.kind && row.sourceId === args.id
                && (!sql.includes('c."origin" IN') || ['AUTOMATIC', 'SNAPSHOT'].includes(row.origin)))
            .map(row => ({...row, amount: money.find(item => item.id === row.movementId)?.amount})), {}];
        if (sql.includes('pg_advisory_xact_lock')) return [[], {}];
        const table = Object.keys(sources).find(name => sql.includes(`"${name}"`));
        if (!table) throw new Error('Unexpected classification SQL: ' + sql);
        return [sources[table].filter(row => table === 'invoice_agenda_events' ? row.invoiceId === args.id && !row.releasedAt
            : sql.includes('"InvoiceId"') ? row.InvoiceId === args.id : row.id === args.id), {}];
    }) as any);
    const receipt = async (n: number, amount: number, source: Record<string, any>, classification?: any) => {
        await mirrorInvoicePaymentToTreasury(schema, {id: id(n), amount, paidAt: '2026-01-01', createdByUserId: actorId, ...source},
            transaction, {accountId, structureId, paymentMethodId: null, ...(classification === undefined ? {} : {classification})});
    };
    return {...automation, id, sources, money, receipt, categoryA, categoryB};
}

it('mirrors mixed fiscal invoice instalments with exact final category totals and no duplicate money on retry', async t => {
    const f = cashClassificationFixture(t), invoiceId = f.id(20), serviceId = f.id(21), productId = f.id(22);
    const policy = {fund: 'INPS_GS', mode: 'EXCLUDED', rate: 4};
    f.sources.invoices.push({id: invoiceId, issuer: {taxRegime: 'RF01'}, discountType: 'percentage', discountAmount: '10.00',
        invoiceVAT: '19.80', invoiceNet: '203.40', socialSecuritySnapshot: {policy}});
    f.sources.invoice_services.push({id: f.id(23), InvoiceId: invoiceId, ServiceId: serviceId, servicePrice: '100.00', quantity: 1,
        serviceVat: 'N4', socialSecurity: policy});
    f.sources.invoice_products.push({id: f.id(24), InvoiceId: invoiceId, ProductId: productId, productPrice: '100.00', quantity: 1, productVat: '22'});
    f.defaults.push({sourceKind: 'SERVICE', sourceId: serviceId, businessCategoryId: f.categoryA},
        {sourceKind: 'PRODUCT', sourceId: productId, businessCategoryId: f.categoryB});
    await f.receipt(30, .01, {source: 'USER', invoiceId});
    f.defaults.length = 0;
    await f.receipt(31, .01, {source: 'USER', invoiceId});
    await f.receipt(32, 203.38, {source: 'USER', invoiceId});
    await f.receipt(32, 203.38, {source: 'USER', invoiceId});
    const totals = new Map<string, number>();
    f.classifications.flatMap(row => row.allocations).forEach(share => totals.set(share.businessCategoryId,
        (totals.get(share.businessCategoryId) ?? 0) + Math.round(share.amount * 100)));
    assert.deepEqual(Object.fromEntries(totals), {[f.categoryB]: 10980, [f.categoryA]: 9360});
    assert.equal(f.money.length, 3); assert.equal(f.classifications.length, 3); assert.equal(f.snapshots.length, 1);
    assert.equal(f.money.reduce((sum, row) => sum + Math.round(row.amount * 100), 0), 20340);
});

it('classifies quote package purchase money by frozen line amounts, keeping custom portions unclassified', async t => {
    const f = cashClassificationFixture(t), packageId = f.id(20), serviceId = f.id(21), productId = f.id(22);
    f.sources.care_packages.push({id: packageId, quoteId: f.id(23), totalPrice: '130.00', purchaseSnapshot: {quote: {lines: [
        {itemType: 'SERVICE', itemId: serviceId, quantity: 2, unitPrice: 30, total: 60},
        {itemType: 'PRODUCT', itemId: productId, quantity: 1, unitPrice: 40, total: 40},
        {itemType: 'CUSTOM', itemId: null, quantity: 1, unitPrice: 30, total: 30}
    ]}}});
    f.defaults.push({sourceKind: 'SERVICE', sourceId: serviceId, businessCategoryId: f.categoryA},
        {sourceKind: 'PRODUCT', sourceId: productId, businessCategoryId: f.categoryB});
    await f.receipt(30, 65, {source: 'PACKAGE_PURCHASE', carePackageId: packageId, invoiceId: f.id(99)});
    assert.equal(f.classifications[0].sourceKind, 'PACKAGE');
    assert.deepEqual(f.classifications[0].allocations, [{businessCategoryId: null, amount: 15},
        {businessCategoryId: f.categoryA, amount: 30}, {businessCategoryId: f.categoryB, amount: 20}]);
    await f.receipt(31, 65, {source: 'PACKAGE', carePackageId: packageId});
    await f.receipt(32, 65, {source: 'CREDIT', invoiceId: f.id(99)});
    assert.equal(f.money.length, 1); assert.equal(f.classifications.length, 1);
});

it('the package-template default takes priority over its linked service without changing purchase money', async t => {
    const f = cashClassificationFixture(t), packageId = f.id(20), templateId = f.id(21), serviceId = f.id(22);
    f.sources.care_packages.push({id: packageId, templateId, serviceId, totalPrice: '104.00'});
    f.defaults.push({sourceKind: 'PACKAGE_TEMPLATE', sourceId: templateId, businessCategoryId: f.categoryB},
        {sourceKind: 'SERVICE', sourceId: serviceId, businessCategoryId: f.categoryA});
    await f.receipt(30, 104, {source: 'PACKAGE_PURCHASE', carePackageId: packageId});
    assert.deepEqual(f.classifications[0].allocations, [{businessCategoryId: f.categoryB, amount: 104}]);
    assert.equal(f.money[0].amount, 104);
});

it('automatically classifies real appointment receipts through the linked service and keeps later instalments frozen', async t => {
    const automation = mockTreasuryAutomation(t);
    const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
    const [structureId, accountId, eventId, typeId, serviceId, categoryId, actorId] = Array.from({length: 7}, (_, n) => id(n + 1));
    const record = (values: any) => ({get: (key: any) => typeof key === 'string' ? values[key] : values});
    const transaction = {LOCK: {UPDATE: 'UPDATE'}} as any;
    automation.categories.push({id: categoryId, direction: 'IN', isActive: true});
    automation.defaults.push({sourceKind: 'SERVICE', sourceId: serviceId, businessCategoryId: categoryId});
    t.mock.method(FinancialAccount, 'schema', (() => ({findAll: async () => [record({id: accountId, structureId})],
        findOne: async () => record({id: accountId, structureId})})) as any);
    t.mock.method(Tenant, 'findByPk', (async () => record({administrationSettings: {}})) as any);
    let movement = 100;
    t.mock.method(sequelize, 'query', (async (sql: string, options: any) => {
        assert.equal(options.transaction, transaction);
        if (sql.includes('INSERT INTO') && sql.includes('treasury_movements')) return [[{id: id(movement++)}], {}];
        if (sql.includes('FROM ') && sql.includes('"agenda_events"')) return [[{id: eventId, eventTypeId: typeId}], {}];
        if (sql.includes('FROM ') && sql.includes('"event_types"')) return [[{id: typeId, linkedServiceId: serviceId}], {}];
        if (sql.includes('FROM ') && sql.includes('"services"')) return [[{id: serviceId, sellingPrice: 80}], {}];
        if (sql.includes('JOIN ') && sql.includes('"treasury_classifications"')) return [automation.classifications, {}];
        if (sql.includes('pg_advisory_xact_lock')) return [[], {}];
        throw new Error('Unexpected cash SQL: ' + sql);
    }) as any);
    const receipt = {id: id(20), agendaEventId: eventId, amount: 30, paidAt: '2026-01-01', source: 'APPOINTMENT', createdByUserId: actorId};
    await mirrorInvoicePaymentToTreasury('rehablo_0123456789abcdef0123456789abcdef', receipt, transaction, {accountId, structureId, paymentMethodId: null});
    assert.equal(automation.classifications[0].businessCategoryId, categoryId);
    assert.deepEqual(automation.classifications[0].allocations, [{businessCategoryId: categoryId, amount: 30}]);
    automation.defaults.length = 0;
    await mirrorInvoicePaymentToTreasury('rehablo_0123456789abcdef0123456789abcdef', {...receipt, id: id(21), amount: 53.2}, transaction, {accountId, structureId, paymentMethodId: null});
    assert.equal(automation.classifications[1].businessCategoryId, categoryId);
    assert.deepEqual(automation.classifications[1].allocations, [{businessCategoryId: categoryId, amount: 53.2}]);
    assert.equal(automation.snapshots.length, 1);
});

it('mirrors cash using the validated site and its default account when a legacy invoice has no site column', async t => {
    const structureId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const accountId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const transaction = {LOCK:{UPDATE:'UPDATE'}} as any;
    const record = (values:any) => ({get:(key:any) => typeof key === 'string' ? values[key] : values});
    t.mock.method(FinancialAccount, 'schema', (() => ({findAll:async()=>[record({id:accountId,structureId})],
        findOne:async()=>record({id:accountId,structureId})})) as any);
    t.mock.method(Tenant, 'findByPk', (async()=>record({administrationSettings:{}})) as any);
    const queries: Array<{sql: string; options: any}> = [];
    t.mock.method(sequelize, 'query', (async (sql: string, options: any) => {
        assert.equal(options.transaction, transaction);
        if (sql.includes('pg_advisory_xact_lock')) return [[],{}];
        queries.push({sql, options});
        if (sql.includes('financial_accounts')) {
            assert.equal(options.replacements.structureId, structureId);
            return [[{id: accountId}], {}];
        }
        assert.match(sql, /INSERT INTO .*treasury_movements/);
        return [[], {}];
    }) as any);
    await mirrorInvoicePaymentToTreasury('rehablo_0123456789abcdef0123456789abcdef', {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        invoiceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', amount: 40, paidAt: '2026-09-01'
    }, transaction, {structureId, paymentMethodId: null, idempotencyKey: 'settlement_receipt'});
    assert.equal(queries.length, 1);
    assert.equal(queries[0].options.replacements.structureId, structureId);
    assert.equal(queries[0].options.replacements.accountId, accountId);
    assert.equal(queries[0].options.replacements.idempotencyKey, 'settlement_receipt');
    assert.equal(queries[0].options.replacements.amount, 40);
    assert.match(queries[0].sql, /ON CONFLICT .* DO NOTHING/);
});

it('never mirrors an opening balance or its correction into an account', async t => {
    let queryCount = 0;
    t.mock.method(sequelize, 'query', (async () => {queryCount++; return [[], {}];}) as any);
    const payment = {id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', amount: 40, paidAt: null, source: 'OPENING_BALANCE'};
    await mirrorInvoicePaymentToTreasury('rehablo_0123456789abcdef0123456789abcdef', payment);
    await mirrorVoidedInvoicePaymentToTreasury('rehablo_0123456789abcdef0123456789abcdef', payment);
    assert.equal(queryCount, 0);
});

it('opening balance model hooks preserve coverage without cash creation or reversal', async t => {
    let queryCount = 0;
    t.mock.method(sequelize, 'query', (async () => {queryCount++; return [[], {}];}) as any);
    const opening = InvoicePayment.schema('rehablo_0123456789abcdef0123456789abcdef').build({
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', amount: 40, source: 'OPENING_BALANCE', status: 'POSTED'});
    await (InvoicePayment as any).runHooks('afterCreate', opening, {});
    opening.set('status', 'VOID');
    await (InvoicePayment as any).runHooks('afterUpdate', opening, {});
    assert.equal(queryCount, 0);
});

it('rejects a cash insert before persistence when its treasury transaction is absent', async () => {
    const cash = InvoicePayment.schema('rehablo_0123456789abcdef0123456789abcdef').build({
        id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc', amount:40, source:'USER', status:'POSTED'});
    await assert.rejects((InvoicePayment as any).runHooks('beforeCreate', cash, {}), /transazione/);
    await assert.rejects((InvoicePayment as any).runHooks('beforeBulkCreate', [cash], {transaction:{}}), /individuale/);
});

it('never assigns a current cash date to a historical or undated receipt', async t => {
    t.mock.method(sequelize, 'query', (async () => {throw new Error('No historic cash query is allowed');}) as any);
    await mirrorInvoicePaymentToTreasury('rehablo_0123456789abcdef0123456789abcdef', {
        id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc', amount:40, paidAt:null, source:'LEGACY_IMPORT'});
    await assert.rejects(mirrorInvoicePaymentToTreasury('rehablo_0123456789abcdef0123456789abcdef', {
        id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc', amount:40, paidAt:null, source:'USER'}, {} as any), {statusCode:422});
});

function existingPayment(source: any, paidAt: string | null = null) {
    const payment = InvoicePayment.schema('rehablo_0123456789abcdef0123456789abcdef').build({
        id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc', amount:40, source, status:'POSTED', paidAt:paidAt as any},
        {isNewRecord:false, raw:true});
    return payment;
}
it('permits only the trusted transactional completion of a missing historic cash date', async () => {
    for (const source of ['USER','APPOINTMENT','LEGACY_IMPORT']) {
        const payment=existingPayment(source);payment.set('paidAt',new Date('2025-01-01T12:00:00Z'));
        await assert.rejects((InvoicePayment as any).runHooks('beforeUpdate',payment,{transaction:{}}), /immutabile/);
        await assert.rejects((InvoicePayment as any).runHooks('beforeUpdate',payment,{completeHistoricalDate:true}), /immutabile/);
        await (InvoicePayment as any).runHooks('beforeUpdate',payment,{transaction:{},completeHistoricalDate:true});
    }
    const known=existingPayment('USER','2025-01-01');known.set('paidAt',new Date('2025-01-02T12:00:00Z'));
    await assert.rejects((InvoicePayment as any).runHooks('beforeUpdate',known,{transaction:{},completeHistoricalDate:true}), /immutabile/);
    const opening=existingPayment('OPENING_BALANCE');opening.set('paidAt',new Date('2025-01-01T12:00:00Z'));
    await assert.rejects((InvoicePayment as any).runHooks('beforeUpdate',opening,{transaction:{},completeHistoricalDate:true}), /immutabile/);
});
it('rejects legacy cash status changes before persistence when the treasury transaction is missing', async () => {
    const payment=existingPayment('LEGACY_IMPORT');payment.set('status','VOID');
    await assert.rejects((InvoicePayment as any).runHooks('beforeUpdate',payment,{}), /transazione/);
    await (InvoicePayment as any).runHooks('beforeUpdate',payment,{transaction:{}});
});
