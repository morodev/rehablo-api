import assert from 'node:assert/strict';
import { it, TestContext } from 'node:test';
import { Request, Response, NextFunction } from 'express';
import { sequelize } from '../../../config/database.js';
import { PatientCredit, TreasuryMovement } from '../models/administration.model.js';
import { PatientCreditMovement } from '../models/patientCreditMovement.model.js';
import { applyCredit, refundCredit, reverseCreditApplication } from './patientCredit.controller.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';

const creditId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const patientId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const structureId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003';

function legacyCredit() {
    const values: Record<string, unknown> = { id: creditId, patientId, structureId,
        amount: 80, remainingAmount: 80, status: 'ACTIVE', sourceType: 'ADVANCE', sourceId: null };
    return { get: (key: string) => values[key] };
}

async function run(handler: (req: Request, res: Response, next: NextFunction) => void, body: Record<string, unknown>) {
    const req: any = { tenantSchema: 'rehablo_test', params: { id: creditId }, body,
        access: { scope: 'tenant', userId: patientId },
        header: () => 'patient-credit-test-001' };
    return new Promise<number>(resolve => {
        const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; },
            json() { resolve(this.statusCode); return this; } };
        handler(req, res, (error?: any) => resolve(error?.statusCode ?? 500));
    });
}

function fixture(t: TestContext) {
    t.mock.method(sequelize, 'transaction', (async (callback: any) => callback({ LOCK: { UPDATE: 'UPDATE' } })) as any);
    t.mock.method(PatientCredit, 'schema', (() => ({ findByPk: async () => legacyCredit() })) as any);
    t.mock.method(PatientCreditMovement, 'schema', (() => ({ findOne: async () => null })) as any);
    t.mock.method(sequelize, 'query', (async (sql: string) => {
        assert.match(sql, /pg_advisory_xact_lock/);
        return [[], {}];
    }) as any);
}

it('refuses to apply an unbacked legacy credit to an invoice', async t => {
    fixture(t);
    const status = await run(applyCredit, { amount: 20, targetType: 'INVOICE', targetId: patientId });
    assert.equal(status, 409);
});

it('refuses to refund an unbacked legacy credit', async t => {
    fixture(t);
    const status = await run(refundCredit, { amount: 20, accountId: patientId, paymentMethodId: structureId });
    assert.equal(status, 409);
});

const invoiceId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004';
const replacementInvoiceId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000005';
const eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000006';
const receiptId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000007';
function row(values: Record<string, any>): any {
    return {...values, get(key: string | object) {
        if (typeof key === 'string') return this[key];
        const {get, update, ...plain} = this; return plain;
    }, async update(values: Record<string, any>) {Object.assign(this, values); return this;}};
}
function backedFixture(t: TestContext) {
    const credit = row({id: creditId, patientId, structureId, amount: 100, remainingAmount: 100,
        status: 'ACTIVE', sourceType: 'TREASURY_ADVANCE', sourceId: receiptId});
    const receipt = row({id: receiptId, structureId, amount: 100, direction: 'IN', status: 'POSTED',
        sourceType: 'PATIENT_ADVANCE', sourceId: creditId});
    const invoices = [row({id: invoiceId, patientID: patientId, structureId, invoiceTotal: 100, invoiceNet: 80,
        documentNumber: 1, emissionDate: '2025-01-01', documentType: 'fattura', status: 'unpaid'})];
    const events: any[] = [];
    const payments: any[] = [];
    const movements: any[] = [];
    const matches = (value: any, where: Record<string, any>) => Object.entries(where).every(([key, expected]) => value[key] === expected);
    t.mock.method(sequelize, 'transaction', (async (work: any) => work({LOCK: {UPDATE: 'UPDATE'}})) as any);
    t.mock.method(sequelize, 'query', (async (sql: string) => {assert.match(sql, /pg_advisory_xact_lock/); return [[], {}];}) as any);
    t.mock.method(PatientCredit, 'schema', (() => ({findByPk: async () => credit})) as any);
    t.mock.method(TreasuryMovement, 'schema', (() => ({findByPk: async () => receipt, count: async () => 0})) as any);
    t.mock.method(PatientCreditMovement, 'schema', (() => ({
        findOne: async ({where}: any) => movements.find(value => matches(value, where)),
        create: async (values: any) => {const created = row({id: 'movement-' + (movements.length + 1), ...values}); movements.push(created); return created;}
    })) as any);
    t.mock.method(Invoice, 'schema', (() => ({findAll: async () => invoices,
        findOne: async ({where}: any) => invoices.find(value => matches(value, where)),
        findByPk: async (id: string) => invoices.find(value => value.id === id)})) as any);
    t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async () => events,
        findOne: async ({where}: any) => events.find(value => matches(value, where)),
        findByPk: async (id: string) => events.find(value => value.id === id)})) as any);
    t.mock.method(InvoiceAgendaEvent, 'schema', (() => ({findAll: async () => []})) as any);
    t.mock.method(InvoicePayment, 'schema', (() => ({
        findAll: async ({where}: any) => where.invoiceId ? payments.filter(value => value.invoiceId === where.invoiceId)
            : where.agendaEventId ? payments.filter(value => value.agendaEventId === where.agendaEventId) : payments,
        findByPk: async (id: string) => payments.find(value => value.id === id),
        sum: async (_field: string, {where}: any) => payments.filter(value => matches(value, where)).reduce((sum, value) => sum + value.amount, 0),
        create: async (values: any) => {const created = row({id: 'payment-' + (payments.length + 1), ...values}); payments.push(created); return created;}
    })) as any);
    return {credit, invoices, events, payments, movements};
}

it('limits invoice credit to the net residual and allows a partial invoice without creating cash', async t => {
    const f = backedFixture(t);
    f.payments.push(row({id: 'prior', invoiceId, amount: 20, status: 'POSTED', source: 'USER'}));
    assert.equal(await run(applyCredit, {amount: 70, targetType: 'INVOICE', targetId: invoiceId}), 409);
    assert.equal(f.payments.length, 1);
    assert.equal(await run(applyCredit, {amount: 60, targetType: 'INVOICE', targetId: invoiceId}), 201);
    assert.equal(f.invoices[0].status, 'paid');
    assert.equal(f.credit.remainingAmount, 40);
    assert.equal(f.payments[1].source, 'CREDIT');
});

it('blocks credit on a later autonomous invoice until the older same-site obligation is settled', async t => {
    const f = backedFixture(t);
    f.invoices[0].emissionDate = '2025-01-10';
    f.invoices.push(row({id: replacementInvoiceId, patientID: patientId, structureId,
        invoiceTotal: 40, documentNumber: 2, emissionDate: '2025-01-01', documentType: 'fattura', status: 'unpaid'}));
    assert.equal(await run(applyCredit, {amount: 60, targetType: 'INVOICE', targetId: invoiceId}), 409);
    assert.equal(f.credit.remainingAmount, 100);
    assert.equal(f.payments.length, 0);
});

it('does not allow pure credit to create a partial single appointment', async t => {
    const f = backedFixture(t);
    f.invoices.length = 0;
    f.events.push(row({id: eventId, patientId, structureId, start: '2025-01-01T10:00:00Z',
        end: '2025-01-01T11:00:00Z', status: 'COMPLETED', appointmentExpectedAmount: 60, appointmentPaymentHistoryKnown: true}));
    assert.equal(await run(applyCredit, {amount: 20, targetType: 'APPOINTMENT', targetId: eventId}), 409);
    assert.equal(f.payments.length, 0);
    assert.equal(f.credit.remainingAmount, 100);
});

it('reverses the original event-owned credit after fiscal release and reissue on its live invoice', async t => {
    const f = backedFixture(t);
    f.invoices[0].id = replacementInvoiceId;
    f.invoices[0].invoiceNet = 60;
    f.invoices[0].status = 'paid';
    f.events.push(row({id: eventId, patientId, structureId, invoiceId: replacementInvoiceId,
        status: 'COMPLETED', appointmentExpectedAmount: 60, appointmentPaidAmount: 60}));
    f.payments.push(row({id: 'original-payment', agendaEventId: eventId, invoiceId: replacementInvoiceId,
        amount: 60, source: 'CREDIT', status: 'POSTED'}));
    f.movements.push(row({id: 'original-application', creditId, type: 'APPLY_APPOINTMENT', targetId: eventId,
        amount: 60, invoicePaymentId: 'original-payment', idempotencyKey: 'initial-credit-key'}));
    f.credit.remainingAmount = 40;
    const req: any = {tenantSchema: 'rehablo_test', params: {id: creditId, movementId: 'original-application'},
        access: {scope: 'tenant', userId: patientId}, header: () => 'reverse-credit-key'};
    const status = await new Promise<number>(resolve => {
        const res: any = {statusCode: 200, status(code: number) {this.statusCode = code; return this;}, json() {resolve(this.statusCode); return this;}};
        reverseCreditApplication(req, res, (error?: any) => resolve(error?.statusCode ?? 500));
    });
    assert.equal(status, 201);
    assert.equal(f.payments.length, 1);
    assert.equal(f.payments[0].id, 'original-payment');
    assert.equal(f.payments[0].status, 'VOID');
    assert.equal(f.invoices[0].status, 'unpaid');
    assert.equal(f.events[0].appointmentPaidAmount, 0);
    assert.equal(f.credit.remainingAmount, 100);
});
