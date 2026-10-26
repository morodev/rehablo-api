import assert from 'node:assert/strict';
import {it, TestContext} from 'node:test';
import {Op} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import AgendaEvent from '../models/agendaEvent.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import {CarePackage, PaymentMethod} from '../../administration/models/index.js';
import {createAppointmentPayment, createBulkAppointmentPayments, updateAppointmentPaymentCompatibility, voidAppointmentPayment} from './appointmentPayment.controller.js';
import {mockFinancialOperations} from '../../administration/services/financialOperation.fixture.js';

const id = (value: number) => 'bbbbbbbb-bbbb-4bbb-8bbb-' + String(value).padStart(12, '0');
const patientId = id(1), structureId = id(2), currentId = id(3), oldId = id(4), invoiceId = id(5);
function row(values: Record<string, any>): any {
    return {...values, get(key: string | object) {if (typeof key === 'string') return this[key];
        const {get, update, ...plain} = this; return plain;},
        async update(values: any) {Object.assign(this, values); return this;}};
}
function fixture(t: TestContext) {
    mockFinancialOperations(t);
    t.mock.method(CarePackage, 'schema', (() => ({findAll: async () => []})) as any);
    const current = row({id: currentId, patientId, structureId, start: '2025-02-01T10:00:00Z',
        end: '2025-02-01T11:00:00Z', status: 'COMPLETED', title: 'Seduta corrente',
        appointmentExpectedAmount: 60, appointmentPaymentHistoryKnown: true});
    const events = [current];
    const invoices: any[] = [];
    const payments: any[] = [];
    const writeOptions: any[] = [];
    const trace: string[] = [];
    t.mock.method(sequelize, 'transaction', (async (work: any) => work({LOCK: {UPDATE: 'UPDATE'}})) as any);
    t.mock.method(sequelize, 'query', (async (sql: string) => {assert.match(sql, /pg_advisory_xact_lock/); trace.push('patient-lock'); return [[], {}];}) as any);
    t.mock.method(AgendaEvent, 'schema', (() => ({
        findOne: async ({where, lock}: any) => {if (lock) trace.push('event-lock'); return events.find(event => event.id === where.id) ?? null;},
        findAll: async ({where}: any) => where.id?.[Op.in] ? events.filter(event => where.id[Op.in].includes(event.id)) : events
    })) as any);
    t.mock.method(Invoice, 'schema', (() => ({findAll: async () => invoices})) as any);
    t.mock.method(InvoiceAgendaEvent, 'schema', (() => ({findAll: async () => [], findOne: async () => null})) as any);
    t.mock.method(InvoicePayment, 'schema', (() => ({
        findAll: async ({where}: any) => typeof where.agendaEventId === 'string' ? payments.filter(payment => payment.agendaEventId === where.agendaEventId) : payments,
        findOne: async ({where}: any) => payments.find(payment => payment.id === where.id && payment.agendaEventId === where.agendaEventId) ?? null,
        create: async (values: any, options: any) => {writeOptions.push(options); const payment = row({id: id(100 + payments.length), ...values}); payments.push(payment); return payment;}
    })) as any);
    const req: any = {tenantSchema: 'rehablo_test', params: {agendaEventId: currentId},
        access: {scope: 'tenant', structureId, userId: id(6)}, user: {sub:id(6)}, header: () => 'appointment-receipt-test',
        body: {amount: 60, paidAt: '2025-02-01'}};
    return {req, current, events, invoices, payments, trace, writeOptions};
}
function run(handler: any, req: any): Promise<{status: number; body: any}> {
    return new Promise(resolve => {
        const res: any = {statusCode: 200, status(code: number) {this.statusCode = code; return this;},
            json(body: any) {resolve({status: this.statusCode, body}); return this;}};
        handler(req, res, (error?: any) => resolve({status: error?.statusCode ?? 500, body: {message: error?.message}}));
    });
}

it('direct and compatibility appointment receipts cannot bypass an earlier autonomous invoice', async t => {
    const f = fixture(t);
    f.invoices.push(row({id: invoiceId, patientID: patientId, structureId, documentNumber: 1,
        emissionDate: '2025-01-01', invoiceTotal: 80, documentType: 'fattura', status: 'unpaid'}));
    assert.equal((await run(createAppointmentPayment, f.req)).status, 409);
    f.req.body.status = 'paid';
    assert.equal((await run(updateAppointmentPaymentCompatibility, f.req)).status, 409);
    assert.equal(f.payments.length, 0);
    assert.ok(f.trace.indexOf('patient-lock') < f.trace.indexOf('event-lock'));
});

it('direct and compatibility callers cannot create a new partial single-appointment receipt', async t => {
    const f = fixture(t);
    f.req.body.amount = 20;
    assert.equal((await run(createAppointmentPayment, f.req)).status, 409);
    f.req.body.status = 'partial';
    assert.equal((await run(updateAppointmentPaymentCompatibility, f.req)).status, 409);
    assert.equal(f.payments.length, 0);
});

it('bulk appointments observe invoice priority and retain a partial last appointment after settling the prior one', async t => {
    const f = fixture(t);
    f.events.push(row({id: oldId, patientId, structureId, start: '2025-01-02T10:00:00Z',
        end: '2025-01-02T11:00:00Z', status: 'COMPLETED', title: 'Precedente',
        appointmentExpectedAmount: 40, appointmentPaymentHistoryKnown: true}));
    f.invoices.push(row({id: invoiceId, patientID: patientId, structureId, documentNumber: 1,
        emissionDate: '2025-01-01', invoiceTotal: 80, documentType: 'fattura', status: 'unpaid'}));
    f.req.body.allocations = [{agendaEventId: currentId, amount: 20}, {agendaEventId: oldId, amount: 40}];
    assert.equal((await run(createBulkAppointmentPayments, f.req)).status, 409);
    assert.equal(f.payments.length, 0);
    f.invoices[0].status = 'paid';
    const response = await run(createBulkAppointmentPayments, f.req);
    assert.equal(response.status, 201);
    assert.equal(f.payments.length, 2);
    assert.equal(f.payments[0].agendaEventId, oldId);
    assert.equal(f.current.appointmentPaymentStatus, 'partial');
    assert.equal(f.current.appointmentPaidAmount, 20);
});

it('generic appointment void cannot cancel credit coverage or silently fail to restore its credit balance', async t => {
    const f = fixture(t);
    const payment = row({id: id(100), agendaEventId: currentId, invoiceId: null,
        amount: 60, source: 'CREDIT', status: 'POSTED'});
    f.payments.push(payment);
    f.req.params.paymentId = payment.id;
    f.req.body.reason = 'Correzione';
    assert.equal((await run(voidAppointmentPayment, f.req)).status, 409);
    assert.equal(payment.status, 'POSTED');
    assert.equal(f.payments.length, 1);
});

for (const [name, handler] of [['direct', createAppointmentPayment], ['compatibility', updateAppointmentPaymentCompatibility]] as const) {
    it(`${name} appointment receipts preserve the selected account and method and replay without a second payment`, async t => {
        const f = fixture(t);
        t.mock.method(PaymentMethod, 'schema', (() => ({findOne: async () => row({label:'Carta'})})) as any);
        f.req.body = {amount:60,status:'paid',paidAt:'2025-02-01',accountId:id(7),paymentMethodId:id(8)};
        assert.ok([200,201].includes((await run(handler,f.req)).status));
        assert.ok([200,201].includes((await run(handler,f.req)).status));
        assert.equal(f.payments.length,1); assert.equal(f.payments[0].method,'Carta');
        assert.equal(f.writeOptions[0].treasuryContext.accountId,id(7));
        assert.equal(f.writeOptions[0].treasuryContext.paymentMethodId,id(8));
        assert.equal(f.writeOptions[0].treasuryContext.structureId,structureId); assert.ok(f.writeOptions[0].transaction);
        f.req.body.note='changed';
        assert.equal((await run(handler,f.req)).status,409); assert.equal(f.payments.length,1);
    });
}
it('bulk receipts use the same chosen account with distinct ledger keys and replay one atomic allocation', async t => {
    const f=fixture(t);
    f.events.push(row({...f.current,id:oldId,start:'2025-01-01T10:00:00Z',appointmentExpectedAmount:40}));
    f.req.body={paidAt:'2025-02-01',accountId:id(7),allocations:[{agendaEventId:oldId,amount:40},{agendaEventId:currentId,amount:30}]};
    assert.equal((await run(createBulkAppointmentPayments,f.req)).status,201);
    assert.equal((await run(createBulkAppointmentPayments,f.req)).status,201);
    assert.equal(f.payments.length,2);
    assert.ok(f.writeOptions.every(option=>option.treasuryContext.accountId===id(7)&&option.transaction));
    assert.equal(new Set(f.writeOptions.map(option=>option.treasuryContext.idempotencyKey)).size,2);
});
