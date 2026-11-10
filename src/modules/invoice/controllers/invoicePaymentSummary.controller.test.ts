import assert from 'node:assert/strict';
import {it} from 'node:test';
import {Op, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import Invoice from '../models/invoice.model.js';
import InvoicePayment from '../models/invoicePayment.model.js';
import {patientScopeWhere} from '../../../middleware/rbac.js';
import {invoicePaymentSummaries} from './invoicePaymentSummary.controller.js';

const id = (value: number) => '11111111-1111-4111-8111-' + String(value).padStart(12, '0');
const record = (row: any): any => ({get: () => ({...row})});
const request = (ids: unknown): any => ({tenantSchema: 'rehablo_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', query: {ids},
    access: {scope: 'structure', structureId: id(99), userId: id(98)}, user: {sub: id(98)}});
function run(req: any): Promise<{status: number; body: any}> {
    return new Promise(resolve => {
        const res: any = {statusCode: 200, status(code: number) {this.statusCode = code; return this;},
            json(body: any) {resolve({status: this.statusCode, body}); return this;}};
        invoicePaymentSummaries(req, res, error => resolve({status: 500, body: error}));
    });
}

it('uses two batch reads, the same detail authorization and live balances including legacy paid invoices', async t => {
    let invoiceReads = 0, paymentReads = 0;
    const transaction = {id: 'read-snapshot'};
    t.mock.method(sequelize, 'transaction', (async (options: any, work: any) => {
        assert.equal(options.isolationLevel, Transaction.ISOLATION_LEVELS.REPEATABLE_READ);
        assert.equal(options.readOnly, undefined);
        return work(transaction);
    }) as any);
    let readOnlySet = false;
    t.mock.method(sequelize, 'query', (async (sql: string, options: any) => {
        assert.equal(sql, 'SET TRANSACTION READ ONLY');
        assert.equal(options.transaction, transaction);
        readOnlySet = true;
    }) as any);
    const req = request([id(1), id(2), id(3), id(1)].join(','));
    t.mock.method(Invoice, 'schema', (() => ({findAll: async (options: any) => {
        assert.equal(readOnlySet, true);
        invoiceReads++; assert.equal(options.transaction, transaction);
        assert.deepEqual(options.where[Op.and][1], patientScopeWhere(req, req.tenantSchema, 'patientID'));
        assert.deepEqual(options.where[Op.and][0].id[Op.in], [id(1), id(2), id(3)]);
        return [record({id: id(1), invoiceTotal: '100.00', invoiceNet: '80.00', status: 'unpaid'}),
            record({id: id(2), invoiceTotal: '50.00', status: 'paid'})];
    }})) as any);
    t.mock.method(InvoicePayment, 'schema', (() => ({findAll: async (options: any) => {
        paymentReads++; assert.equal(options.transaction, transaction);
        assert.deepEqual(options.where.invoiceId[Op.in], [id(1), id(2)]);
        return [record({invoiceId: id(1), amount: '20', status: 'POSTED'}), record({invoiceId: id(1), amount: '50', status: 'VOID'})];
    }})) as any);
    const result = await run(req);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data.items, [
        {id: id(1), invoiceTotal: '100.00', balance: 60, paidAmount: 20, paymentStatus: 'partial'},
        {id: id(2), invoiceTotal: '50.00', balance: 0, paidAmount: 50, paymentStatus: 'paid'}
    ]);
    assert.equal(invoiceReads, 1); assert.equal(paymentReads, 1);
});

it('rejects malformed, missing and unbounded ID inputs before any database access', async t => {
    t.mock.method(Invoice, 'schema', (() => {throw new Error('unexpected database read');}) as any);
    for (const ids of [undefined, '', 'invalid', [id(1)], Array.from({length: 101}, (_, index) => id(index)).join(',')]) {
        assert.equal((await run(request(ids))).status, 400);
    }
});

it('returns no distinguishing missing/forbidden IDs and does not query movements when none are visible', async t => {
    t.mock.method(sequelize, 'transaction', (async (_options: any, work: any) => work({id: 'read-snapshot'})) as any);
    t.mock.method(sequelize, 'query', (async () => undefined) as any);
    t.mock.method(Invoice, 'schema', (() => ({findAll: async () => []})) as any);
    t.mock.method(InvoicePayment, 'schema', (() => {throw new Error('unexpected movement read');}) as any);
    const result = await run(request(id(3)));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data, {items: []});
});
