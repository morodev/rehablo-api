import assert from 'node:assert/strict';
import {it} from 'node:test';
import {Op} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import Invoice from '../models/invoice.model.js';
import InvoicePayment from '../models/invoicePayment.model.js';
import InvoiceAgendaEvent from '../models/invoiceAgendaEvent.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import {updateInvoice} from './invoice.controller.js';

const id = (value: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(value).padStart(12, '0');
function record(values: Record<string, any>): any {
    return {...values, get(key: string | object) {if (typeof key === 'string') return this[key];
        const {get, update, ...plain} = this; return plain;},
        async update(values: any) {Object.assign(this, values); return this;}};
}

for (const paymentSource of ['CREDIT', 'OPENING_BALANCE']) {
it(`fiscal cancellation releases event-owned ${paymentSource} without creating or voiding a receipt`, async t => {
    const invoiceId = id(1), patientId = id(2), structureId = id(3), eventId = id(4);
    const invoice = record({id: invoiceId, patientID: patientId, structureId, documentType: 'fattura',
        documentNumber: 10, documentYear: 2025, emissionDate: '2025-01-01', invoiceTotal: 60,
        invoiceNet: 60, status: 'paid', agendaEventId: eventId});
    const event = record({id: eventId, patientId, structureId, invoiceId, appointmentPaidAmount: 60});
    const payment = record({id: id(5), invoiceId, agendaEventId: eventId, source: paymentSource, status: 'POSTED', amount: 60});
    const links = [record({id: id(6), invoiceId, agendaEventId: eventId, releasedAt: null})];
    const trace: string[] = [];
    t.mock.method(sequelize, 'query', (async (sql: string) => {assert.match(sql, /pg_advisory_xact_lock/); trace.push('patient-lock'); return [[], {}];}) as any);
    t.mock.method(sequelize, 'transaction', (async (work: any) => work({LOCK: {UPDATE: 'UPDATE'}})) as any);
    t.mock.method(Invoice, 'schema', (() => ({
        findOne: async (options: any) => {if (options.lock) trace.push('invoice-lock'); return invoice;},
        findByPk: async () => invoice
    })) as any);
    t.mock.method(InvoicePayment, 'schema', (() => ({
        sum: async () => payment.invoiceId === invoiceId ? payment.amount : 0,
        findAll: async () => payment.invoiceId === invoiceId ? [payment] : [],
        update: async (values: any, {where}: any) => {
            assert.ok(where.source[Op.in].includes('CREDIT'));
            if (where.source[Op.in].includes(payment.source)) Object.assign(payment, values);
            trace.push('payment-release');
        },
        create: async () => {throw new Error('Fiscal cancellation must not create a receipt');}
    })) as any);
    t.mock.method(InvoiceAgendaEvent, 'schema', (() => ({
        findAll: async () => links,
        update: async (values: any) => links.forEach(link => Object.assign(link, values))
    })) as any);
    t.mock.method(AgendaEvent, 'schema', (() => ({
        findAll: async () => {trace.push('event-lock'); return [event];},
        update: async (values: any) => Object.assign(event, values)
    })) as any);
    const response = await new Promise<{status: number; body: any}>(resolve => {
        const req: any = {tenantSchema: 'rehablo_test', params: {invoiceId}, body: {status: 'void'}, access: {scope: 'tenant'}};
        const res: any = {statusCode: 200, status(code: number) {this.statusCode = code; return this;},
            json(body: any) {resolve({status: this.statusCode, body}); return this;}};
        updateInvoice(req, res, (error?: any) => resolve({status: error?.statusCode ?? 500, body: {message: error?.message}}));
    });
    assert.equal(response.status, 200);
    assert.equal(invoice.status, 'void');
    assert.equal(event.invoiceId, null);
    assert.equal(event.appointmentPaidAmount, 60);
    assert.equal(payment.id, id(5));
    assert.equal(payment.invoiceId, null);
    assert.equal(payment.status, 'POSTED');
    assert.ok(links[0].releasedAt);
    assert.ok(trace.indexOf('patient-lock') < trace.indexOf('invoice-lock'));
    assert.ok(trace.indexOf('invoice-lock') < trace.indexOf('event-lock'));
});

}
