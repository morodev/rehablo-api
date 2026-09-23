import assert from 'node:assert/strict';
import { it, TestContext } from 'node:test';
import { Request, Response, NextFunction } from 'express';
import { sequelize } from '../../../config/database.js';
import { Tenant } from '../../auth/models/index.js';
import Patient from '../../patients/models/patient.model.js';
import { CarePackage, Quote, TreasuryMovement } from '../../administration/models/administration.model.js';
import { QuoteDelivery } from '../../administration/models/quoteDelivery.model.js';
import { documentHash, quoteDocument } from '../../administration/services/quoteDocument.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import PatientPortalAudit from '../models/patientPortalAudit.model.js';
import { decideQuote } from './patientPortalCommerce.controller.js';

const uuid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const schema = 'rehablo_' + uuid(1).replaceAll('-', '');
const row = (value: Record<string, any>): any => ({ ...value,
    get(key: string | object) { return typeof key === 'string' ? this[key] : { ...this }; },
    async update(changes: Record<string, unknown>) { Object.assign(this, changes); return this; }
});

function run(handler: (req: Request, res: Response, next: NextFunction) => void, req: any): Promise<{ status: number; body: any }> {
    return new Promise(resolve => {
        const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; },
            json(body: unknown) { resolve({ status: this.statusCode, body }); return this; } };
        handler(req, res, (error?: any) => resolve({ status: error?.statusCode ?? 500, body: { message: error?.message } }));
    });
}

function fixture(t: TestContext, stale = false) {
    const quote = row({ id: uuid(2), patientId: uuid(3), status: 'SENT', number: 1, year: 2026,
        issuedAt: '2026-01-01', expiresAt: '2999-12-31', currency: 'EUR', subtotal: 100, taxTotal: 0,
        total: 100, lines: [{ itemType: 'SERVICE', description: 'Seduta', quantity: 2, unitPrice: 50, total: 100 }], notes: '' });
    const patient = row({ id: uuid(3), name: 'Paziente', surname: 'Test' });
    const tenant = row({ id: uuid(1), businessName: 'Centro' });
    const snapshot = quoteDocument(quote, patient, tenant);
    const delivery = row({ id: uuid(4), quoteId: quote.id, patientId: patient.id, status: 'SENT',
        expiresAt: new Date('2999-12-31'), snapshotHash: stale ? 'changed' : documentHash(snapshot) });
    const audits: any[] = [];
    let packageCreates = 0;
    t.mock.method(sequelize, 'transaction', (async (work: any) => work({ LOCK: { UPDATE: 'UPDATE' } })) as any);
    t.mock.method(Quote, 'schema', (() => ({ findOne: async ({ where }: any) =>
        where.id === quote.id && where.patientId === patient.id ? quote : null })) as any);
    t.mock.method(QuoteDelivery, 'schema', (() => ({ findOne: async ({ where }: any) =>
        where.id === delivery.id && where.patientId === patient.id ? delivery : null })) as any);
    t.mock.method(Patient, 'schema', (() => ({ findByPk: async () => patient })) as any);
    t.mock.method(Tenant, 'findByPk', (async () => tenant) as any);
    t.mock.method(PatientPortalAudit, 'schema', (() => ({ create: async (data: any) => audits.push(data) })) as any);
    t.mock.method(CarePackage, 'schema', (() => ({ create: async () => { packageCreates++; } })) as any);
    const req: any = { tenantSchema: schema, params: { quoteId: quote.id, deliveryId: delivery.id },
        user: { tid: uuid(1), pid: patient.id, patientAccessId: uuid(5), sub: uuid(6) },
        patientPortalAccess: row({ status: 'ACTIVE' }), get: () => null, ip: '127.0.0.1' };
    return { quote, audits, req, get packageCreates() { return packageCreates; } };
}

it('rejects a patient decision on an old delivery snapshot', async t => {
    const f = fixture(t, true);
    const result = await run(decideQuote('ACCEPTED'), f.req);
    assert.equal(result.status, 409);
    assert.equal(f.quote.status, 'SENT');
    assert.equal(f.audits.length, 0);
});

it('records patient acceptance without activating a package', async t => {
    const f = fixture(t);
    const result = await run(decideQuote('ACCEPTED'), f.req);
    assert.equal(result.status, 200);
    assert.equal(f.quote.status, 'ACCEPTED');
    assert.equal(f.packageCreates, 0);
    assert.equal(f.audits[0].action, 'ACCEPTED');
});

it('denies quote decisions to a historical patient', async t => {
    const f = fixture(t);
    f.req.patientPortalAccess.status = 'HISTORICAL';
    const result = await run(decideQuote('ACCEPTED'), f.req);
    assert.equal(result.status, 403);
    assert.equal(f.quote.status, 'SENT');
});

it('never mirrors a credit application as a new cash receipt', async t => {
    let treasuryLookups = 0;
    t.mock.method(TreasuryMovement, 'schema', (() => { treasuryLookups++; throw new Error('No cash movement expected'); }) as any);
    const payment = InvoicePayment.schema(schema).build({ invoiceId: uuid(7), amount: 40,
        source: 'CREDIT', status: 'POSTED', paidAt: new Date() });
    await (InvoicePayment.schema(schema) as any).runHooks('afterCreate', payment, {});
    assert.equal(treasuryLookups, 0);
});
