import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { sequelize } from '../../../config/database.js';
import { env } from '../../../config/env.js';
import { Tenant } from '../../auth/models/index.js';
import { Invoice } from '../models/index.js';
import Patient from '../../patients/models/patient.model.js';
import { FiscalSubmission } from '../../administration/models/index.js';
import { MockTransmissionGateway } from '../../administration/services/fiscalTransmissionGateway.js';
import { transmitFiscalDocument } from '../../administration/services/fiscalTransmissionRun.service.js';
import { exportFatturaPa, getFiscalRouting } from './invoice.controller.js';

const invoiceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const patientId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const tenantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const record = (data: Record<string, any>): Record<string, any> => ({ ...data,
    get(key: any) { return typeof key === 'string' ? this[key] : Object.fromEntries(Object.entries(this).filter(([, value]) => typeof value !== 'function')); },
    async update(values: Record<string, any>) { Object.assign(this, values); return this; }
});
const run = (req: any, handler = exportFatturaPa) => new Promise<any>(resolve => {
    const headers: Record<string, string> = {};
    const res: any = { code: 200, status(code: number) { this.code = code; return this; },
        json(value: any) { resolve({ code: this.code, ...value }); },
        setHeader(key: string, value: string) { headers[key] = value; },
        send(value: any) { resolve({ code: this.code, value, headers }); } };
    handler(req, res, (error: any) => resolve({ code: error.statusCode ?? 500, message: error.message }));
});
function fixture(t: TestContext) {
    assert.equal(env.fiscal.transmissionEnabled, false, 'tests must use the non-live gateway');
    const invoice = record({ id: invoiceId, patientID: patientId, status: 'unpaid', documentType: 'fattura',
        documentNumber: 12, documentYear: 2026, emissionDate: '2026-10-12',
        sellingPrice: 100, discSellingPrice: 90, invoiceVAT: 19.8, invoiceTotal: 109.8, invoiceNet: 109.8,
        discountType: 'percentage', discountAmount: 10, isRivals: false, isTaxWithholding: false,
        isStamp: false, stampChargedToPatient: false,
        issuer: { businessName: 'Studio storico', vatNumber: '01234567890', taxRegime: 'RF01',
            address: 'Via Storica 1', city: 'Roma', zipCode: '00100', province: 'RM' },
        recipient: { kind: 'BUSINESS', businessName: 'Cliente storico', vatNumber: '99999999999',
            address: 'Via Storica 2', city: 'Roma', zipCode: '00100', province: 'RM', country: 'IT', sdiCode: 'ABCDEF1' },
        products: [{ id: 'line', productName: 'Bene storico', productPrice: 100, quantity: 1, totalPrice: 100, productVat: '22' }], services: [] });
    const tenant = record({ businessName: 'Studio corrente diverso', VATNumber: '12345678901', taxRegime: 'RF19',
        administrationSettings: { fiscal: {} } });
    const patient = record({ id: patientId, fiscalCode: 'SYNTHETIC', name: 'Cliente', surname: 'corrente diverso',
        stsOppositionToDataSending: false, address: { address: 'Via Corrente 3', city: 'Roma', zipCode: '00100' } });
    const tx = {};
    const sent: string[] = [];
    t.mock.method(sequelize, 'transaction', (async (work: any) => work(tx)) as any);
    t.mock.method(sequelize, 'query', (async (sql: string, options: any) => {
        assert.match(sql, /pg_advisory_xact_lock/); assert.equal(options.transaction, tx); return [[], {}];
    }) as any);
    t.mock.method(Invoice, 'schema', (() => ({ findOne: async () => invoice })) as any);
    t.mock.method(invoice, 'update', async () => { throw new Error('Export must never update the invoice'); });
    t.mock.method(Tenant, 'findByPk', (async () => tenant) as any);
    t.mock.method(Patient, 'schema', (() => ({ findOne: async () => patient, findByPk: async () => patient })) as any);
    t.mock.method(FiscalSubmission, 'schema', (() => ({ findOne: async () => null,
        create: async (values: any, options: any) => { assert.equal(options.transaction, tx); return record({ id: 'submission', ...values }); }
    })) as any);
    t.mock.method(MockTransmissionGateway.prototype, 'transmit', async request => {
        sent.push(request.xml);
        return { outcome: 'ACCEPTED', externalId: 'synthetic', protocolNumber: 'synthetic', error: null, rawResponse: null };
    });
    const req: any = { tenantSchema: 'rehablo_test', params: { invoiceId }, query: {}, body: {},
        user: { id: 'operator', tid: tenantId, tenants: [{ id: tenantId }] },
        access: { userId: 'operator', scope: 'tenant', resource: 'invoice', structureId: null },
        header: () => 'synthetic-request-key' };
    return { invoice, tenant, patient, sent, req };
}

it('HTTP download and provider receive identical109.80 XML from frozen snapshots without touching the issued invoice', async t => {
    const f = fixture(t);
    const before = structuredClone(f.invoice.get({ plain: true }));
    const preview = await run(f.req, getFiscalRouting);
    assert.equal(preview.data.canDownloadFatturaPa, true);
    const download = await run(f.req);
    assert.equal(download.code, 200);
    assert.match(download.value, /<ImportoTotaleDocumento>109\.80<\/ImportoTotaleDocumento>/);
    assert.match(download.value, /Studio storico/);
    assert.doesNotMatch(download.value, /corrente diverso/);
    const transmission = await transmitFiscalDocument(f.req, { channel: 'SDI', documentId: invoiceId });
    assert.equal(transmission.summary.status, 'ACCEPTED');
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0], download.value);
    assert.deepEqual(f.invoice.get({ plain: true }), before);
});

for (const scenario of ['inconsistent-total', 'missing-issuer', 'missing-recipient', 'missing-contribution-metadata', 'unrepresentable-rounding']) {
    it(`${scenario}: download422, submissionINVALID, no gateway and no historical changes`, async t => {
        const f = fixture(t);
        if (scenario === 'inconsistent-total') f.invoice.invoiceTotal = 122;
        if (scenario === 'missing-issuer') f.invoice.issuer = null;
        if (scenario === 'missing-recipient') f.invoice.recipient = null;
        if (scenario === 'missing-contribution-metadata') { f.invoice.isRivals = true; f.invoice.rivals = 4; }
        if (scenario === 'unrepresentable-rounding') {
            f.invoice.products = Array.from({ length: 10 }, (_, index) => ({ id: String(index), productName: 'Seduta', productPrice: 40.98, quantity: 1, totalPrice: 40.98, productVat: '22' }));
            Object.assign(f.invoice, { discountAmount: 0, sellingPrice: 409.8, discSellingPrice: 409.8, invoiceVAT: 90.2, invoiceTotal: 500, invoiceNet: 500 });
        }
        const before = structuredClone(f.invoice.get({ plain: true }));
        const preview = await run(f.req, getFiscalRouting);
        assert.equal(preview.data.canDownloadFatturaPa, false);
        assert.ok(preview.data.blocks.length > 0);
        const download = await run(f.req);
        assert.equal(download.code, 422);
        const transmission = await transmitFiscalDocument(f.req, { channel: 'SDI', documentId: invoiceId });
        assert.equal(transmission.summary.status, 'INVALID');
        assert.equal(f.sent.length, 0);
        assert.deepEqual(f.invoice.get({ plain: true }), before);
    });
}
