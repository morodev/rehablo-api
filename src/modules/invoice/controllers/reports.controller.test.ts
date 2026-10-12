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
