import assert from 'node:assert/strict';
import {it} from 'node:test';
import {sequelize} from '../../../config/database.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import {mirrorInvoicePaymentToTreasury, mirrorVoidedInvoicePaymentToTreasury} from './invoicePaymentTreasury.service.js';
import {FinancialAccount} from '../models/index.js';
import {Tenant} from '../../auth/models/index.js';

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
