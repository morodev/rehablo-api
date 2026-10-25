import {sequelize} from '../../../config/database.js';
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {Op} from 'sequelize';
import {resolveOverviewDate} from './reports.controller.js';
import {findAllInvoices} from './invoice.controller.js';
import Invoice from '../models/invoice.model.js';
import InvoicePayment from '../models/invoicePayment.model.js';
import InvoiceProduct from '../models/invoiceProduct.model.js';
import InvoiceService from '../models/invoiceService.model.js';
import InvoiceAgendaEvent from '../models/invoiceAgendaEvent.model.js';
import Patient from '../../patients/models/patient.model.js';

describe('dashboard economic overview date', () => {
    it('accepts today and past dates', () => {
        assert.equal(resolveOverviewDate(undefined, '2026-09-08'), '2026-09-08');
        assert.equal(resolveOverviewDate('2026-09-07', '2026-09-08'), '2026-09-07');
    });

    it('rejects invalid and future dates', () => {
        assert.throws(() => resolveOverviewDate('2026-02-30', '2026-09-08'), /non valida/);
        assert.throws(() => resolveOverviewDate('2026-09-09', '2026-09-08'), /non valida/);
    });
});

describe('invoice list cash and coverage aggregates', () => {
    const movement = (values: Record<string, any>) => ({invoiceId: 'invoice-1', source: 'USER', status: 'POSTED', paidAt: '2026-01-10', ...values});
    const scenarios = [
        {name: 'mixed credit20 and cash40 settle the invoice with only 40 in collected cash',
            payments: [movement({amount: 40}), movement({amount: 20, source: 'CREDIT'})], cash: 40, undated: 0, paid: 60, balance: 0},
        {name: 'undated credit coverage never becomes historical cash on a void invoice', status: 'void',
            payments: [movement({amount: 60, source: 'CREDIT', paidAt: null})], cash: 0, undated: 0, paid: 60, balance: 0},
        {name: 'only the cash part is counted when mixed coverage has no receipt date',
            payments: [movement({amount: 40, paidAt: null}), movement({amount: 20, source: 'CREDIT', paidAt: null})], cash: 0, undated: 40, paid: 60, balance: 0},
        {name: 'a retained original cash receipt with status CREDIT remains in cash while coverage is counted once',
            payments: [movement({amount: 40, status: 'CREDIT'}), movement({amount: 20, source: 'CREDIT'})], cash: 40, undated: 0, paid: 20, balance: 40},
        {name: 'legacy paid invoices without a ledger retain their undated cash compatibility fallback',
            payments: [], cash: 0, undated: 60, paid: 60, balance: 0}
    ];
    for (const scenario of scenarios) {
        it(scenario.name, async t => {
            const record = (values: Record<string, any>) => ({get(key?: any) {return typeof key === 'string' ? values[key] : values;}});
            const invoice = record({id: 'invoice-1', patientID: 'patient-1', documentType: 'fattura',
                documentNumber: 1, documentYear: 2026, emissionDate: '2026-01-01', invoiceTotal: 60, invoiceNet: 60,
                status: scenario.status ?? 'paid', products: [], services: []});
            t.mock.method(Invoice, 'schema', (() => ({findAll: async () => [invoice]})) as any);
            t.mock.method(InvoiceProduct, 'schema', (() => ({})) as any);
            t.mock.method(InvoiceService, 'schema', (() => ({})) as any);
            t.mock.method(InvoiceAgendaEvent, 'schema', (() => ({})) as any);
            t.mock.method(Patient, 'schema', (() => ({findAll: async () => []})) as any);
            t.mock.method(InvoicePayment, 'schema', (() => ({findAll: async (options: any) => scenario.payments
                .filter(payment => !options.where.status || options.where.status[Op.in].includes(payment.status)).map(record)})) as any);
            const result = await new Promise<{code: number; data?: any; message?: string}>(resolve => {
                const req: any = {tenantSchema: 'rehablo_test', access: {scope: 'tenant'}, query: {month: '2026-01'}};
                const res: any = {code: 200, status(code: number) {this.code = code; return this;},
                    json(payload: any) {resolve({code: this.code, ...payload}); return this;}};
                findAllInvoices(req, res, (error?: any) => resolve({code: error?.statusCode ?? 500, message: error?.message}));
            });
            assert.equal(result.code, 200, result.message);
            assert.equal(result.data.aggregates.collectedInPeriod, scenario.cash);
            assert.equal(result.data.aggregates.undatedPaidAmount, scenario.undated);
            assert.equal(result.data.aggregates.paidAmount, scenario.paid);
            assert.equal(result.data.aggregates.balance, scenario.balance);
            assert.equal(result.data.invoices[0].paidAmount, scenario.paid);
            assert.equal(result.data.invoices[0].balance, scenario.balance);
        });
    }
});

describe('invoice list server ordering', () => {
    type Row = Record<string, any>;
    const invoice = (id: string, documentNumber: number | null, documentYear: number | null, emissionDate: string | null): Row => ({
        id, documentNumber, documentYear, emissionDate, patientID: 'patient-1', documentType: 'fattura',
        invoiceTotal: 60, invoiceNet: 60, status: 'unpaid', paymentTerms: '2020-01-01', products: [], services: [],
    });
    function fixture(t: import('node:test').TestContext, invoices: Row[], payments: Row[] = []) {
        t.mock.method(sequelize, 'query', (async () => {throw new Error('Unmocked SQL is forbidden in invoice sorting unit tests');}) as any);
        const reads: any[] = [];
        const record = (value: Row) => ({get(key?: unknown) {return typeof key === 'string' ? value[key] : value;}});
        // Simulate PostgreSQL ordering independently of the list's sorting policy.
        const ordered = (order: Array<[string, string]>) => [...invoices].sort((left, right) => {
            for (const [field, direction] of order) {
                const a = left[field], b = right[field];
                if (a == null || b == null) {
                    if (a == null && b == null) continue;
                    return a == null ? 1 : -1;
                }
                const comparison = a < b ? -1 : a > b ? 1 : 0;
                if (comparison) return direction.startsWith('DESC') ? -comparison : comparison;
            }
            return 0;
        });
        t.mock.method(Invoice, 'schema', (() => ({findAll: async (options: any) => {reads.push(options); return ordered(options.order).map(record);}})) as any);
        t.mock.method(InvoiceProduct, 'schema', (() => ({})) as any);
        t.mock.method(InvoiceService, 'schema', (() => ({})) as any);
        t.mock.method(InvoiceAgendaEvent, 'schema', (() => ({})) as any);
        t.mock.method(Patient, 'schema', (() => ({findAll: async () => [{id: 'patient-1', name: 'Mario', surname: 'Rossi'}]})) as any);
        t.mock.method(InvoicePayment, 'schema', (() => ({findAll: async (options: any) => payments.filter(payment => {
            const ids = options.where.invoiceId;
            return (!ids || (typeof ids === 'string' ? ids === payment.invoiceId : ids[Op.in].includes(payment.invoiceId)))
                && (!options.where.status || options.where.status[Op.in].includes(payment.status));
        }).map(record)})) as any);
        return {reads, run: (query: Record<string, unknown> = {}) => new Promise<{code: number; data?: any; message?: string}>(resolve => {
            const req: any = {tenantSchema: 'rehablo_test', access: {scope: 'tenant'}, query};
            const res: any = {code: 200, status(code: number) {this.code = code; return this;}, json(payload: any) {resolve({code: this.code, ...payload}); return this;}};
            findAllInvoices(req, res, (error?: any) => resolve({code: error?.statusCode ?? 500, message: error?.message}));
        })};
    }
    it('orders the complete result before returning multiple pages rather than sorting each page independently', async t => {
        const rows = Array.from({length: 35}, (_, index) => invoice(`n${index + 1}`, index + 1, 2025, '2025-10-10'));
        rows.splice(10, 0, invoice('next-year', 1, 2026, '2026-01-01'));
        const f = fixture(t, rows), returned: string[] = [];
        for (let page = 1; page <= 4; page++) {
            const result = await f.run({page: String(page), size: '10'});
            assert.equal(result.code, 200, result.message); assert.equal(result.data.pagination.length, 36);
            returned.push(...result.data.invoices.map((row: Row) => row.id));
        }
        assert.deepEqual(returned, ['next-year', ...Array.from({length: 35}, (_, index) => `n${35 - index}`)]);
        assert.equal(new Set(returned).size, 36);
        assert.ok(f.reads.every(read => read.order.length === 4 && read.limit === undefined && read.offset === undefined));
    });
    it('compares document 2 and 10 numerically, sorts years together and stabilizes equal dates and numbers', async t => {
        const f = fixture(t, [invoice('b', 10, 2026, '2026-10-20'), invoice('legacy', null, null, null),
            invoice('d', 99, 2025, '2025-12-31'), invoice('c', 2, 2026, '2026-10-20'),
            invoice('a', 10, 2026, '2026-10-20'), invoice('e', 1, 2026, '2026-10-21')]);
        for (const [sort, direction, expected] of [
            ['date', 'desc', ['e', 'a', 'b', 'c', 'd', 'legacy']],
            ['date', 'asc', ['d', 'a', 'b', 'c', 'e', 'legacy']],
            ['document', 'desc', ['a', 'b', 'c', 'e', 'd', 'legacy']],
            ['document', 'asc', ['d', 'e', 'c', 'a', 'b', 'legacy']],
        ] as const) {
            const result = await f.run({sort, direction, size: '100'}); assert.equal(result.code, 200, result.message);
            assert.deepEqual(result.data.invoices.map((row: Row) => row.id), expected);
            assert.ok(f.reads.at(-1).order.slice(0, 3).every(([, direction]: [string, string]) => direction.endsWith('NULLS LAST')));
        }
    });
    it('preserves full-result aggregates and existing search, month, payment and due filters for every ordering', async t => {
        const rows = Array.from({length: 35}, (_, index) => invoice(`n${index + 1}`, index + 1, 2025, '2025-10-10'));
        rows.push(invoice('next-year', 1, 2026, '2026-01-01'));
        const f = fixture(t, rows, [{invoiceId: 'n20', amount: 30, source: 'USER', status: 'POSTED', paidAt: '2025-10-20'}]);
        const baseline = await f.run({size: '1'});
        assert.deepEqual(baseline.data.aggregates, {billedTotal: 2160, paidAmount: 30, balance: 2130, collectedInPeriod: 30, undatedPaidAmount: 0});
        for (const sort of ['date', 'document']) for (const direction of ['asc', 'desc']) {
            const full = await f.run({sort, direction, size: '1', page: '2'});
            assert.deepEqual(full.data.aggregates, baseline.data.aggregates); assert.equal(full.data.pagination.length, 36);
            const filtered = await f.run({sort, direction, size: '1', query: 'Mario Rossi', month: '2025-10', paymentState: 'partial', dueState: 'overdue'});
            assert.equal(filtered.code, 200, filtered.message); assert.equal(filtered.data.pagination.length, 1); assert.equal(filtered.data.invoices[0].id, 'n20');
            assert.deepEqual(filtered.data.aggregates, {billedTotal: 60, paidAmount: 30, balance: 30, collectedInPeriod: 30, undatedPaidAmount: 0});
        }
    });
    it('returns 400 for invalid, repeated and structured sort parameters before reading invoice data', async t => {
        const f = fixture(t, [invoice('a', 1, 2026, '2026-10-20')]);
        for (const query of [{sort: ''}, {sort: 'createdAt'}, {sort: ['date', 'document']}, {sort: {column: 'date'}},
            {sort: 'document', direction: ''}, {direction: 'DESC'}, {direction: ['asc', 'desc']}, {direction: {order: 'desc'}}]) {
            const result = await f.run(query); assert.equal(result.code, 400, JSON.stringify(query));
        }
        assert.equal(f.reads.length, 0);
    });
});
