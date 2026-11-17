import assert from 'node:assert/strict';
import {it, type TestContext} from 'node:test';
import {sequelize} from '../../../config/database.js';
import Tenant from '../../auth/models/tenant.model.js';
import Patient from '../../patients/models/patient.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import EventType from '../../agenda/models/eventType.model.js';
import Product from '../../products-services/models/product.model.js';
import Service from '../../products-services/models/service.model.js';
import ServiceStructure from '../../products-services/models/serviceStructure.model.js';
import Invoice from '../models/invoice.model.js';
import InvoiceService from '../models/invoiceService.model.js';
import InvoiceProduct from '../models/invoiceProduct.model.js';
import InvoicePayment from '../models/invoicePayment.model.js';
import InvoiceAgendaEvent from '../models/invoiceAgendaEvent.model.js';
import {saveInvoice} from './invoice.controller.js';
import {buildSdiPayloadFromInvoice} from '../../administration/services/fiscalPayload.js';

const patientId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const eventId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const serviceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const invoiceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const record = (data: Record<string, any>): any => ({...data,
    get(key: any) { return typeof key === 'string' ? this[key]
        : Object.fromEntries(Object.entries(this).filter(([, value]) => typeof value !== 'function')); },
    async update(values: Record<string, any>) { Object.assign(this, values); return this; }
});
const run = (req: any) => new Promise<any>(resolve => {
    const res: any = {code: 200, status(code: number) { this.code = code; return this; },
        json(value: any) { resolve({code: this.code, ...value}); }};
    saveInvoice(req, res, (error: any) => resolve({code: error.statusCode ?? 500, message: error.message}));
});
const fiscalExport = (invoice: any) => {
    const document = invoice.get({plain: true});
    // The patient model currently stores a single address string. Supply the separate recipient
    // locality fields required by SDI to isolate compatibility of the new frozen invoice line.
    return buildSdiPayloadFromInvoice({...document,
        recipient: {...document.recipient, city: 'Roma', zipCode: '00100', province: 'RM'}});
};
function fixture(t: TestContext) {
    const tx = {LOCK: {UPDATE: 'UPDATE'}};
    const state: any = {invoice: null, rows: [], links: [], payments: [], transactionCount: 0};
    const event = record({id: eventId, title: 'Mario Rossi', patientId, patient: {id: patientId},
        start: '2026-01-03T09:00:00Z', status: 'CONFIRMED', eventTypeId: null,
        appointmentExpectedAmount: '80.00', appointmentNetAmount: '80.00', appointmentVatRate: '0.00',
        appointmentPaymentHistoryKnown: true, appointmentPriceAdjustment: null, invoiceId: null});
    const tenant = record({businessName: 'Studio test', VATNumber: '01234567890', taxRegime: 'RF01',
        address: 'Via Test 1', city: 'Roma', zipCode: '00100', province: 'RM',
        socialSecurityFund: 'NONE', socialSecurityPricingMode: 'NONE',
        lastDocumentNumberByYear: {}, stampChargedToPatient: false,
        administrationSettings: {fiscal: {stsIssuerType: 'PHYSIOTHERAPIST'}}});
    const patient = record({id: patientId, name: 'Mario', surname: 'Rossi', fiscalCode: 'RSSMRA80A01H501U',
        structureId: null, stsOppositionToDataSending: false,
        address: 'Via Test 2'});
    t.mock.method(sequelize, 'authenticate', (async () => { throw new Error('Database connections are forbidden'); }) as any);
    t.mock.method(sequelize, 'transaction', (async (work: any) => { state.transactionCount++; return work(tx); }) as any);
    t.mock.method(sequelize, 'query', (async (sql: string, options: any) => {
        assert.match(sql, /pg_advisory_xact_lock/); assert.equal(options.transaction, tx); return [[], {}];
    }) as any);
    t.mock.method(Tenant, 'findByPk', (async () => tenant) as any);
    t.mock.method(Patient, 'schema', (() => ({findOne: async () => patient})) as any);
    t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async () => [event]})) as any);
    t.mock.method(EventType, 'schema', (() => ({findAll: async () => []})) as any);
    t.mock.method(Product, 'schema', (() => ({findAll: async () => []})) as any);
    t.mock.method(Service, 'schema', (() => ({findAll: async () => [record({id: serviceId, sellingPrice: '99.00', name: 'Catalogo', productVat: '22'})]})) as any);
    t.mock.method(ServiceStructure, 'schema', (() => ({findAll: async () => []})) as any);
    t.mock.method(Invoice, 'schema', (() => ({findOne: async () => null,
        findByPk: async () => state.invoice,
        create: async (values: any, options: any) => {
            assert.equal(options.transaction, tx);
            state.invoice = record({id: invoiceId, ...values, services: state.rows, products: [], appointmentLinks: state.links});
            return state.invoice;
        }})) as any);
    t.mock.method(InvoiceService, 'schema', (() => ({create: async (values: any, options: any) => {
        assert.equal(options.transaction, tx); const row = record({id: 'line-id', ...values}); state.rows.push(row); return row;
    }})) as any);
    t.mock.method(InvoiceProduct, 'schema', (() => ({create: async () => { throw new Error('No products expected'); }})) as any);
    t.mock.method(InvoiceAgendaEvent, 'schema', (() => ({findAll: async () => [],
        create: async (values: any, options: any) => { assert.equal(options.transaction, tx); state.links.push(values); return record(values); }})) as any);
    t.mock.method(InvoicePayment, 'schema', (() => ({findAll: async () => state.payments,
        create: async () => { throw new Error('Invoicing must not duplicate receipts'); },
        update: async (values: any, options: any) => {
            assert.equal(options.transaction, tx); state.payments.forEach((payment: any) => Object.assign(payment, values)); return [state.payments.length];
        }})) as any);
    const req: any = {tenantSchema: 'rehablo_test', params: {}, query: {},
        body: {patientID: patientId, agendaEventId: eventId, documentType: 'fattura', emissionDate: '2026-01-04',
            status: 'unpaid', manualService: {description: '  Trattamento manuale  ', amount: 60}},
        user: {tenants: [{id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}]},
        access: {scope: 'tenant', resource: 'invoice', structureId: null}};
    return {state, event, tenant, req};
}

it('creates the chosen amount as a frozen service without catalogue entry and links the original appointment', async t => {
    const f = fixture(t);
    const result = await run(f.req);
    assert.equal(result.code, 201, result.message);
    assert.equal(f.state.invoice.invoiceTotal, 60);
    assert.equal(f.state.invoice.agendaEventId, eventId);
    assert.equal(f.state.rows.length, 1);
    assert.equal(f.state.rows[0].ServiceId, null);
    assert.equal(f.state.rows[0].serviceName, 'Trattamento manuale');
    assert.equal(f.state.rows[0].servicePrice, 60);
    assert.equal(f.state.rows[0].serviceVat, 'N4');
    assert.deepEqual(f.state.links, [{invoiceId, agendaEventId: eventId, serviceId: null}]);
    assert.equal(f.event.invoiceId, invoiceId);
    assert.equal(f.event.appointmentExpectedAmount, '80.00', 'invoice override does not rewrite appointment agreement');
    const exported = fiscalExport(f.state.invoice);
    assert.deepEqual(exported.errors, []);
    assert.match(exported.xml!, /<Descrizione>Trattamento manuale<\/Descrizione>/);
    assert.match(exported.xml!, /<ImportoTotaleDocumento>60\.00<\/ImportoTotaleDocumento>/);
});

it('keeps historical VAT and contribution included in the entered service amount', async t => {
    const f = fixture(t);
    Object.assign(f.event, {appointmentVatRate: '22.00', appointmentExpectedAmount: '200.00',
        appointmentSocialSecurity: {version: 1, fund: 'INPS_GS', rate: 4, mode: 'EXCLUDED'}});
    Object.assign(f.tenant, {socialSecurityFund: 'INPS_GS', socialSecurityRate: 4, socialSecurityPricingMode: 'EXCLUDED'});
    f.req.body.manualService.amount = 126.88;
    const result = await run(f.req);
    assert.equal(result.code, 201, result.message);
    assert.equal(f.state.invoice.invoiceTotal, 126.88);
    assert.equal(f.state.rows[0].servicePrice, 104);
    assert.equal(f.state.rows[0].serviceVat, '22');
    assert.equal(f.state.rows[0].socialSecurity.mode, 'INCLUDED');
    assert.equal(f.state.invoice.socialSecuritySnapshot.lines[0].contribution, 4);
    const exported = fiscalExport(f.state.invoice);
    assert.deepEqual(exported.errors, []);
    assert.match(exported.xml!, /<ImportoTotaleDocumento>126\.88<\/ImportoTotaleDocumento>/);
});

it('applies the current exempt regime to a historical taxable appointment without changing the entered amount', async t => {
    const f = fixture(t);
    f.tenant.taxRegime = 'RF19'; f.event.appointmentVatRate = '22.00';
    const result = await run(f.req);
    assert.equal(result.code, 201, result.message);
    assert.equal(f.state.invoice.invoiceTotal, 60);
    assert.equal(f.state.rows[0].servicePrice, 60);
    assert.equal(f.state.rows[0].serviceVat, 'N2.2');
});

it('accepts a service with no earlier price and includes configured contribution in its entered amount', async t => {
    const f = fixture(t);
    Object.assign(f.event, {appointmentExpectedAmount: null, appointmentNetAmount: null, appointmentVatRate: null});
    Object.assign(f.tenant, {socialSecurityFund: 'INPS_GS', socialSecurityRate: 4, socialSecurityPricingMode: 'EXCLUDED'});
    f.req.body.manualService.amount = 104;
    const result = await run(f.req);
    assert.equal(result.code, 201, result.message);
    assert.equal(f.state.invoice.invoiceTotal, 104);
    assert.equal(f.state.invoice.socialSecuritySnapshot.lines[0].contribution, 4);
    assert.equal(f.state.rows[0].ServiceId, null);
});

it('keeps the existing studio stamp charge separate from the entered service amount', async t => {
    const f = fixture(t);
    f.tenant.stampChargedToPatient = true; f.req.body.manualService.amount = 100;
    const result = await run(f.req);
    assert.equal(result.code, 201, result.message);
    assert.equal(f.state.rows[0].servicePrice, 100);
    assert.equal(f.state.invoice.invoiceTotal, 102);
});

it('rejects a manual amount whose stamp charge exceeds the stored total limit before allocating a number', async t => {
    const f = fixture(t);
    f.tenant.stampChargedToPatient = true;
    f.req.body.manualService.amount = 99999999.99;
    const result = await run(f.req);
    assert.equal(result.code, 400, result.message);
    assert.match(result.message, /totale della fattura, incluso l’eventuale bollo/);
    assert.equal(f.state.invoice, null);
    assert.equal(f.state.rows.length, 0);
    assert.equal(f.state.links.length, 0);
    assert.deepEqual(f.tenant.lastDocumentNumberByYear, {});
});

it('rejects an amount that cannot be represented at the historical VAT rate without silently rounding the agreed total', async t => {
    const f = fixture(t);
    f.event.appointmentVatRate = '22.00'; f.req.body.manualService.amount = 0.03;
    const result = await run(f.req);
    assert.equal(result.code, 400, result.message);
    assert.match(result.message, /non coincide/);
    assert.equal(f.state.invoice, null);
});

it('uses the explicit amount when a discounted appointment has a different original amount', async t => {
    const f = fixture(t);
    f.event.appointmentPriceAdjustment = 'DISCOUNT'; f.event.appointmentOriginalAmount = '100.00';
    const result = await run(f.req);
    assert.equal(result.code, 201, result.message);
    assert.equal(f.state.rows[0].servicePrice, 60);
    assert.equal(f.state.rows[0].originalServicePrice, null);
});

it('preserves posted receipts and does not create a second payment when issuing a manual line', async t => {
    const f = fixture(t);
    const payment = record({id: 'existing-payment', agendaEventId: eventId, invoiceId: null,
        amount: '20.00', status: 'POSTED', paidAt: '2026-01-03', source: 'USER'});
    f.state.payments.push(payment);
    const result = await run(f.req);
    assert.equal(result.code, 201, result.message);
    assert.equal(f.state.payments.length, 1);
    assert.equal(payment.invoiceId, invoiceId);
    assert.equal(result.data.paidAmount, 20);
    assert.equal(result.data.balance, 40);
});

it('rejects manual amounts below posted receipts before allocating an invoice number', async t => {
    const f = fixture(t);
    f.state.payments.push(record({id: 'existing-payment', invoiceId: null, amount: '70.00', status: 'POSTED'}));
    const result = await run(f.req);
    assert.equal(result.code, 409, result.message);
    assert.match(result.message, /superano il totale/);
    assert.equal(f.state.invoice, null); assert.equal(f.state.links.length, 0);
    assert.deepEqual(f.tenant.lastDocumentNumberByYear, {});
});

for (const [name, change, code] of [
    ['blank description', (f: any) => f.req.body.manualService.description = ' ', 400],
    ['long description', (f: any) => f.req.body.manualService.description = 'a'.repeat(256), 400],
    ['zero amount', (f: any) => f.req.body.manualService.amount = 0, 400],
    ['fractional cents', (f: any) => f.req.body.manualService.amount = 12.345, 400],
    ['string amount', (f: any) => f.req.body.manualService.amount = '60.00', 400],
    ['mixed catalogue', (f: any) => f.req.body.services = [{id: serviceId, quantity: 1}], 400],
    ['explicit appointments', (f: any) => f.req.body.appointments = [], 400],
    ['missing appointment', (f: any) => delete f.req.body.agendaEventId, 400],
    ['future appointment', (f: any) => f.event.start = '2099-01-03T09:00:00Z', 409],
    ['complimentary appointment', (f: any) => f.event.appointmentPriceAdjustment = 'COMPLIMENTARY', 409],
    ['already invoiced', (f: any) => f.event.invoiceId = 'existing-invoice', 409],
    ['package appointment', (f: any) => Object.assign(f.event, {carePackageId: 'package', packageReservationStatus: 'RESERVED'}), 409],
    ['recurring appointment', (f: any) => f.event.recurrence = 'FREQ=WEEKLY', 422],
    ['waived no-show', (f: any) => Object.assign(f.event, {status: 'NO_SHOW', noShowBillingDecision: 'WAIVED'}), 409],
    ['different patient', (f: any) => f.event.patientId = serviceId, 422],
    ['cancelled appointment', (f: any) => f.event.status = 'CANCELLED', 422]
] as const) {
    it(`rejects ${name} without creating a document`, async t => {
        const f = fixture(t); change(f);
        const result = await run(f.req);
        assert.equal(result.code, code, result.message);
        assert.equal(f.state.invoice, null); assert.equal(f.state.rows.length, 0);
    });
}

it('an invoiced billable no-show remains a no-show and never becomes a completed treatment', async t => {
    const f = fixture(t);
    Object.assign(f.event, {status: 'NO_SHOW', noShowBillingDecision: 'BILLABLE'});
    const result = await run(f.req);
    assert.equal(result.code, 201, result.message);
    assert.equal(f.event.status, 'NO_SHOW');
    assert.equal(f.state.invoice.agendaEventId, eventId);
});

it('catalogue invoicing keeps its existing appointment price override', async t => {
    const f = fixture(t);
    delete f.req.body.manualService;
    f.req.body.services = [{id: serviceId, quantity: 1}];
    const result = await run(f.req);
    assert.equal(result.code, 201, result.message);
    assert.equal(f.state.invoice.invoiceTotal, 80);
    assert.equal(f.state.rows[0].ServiceId, serviceId);
    assert.equal(f.state.rows[0].servicePrice, 80);
    assert.equal(f.state.rows[0].serviceName, 'Catalogo');
});
