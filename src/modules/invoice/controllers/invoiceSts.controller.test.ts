import assert from 'node:assert/strict';
import { it, TestContext } from 'node:test';
import { sequelize } from '../../../config/database.js';
import { Tenant } from '../../auth/models/index.js';
import { Invoice, InvoicePayment, InvoiceProduct, InvoiceService } from '../models/index.js';
import Patient from '../../patients/models/patient.model.js';
import { exportSistemaTS, updateInvoice } from './invoice.controller.js';

const record = (data: any) => ({ ...data, get(key: any) { return typeof key === 'string' ? this[key] : Object.fromEntries(Object.entries(this).filter(([, v]) => typeof v !== 'function')); },
    async update(values: any) { Object.assign(this, values); return this; } });
const run = (handler: any, req: any) => new Promise<any>(resolve => {
    const headers: Record<string, string> = {};
    const res: any = { code: 200, status(code: number) { this.code = code; return this; },
        json(value: any) { resolve({ code: this.code, ...value }); }, setHeader(key: string, value: string) { headers[key] = value; },
        send(value: any) { resolve({ code: this.code, value, headers }); } };
    handler(req, res, (error: any) => resolve({ code: error.statusCode ?? 500, message: error.message }));
});
function fixture(t: TestContext) {
    const invoice = record({ id: 'invoice', patientID: 'patient', status: 'paid', documentType: 'fattura', documentNumber: 12, documentYear: 2026,
        emissionDate: '2026-09-01', invoiceTotal: 100, invoiceNet: 100, stsSent: false, stsSentAt: null,
        issuer: { businessName: 'Studio storico', vatNumber: 'OLD', stsIssuerType: 'PHYSIOTHERAPIST' },
        stsExpenseTypeCode: null, services: [{ serviceName: 'Trattamento', quantity: 1, servicePrice: 100 }], products: [] });
    const tenant = record({ businessName: 'Studio attuale', VATNumber: 'NEW', administrationSettings: { fiscal: { stsIssuerType: 'AUTHORIZED_STRUCTURE', stsDefaultExpenseTypeCode: 'SR' } } });
    const payment = record({ invoiceId: 'invoice', amount: 100, status: 'POSTED', paidAt: '2026-09-10' });
    const mutations: any[] = [], locks: any[] = [];
    t.mock.method(sequelize, 'transaction', (async (work: any) => work({ LOCK: { UPDATE: 'UPDATE' } })) as any);
    t.mock.method(Invoice, 'schema', (() => ({ findOne: async () => invoice, findByPk: async (_id: any, options: any) => { if (options?.lock) locks.push(options); return invoice; },
        findAll: async () => [invoice], update: async () => { throw new Error('Export must never write transmission status'); } })) as any);
    t.mock.method(invoice, 'update', async (values: any, options: any) => { assert.ok(options.transaction); mutations.push(values); Object.assign(invoice, values); return invoice; });
    t.mock.method(InvoiceProduct, 'schema', (() => ({ findAll: async () => invoice.products, destroy: async () => { throw new Error('No line replacement'); } })) as any);
    t.mock.method(InvoiceService, 'schema', (() => ({ findAll: async () => invoice.services, destroy: async () => { throw new Error('No line replacement'); } })) as any);
    t.mock.method(InvoicePayment, 'schema', (() => ({ sum: async () => 100, findAll: async () => [payment], update: async () => { throw new Error('No payment changes'); } })) as any);
    t.mock.method(Tenant, 'findByPk', (async () => tenant) as any);
    t.mock.method(Patient, 'schema', (() => ({ findByPk: async () => record({ fiscalCode: 'RSSMRA80A01H501U', stsOppositionToDataSending: false }) })) as any);
    const req: any = { tenantSchema: 'test', params: { invoiceId: 'invoice' }, query: { year: '2026' }, body: { stsExpenseTypeCode: 'SP' },
        user: { tenants: [{ id: 'tenant' }] }, access: { scope: 'tenant', resource: 'invoice' } };
    return { invoice, tenant, payment, req, mutations, locks };
}
it('updates TS metadata on a paid invoice under lock, preserving issuer identity, amounts, lines and receipts', async t => {
    const f = fixture(t), before = f.invoice.get({ plain: true });
    const result = await run(updateInvoice, f.req);
    assert.equal(result.code, 200);
    assert.equal(f.locks.length, 1);
    assert.deepEqual(Object.keys(f.mutations[0]).sort(), ['issuer', 'stsExpenseTypeCode']);
    assert.equal(f.invoice.stsExpenseTypeCode, 'SP');
    assert.deepEqual(f.invoice.issuer, before.issuer);
    assert.equal(f.invoice.invoiceTotal, 100);
    assert.deepEqual(f.invoice.services, before.services);
    assert.equal(f.payment.amount, 100);
});
it('persists an explicitly cleared expense code on a paid invoice without reapplying the profile default', async t => {
    const f = fixture(t);
    f.invoice.stsExpenseTypeCode = 'SP';
    f.req.body.stsExpenseTypeCode = null;
    const result = await run(updateInvoice, f.req);
    assert.equal(result.code, 200);
    assert.equal(f.invoice.stsExpenseTypeCode, null);
    assert.equal(f.mutations[0].stsExpenseTypeCode, null);
    assert.equal(f.invoice.invoiceTotal, 100);
    assert.equal(f.payment.amount, 100);
    assert.equal(f.invoice.issuer.stsIssuerType, 'PHYSIOTHERAPIST');
});
it('uses current profile only for a legacy invoice missing it, retaining the historical issuer name and VAT', async t => {
    const f = fixture(t);
    delete f.invoice.issuer.stsIssuerType;
    f.req.body.stsExpenseTypeCode = 'SR';
    const result = await run(updateInvoice, f.req);
    assert.equal(result.code, 200);
    assert.equal(f.invoice.issuer.stsIssuerType, 'AUTHORIZED_STRUCTURE');
    assert.equal(f.invoice.issuer.businessName, 'Studio storico');
    assert.equal(f.invoice.issuer.vatNumber, 'OLD');
});
it('correcting TS metadata on a paid legacy invoice without issuer never freezes the current tenant identity', async t => {
    const f = fixture(t);
    f.invoice.issuer = null;
    f.req.body.stsExpenseTypeCode = 'SR';
    const before = f.invoice.get({ plain: true });
    const result = await run(updateInvoice, f.req);
    assert.equal(result.code, 200);
    assert.equal(f.invoice.issuer, null);
    assert.deepEqual(f.mutations[0], { stsExpenseTypeCode: 'SR' });
    assert.equal(f.invoice.invoiceTotal, before.invoiceTotal);
    assert.deepEqual(f.invoice.services, before.services);
    assert.deepEqual(f.invoice.products, before.products);
    assert.equal(f.payment.amount, 100);
    assert.equal(f.locks.length, 1);
});
it('rejects an expense code incompatible with the historical profile and ignores forged issuer/transmission data', async t => {
    const f = fixture(t);
    f.req.body = { stsExpenseTypeCode: 'SR', issuer: { stsIssuerType: 'AUTHORIZED_STRUCTURE' }, stsSent: true };
    assert.equal((await run(updateInvoice, f.req)).code, 400);
    assert.equal(f.mutations.length, 0);
    assert.equal(f.invoice.stsSent, false);
    assert.equal(f.invoice.issuer.stsIssuerType, 'PHYSIOTHERAPIST');
});
it('draft export resolves service-only legacy codes and never marks the source invoice as sent', async t => {
    const f = fixture(t);
    const result = await run(exportSistemaTS, f.req);
    assert.equal(result.code, 200);
    assert.match(result.value, /<tipoSpesa>SP<\/tipoSpesa>/);
    assert.match(result.headers['Content-Disposition'], /bozza-sistema-ts/);
    assert.equal(f.invoice.stsSent, false);
    assert.equal(f.invoice.stsExpenseTypeCode, null);
});
it('an unresolved export returns 422 and identifies the affected invoice instead of silently omitting it', async t => {
    const f = fixture(t);
    f.invoice.products = [{ productName: 'Prodotto' }];
    const result = await run(exportSistemaTS, f.req);
    assert.equal(result.code, 422);
    assert.match(result.message, /Fattura 12\/2026/);
    assert.match(result.message, /Seleziona il tipo di spesa/);
});
it('rejects markAsSent because generating a draft is not a verified TS transmission', async t => {
    const f = fixture(t);
    f.req.query.markAsSent = 'true';
    const result = await run(exportSistemaTS, f.req);
    assert.equal(result.code, 400);
    assert.match(result.message, /non attesta un invio/);
    assert.equal(f.invoice.stsSent, false);
});
