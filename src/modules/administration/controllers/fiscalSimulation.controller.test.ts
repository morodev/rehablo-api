import assert from 'node:assert/strict';
import { describe, it, TestContext } from 'node:test';
import { Request, Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { Tenant } from '../../auth/models/index.js';
import { Invoice, InvoicePayment } from '../../invoice/models/index.js';
import Patient from '../../patients/models/patient.model.js';
import { FiscalSubmission } from '../models/index.js';
import { fiscalDocumentState, fiscalInvoiceScope, visibleRealFiscalSubmissions } from '../services/fiscalSimulation.service.js';
import { listFiscalSubmissions, previewFiscalSubmission, retryFiscalSubmission, submitFiscal } from './fiscalSimulation.controller.js';

const invoiceId = '11111111-1111-4111-8111-111111111111';
const patientId = '22222222-2222-4222-8222-222222222222';
const structureId = '33333333-3333-4333-8333-333333333333';
const userId = '44444444-4444-4444-8444-444444444444';
const tenantId = '55555555-5555-4555-8555-555555555555';
const schema = 'rehablo_' + tenantId.replaceAll('-', '');
const scopedInvoice = Invoice.schema(schema);
const scopedSubmission = FiscalSubmission.schema(schema);
const generator = (sequelize.getQueryInterface() as any).queryGenerator;

function record(values: Record<string, any>): any {
    const data = structuredClone(values);
    return { data, get: (key: string | object) => typeof key === 'string' ? data[key] : { ...data },
        update: async (changes: object) => { Object.assign(data, changes); } };
}
function run(handler: (req: Request, res: Response, next: NextFunction) => void, req: any): Promise<{ status: number; body: any }> {
    return new Promise(resolve => {
        const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; },
            json(body: unknown) { resolve({ status: this.statusCode, body }); return this; } };
        handler(req, res, (error?: any) => resolve({ status: error?.statusCode ?? 500, body: { message: error?.message } }));
    });
}
function fixture(t: TestContext) {
    const invoice = record({ id: invoiceId, patientID: patientId, structureId,
        documentNumber: 7, documentYear: 2026, emissionDate: '2026-09-20',
        invoiceTotal: 100, invoiceNet: 100, documentType: 'fattura', status: 'paid',
        issuer: { businessName: 'Studio di fisioterapia', vatNumber: '12345678901' },
        stsExpenseTypeCode: 'SP', stsExcluded: false, stsSent: false, stsSentAt: null,
        services: [{ serviceName: 'Trattamento', quantity: 2, servicePrice: 50 }], products: [] });
    const patient = record({ id: patientId, name: 'Mario', surname: 'Rossi', fiscalCode: 'RSSMRA80A01H501U',
        stsOppositionToDataSending: false, structureId, userId });
    const tenant = record({ administrationSettings: { fiscal: { stsIssuerType: 'PHYSIOTHERAPIST', stsDefaultExpenseTypeCode: 'SP' } }, featureFlags: { fiscalSandbox: true }, businessName: 'Studio attuale', VATNumber: '09876543210', address: 'Via Roma 1', city: 'Roma', zipCode: '00100' });
    const submissions: any[] = [];
    const invoiceQueries: any[] = [];
    const submissionQueries: any[] = [];
    const sqlQueries: any[] = [];
    let accessible = true;
    let tail = Promise.resolve();
    t.mock.method(sequelize, 'transaction', ((work: any) => {
        const task = tail.then(() => work({ LOCK: { UPDATE: 'UPDATE' } }));
        tail = task.then(() => undefined, () => undefined);
        return task;
    }) as any);
    t.mock.method(sequelize, 'query', (async (sql: string, options: any) => {
        assert.match(sql, /pg_advisory_xact_lock/); sqlQueries.push({ sql, options }); return [[], {}];
    }) as any);
    t.mock.method(Invoice, 'schema', (() => ({
        findOne: async ({ where }: any) => {
            invoiceQueries.push(where);
            const terms = where[Op.and];
            return accessible && terms?.[0]?.id === invoiceId ? invoice : null;
        },
        findAll: async ({ where }: any) => { invoiceQueries.push(where); return accessible ? [invoice] : []; }
    })) as any);
    t.mock.method(InvoicePayment, 'schema', (() => ({ findAll: async () => [] })) as any);
    t.mock.method(Patient, 'schema', (() => ({ findOne: async () => accessible ? patient : null,
        findAll: async () => accessible ? [patient] : [] })) as any);
    t.mock.method(Tenant, 'findByPk', (async () => tenant) as any);
    t.mock.method(FiscalSubmission, 'schema', (() => ({
        findByPk: async (id: string) => submissions.find(row => row.data.id === id) ?? null,
        findOne: async ({ where }: any) => submissions.find(row => row.data.idempotencyKey === where.idempotencyKey) ?? null,
        findAll: async ({ where }: any) => {
            submissionQueries.push(where);
            return submissions.filter(row => where.documentId[Op.in].includes(row.data.documentId));
        },
        create: async (data: any) => {
            const row = record({ id: `66666666-6666-4666-8666-${String(submissions.length + 1).padStart(12, '0')}`, createdAt: new Date(), ...data });
            submissions.push(row); return row;
        }
    })) as any);
    const req: any = {
        tenantSchema: schema, user: { tid: tenantId, sub: userId },
        access: { scope: 'tenant', structureId, userId, resource: 'fiscal_submission', action: 'create' },
        params: {}, query: {}, body: { documentId: invoiceId, channel: 'STS', scenario: 'ACCEPTED' },
        header: () => 'fiscal-simulation-1'
    };
    return { req, invoice, patient, tenant, submissions, invoiceQueries, submissionQueries, sqlQueries,
        deny: () => { accessible = false; } };
}

describe('fiscal simulation endpoints', () => {
    it('previews the saved invoice with explicit simulation metadata and basic checks only', async t => {
        const f = fixture(t);
        const response = await run(previewFiscalSubmission, f.req);
        assert.equal(response.status, 200);
        assert.deepEqual(response.body.data, { documentId: invoiceId, documentNumber: '7/2026', patientName: 'Mario Rossi',
            channel: 'STS', total: 100, paidAmount: 100, stsExpenseTypeCode: 'SP', stsExpenseTypeSource: 'SAVED', stsIssuerType: 'PHYSIOTHERAPIST', issues: [], canSimulate: true, isSimulation: true });
        assert.equal(f.submissions.length, 0);
    });
    it('resolves service-only legacy TS data in the preview and submission snapshot without writing the invoice', async t => {
        const f = fixture(t);
        f.invoice.data.stsExpenseTypeCode = null;
        const before = structuredClone(f.invoice.data);
        const preview = await run(previewFiscalSubmission, f.req);
        assert.equal(preview.body.data.stsExpenseTypeCode, 'SP');
        assert.equal(preview.body.data.stsExpenseTypeSource, 'PROFILE');
        assert.equal((await run(submitFiscal, f.req)).status, 201);
        assert.equal(f.submissions[0].data.payloadSnapshot.invoice.stsExpenseTypeCode, 'SP');
        assert.deepEqual(f.invoice.data, before);
    });
    it('blocks STS with a missing issuer profile, while SDI does not require TS metadata', async t => {
        const f = fixture(t);
        f.tenant.data.administrationSettings = {};
        f.invoice.data.stsExpenseTypeCode = null;
        const sts = await run(previewFiscalSubmission, f.req);
        assert.ok(sts.body.data.issues.some((issue: any) => issue.field === 'stsIssuerType'));
        f.req.body.channel = 'SDI';
        const sdi = await run(previewFiscalSubmission, f.req);
        assert.equal(sdi.body.data.canSimulate, true);
        assert.equal(sdi.body.data.stsExpenseTypeCode, undefined);
    });
    it('requires an explicit valid code for mixed invoices and never repairs an invalid saved placeholder', async t => {
        const f = fixture(t);
        f.invoice.data.products = [{}];
        f.invoice.data.stsExpenseTypeCode = null;
        const missing = await run(previewFiscalSubmission, f.req);
        assert.ok(missing.body.data.issues.some((issue: any) => issue.field === 'stsExpenseTypeCode'));
        f.invoice.data.stsExpenseTypeCode = 'PRESTAZIONE_SANITARIA_FISIOTERAPICA';
        const invalid = await run(previewFiscalSubmission, f.req);
        assert.equal(invalid.body.data.stsExpenseTypeCode, null);
        assert.equal((await run(submitFiscal, f.req)).status, 422);
        assert.equal(f.submissions.length, 0);
    });
    it('uses current issuer data only for a legacy invoice without an issuer snapshot, without changing the invoice', async t => {
        const f = fixture(t);
        f.invoice.data.issuer = null;
        const before = structuredClone(f.invoice.data);
        const preview = await run(previewFiscalSubmission, f.req);
        assert.equal(preview.body.data.canSimulate, true);
        const response = await run(submitFiscal, f.req);
        assert.equal(response.status, 201);
        assert.equal(f.submissions[0].data.payloadSnapshot.invoice.issuerIsFallback, true);
        assert.equal(f.submissions[0].data.payloadSnapshot.invoice.issuer.businessName, 'Studio attuale');
        assert.equal(f.submissions[0].data.payloadSnapshot.invoice.issuer.vatNumber, '09876543210');
        assert.deepEqual(f.invoice.data, before);
    });
    it('preserves a partially saved issuer snapshot instead of replacing it with current tenant data', async t => {
        const f = fixture(t);
        f.invoice.data.issuer = { businessName: 'Studio storico', vatNumber: null };
        const preview = await run(previewFiscalSubmission, f.req);
        assert.equal(preview.body.data.canSimulate, false);
        assert.ok(preview.body.data.issues.some((issue: any) => issue.field === 'issuer.vatNumber'));
        assert.equal((await run(submitFiscal, f.req)).status, 422);
        assert.equal(f.invoice.data.issuer.businessName, 'Studio storico');
        assert.equal(f.invoice.data.issuer.vatNumber, null);
        assert.equal(f.submissions.length, 0);
    });
    it('displays the invoice total separately from the payable amount and collections after withholding', async t => {
        const f = fixture(t);
        f.invoice.data.invoiceTotal = 100;
        f.invoice.data.invoiceNet = 80;
        const preview = await run(previewFiscalSubmission, f.req);
        assert.equal(preview.body.data.total, 100);
        assert.equal(preview.body.data.paidAmount, 80);
        const created = await run(submitFiscal, f.req);
        assert.equal(created.body.data.amount, 100);
        const listed = await run(listFiscalSubmissions, f.req);
        assert.equal(listed.body.data.items[0].amount, 100);
        assert.equal(f.submissions[0].data.payloadSnapshot.paidAmount, 80);
    });
    it('explains missing data, opposition, exclusions and disabled sandbox without creating a submission', async t => {
        const f = fixture(t);
        Object.assign(f.invoice.data, { documentNumber: null, emissionDate: null, invoiceTotal: 0, invoiceNet: 0,
            status: 'draft', issuer: {}, stsExpenseTypeCode: null, stsExcluded: true });
        Object.assign(f.patient.data, { fiscalCode: null, stsOppositionToDataSending: true });
        f.tenant.data.featureFlags.fiscalSandbox = false;
        f.invoice.data.products = [{}];
        const preview = await run(previewFiscalSubmission, f.req);
        const fields = preview.body.data.issues.map((issue: any) => issue.field);
        for (const field of ['documentNumber', 'emissionDate', 'total', 'status', 'issuer.businessName', 'issuer.vatNumber',
            'stsExpenseTypeCode', 'stsExcluded', 'stsOppositionToDataSending', 'fiscalCode', 'fiscalSandbox', 'paidAmount']) {
            assert.ok(fields.includes(field), field);
        }
        assert.equal(preview.body.data.canSimulate, false);
        assert.equal((await run(submitFiscal, f.req)).status, 409);
        assert.equal(f.submissions.length, 0);
    });
    it('registers an accepted local outcome from server data and never marks the invoice as fiscally sent', async t => {
        const f = fixture(t);
        f.req.body.payload = { amount: 1, forceReject: true, invoice: { documentNumber: 999 } };
        const before = structuredClone(f.invoice.data);
        const response = await run(submitFiscal, f.req);
        assert.equal(response.status, 201);
        assert.equal(response.body.data.status, 'ACCEPTED');
        assert.equal(response.body.data.isSimulation, true);
        assert.equal(response.body.data.provider, 'MOCK');
        assert.equal(response.body.data.amount, 100);
        assert.equal(response.body.data.documentNumber, '7/2026');
        assert.match(response.body.data.protocolNumber, /^SANDBOX-STS-/);
        assert.equal(f.submissions[0].data.payloadSnapshot.invoice.documentNumber, 7);
        assert.equal(f.submissions[0].data.payloadSnapshot.forceReject, undefined);
        assert.deepEqual(f.invoice.data, before);
        assert.equal(response.body.data.payloadSnapshot, undefined);
    });
    it('supports deterministic rejection followed by accepted retry from newly saved source data', async t => {
        const f = fixture(t);
        f.req.body.scenario = 'REJECTED';
        const rejected = await run(submitFiscal, f.req);
        assert.equal(rejected.body.data.status, 'REJECTED');
        assert.match(rejected.body.data.lastError, /Rifiuto simulato/);
        f.invoice.data.invoiceNet = 80;
        f.invoice.data.invoiceTotal = 80;
        f.req.params.id = rejected.body.data.id;
        f.req.header = () => 'fiscal-retry-2';
        f.req.body = { scenario: 'ACCEPTED', correction: { invoiceNet: 5 }, payload: { forceReject: true } };
        const retried = await run(retryFiscalSubmission, f.req);
        assert.equal(retried.status, 201);
        assert.equal(retried.body.data.status, 'ACCEPTED');
        assert.equal(retried.body.data.attempts, 2);
        assert.equal(retried.body.data.amount, 80);
        assert.equal(f.submissions[1].data.payloadSnapshot.invoice.invoiceNet, 80);
        assert.equal(f.submissions[1].data.payloadSnapshot.previousSubmissionId, rejected.body.data.id);
        assert.equal(f.invoice.data.stsSent, false);
        assert.equal(f.invoice.data.stsSentAt, null);
    });
    it('serializes concurrent duplicate requests and replays their saved outcome', async t => {
        const f = fixture(t);
        const responses = await Promise.all([run(submitFiscal, f.req), run(submitFiscal, f.req)]);
        assert.deepEqual(responses.map(row => row.status), [201, 200]);
        assert.equal(responses[0].body.data.id, responses[1].body.data.id);
        assert.equal(f.submissions.length, 1);
        assert.equal(f.sqlQueries.length, 2);
        assert.equal(f.sqlQueries[0].options.replacements.schema, schema);
        assert.equal(f.sqlQueries[0].options.replacements.key, 'fiscal:fiscal-simulation-1');
    });
    it('rejects reuse of the same request key with changed channel or selected outcome', async t => {
        const f = fixture(t);
        await run(submitFiscal, f.req);
        f.req.body.channel = 'SDI';
        assert.equal((await run(submitFiscal, f.req)).status, 409);
        f.req.body.channel = 'STS';
        f.req.body.scenario = 'REJECTED';
        assert.equal((await run(submitFiscal, f.req)).status, 409);
        assert.equal(f.submissions.length, 1);
    });
    it('does not retry successful outcomes or arbitrary real submissions', async t => {
        const f = fixture(t);
        const response = await run(submitFiscal, f.req);
        f.req.params.id = response.body.data.id;
        f.req.header = () => 'fiscal-retry-2';
        assert.equal((await run(retryFiscalSubmission, f.req)).status, 409);
        f.submissions[0].data.status = 'REJECTED';
        f.submissions[0].data.provider = 'REAL';
        assert.equal((await run(retryFiscalSubmission, f.req)).status, 409);
        assert.equal(f.submissions.length, 1);
    });
    it('blocks submission on missing data even when bypassing the preview', async t => {
        const f = fixture(t);
        f.patient.data.fiscalCode = null;
        const response = await run(submitFiscal, f.req);
        assert.equal(response.status, 422);
        assert.match(response.body.message, /codice fiscale/);
        assert.equal(f.submissions.length, 0);
    });
    it('rejects malformed UUIDs, channels and scenarios without querying invalid identifiers', async t => {
        const f = fixture(t);
        f.req.body.documentId = '__none__';
        assert.equal((await run(previewFiscalSubmission, f.req)).status, 400);
        assert.equal(f.invoiceQueries.length, 0);
        f.req.body.documentId = invoiceId;
        f.req.body.channel = 'INVALID';
        assert.equal((await run(submitFiscal, f.req)).status, 400);
        f.req.body.channel = 'STS';
        f.req.body.scenario = 'UNKNOWN';
        assert.equal((await run(submitFiscal, f.req)).status, 400);
        assert.equal(f.submissions.length, 0);
    });
    it('does not allow preview, submit or retry for an inaccessible invoice', async t => {
        const f = fixture(t);
        f.req.body.scenario = 'REJECTED';
        const original = await run(submitFiscal, f.req);
        f.deny();
        assert.equal((await run(previewFiscalSubmission, f.req)).status, 404);
        assert.equal((await run(submitFiscal, f.req)).status, 404);
        f.req.params.id = original.body.data.id;
        f.req.header = () => 'denied-retry';
        assert.equal((await run(retryFiscalSubmission, f.req)).status, 404);
        assert.equal(f.submissions.length, 1);
    });
    it('lists only submissions whose source invoices are still accessible and omits snapshot data', async t => {
        const f = fixture(t);
        await run(submitFiscal, f.req);
        f.submissions.push(record({ id: 'foreign', documentId: '77777777-7777-4777-8777-777777777777', provider: 'MOCK' }));
        const visible = await run(listFiscalSubmissions, f.req);
        assert.equal(visible.body.data.total, 1);
        assert.equal(visible.body.data.items[0].isSimulation, true);
        assert.equal(visible.body.data.items[0].payloadSnapshot, undefined);
        f.deny();
        assert.equal((await run(listFiscalSubmissions, f.req)).body.data.total, 0);
    });
    it('scopes overview counters to accessible invoices and excludes simulated submissions in SQL', async t => {
        const f = fixture(t);
        await visibleRealFiscalSubmissions(f.req);
        const where = f.submissionQueries[0];
        assert.deepEqual(where.documentId[Op.in], [invoiceId]);
        const query = generator.selectQuery(scopedSubmission.getTableName(), { where }, scopedSubmission);
        assert.match(query, /"provider" != 'MOCK'/);
        assert.ok(query.includes(invoiceId));
        f.deny();
        await visibleRealFiscalSubmissions(f.req);
        assert.deepEqual(f.submissionQueries[1].documentId[Op.in], []);
    });
    it('keeps mock accepted outcomes separate from the real fiscal status', () => {
        assert.deepEqual(fiscalDocumentState({ stsSent: false }, [{ provider: 'MOCK', channel: 'STS', status: 'ACCEPTED' }]), {
            fiscalStatus: 'NOT_SENT', fiscalChannel: null, fiscalSimulationStatus: 'ACCEPTED', fiscalSimulationChannel: 'STS'
        });
        assert.equal(fiscalDocumentState({ stsSent: true }, []).fiscalStatus, 'UNVERIFIED');
        assert.equal(fiscalDocumentState({ stsSent: false }, [
            { provider: 'MOCK', channel: 'SDI', status: 'REJECTED' },
            { provider: 'LIVE', channel: 'SDI', status: 'ACCEPTED' }
        ]).fiscalStatus, 'ACCEPTED');
    });
});

describe('fiscal invoice scope SQL', () => {
    function sql(scope: string, selectedStructure: string | null = structureId) {
        const req = { tenantSchema: schema, access: { scope, userId, structureId: selectedStructure, resource: 'fiscal_submission' } } as Request;
        return generator.selectQuery(scopedInvoice.getTableName(), { where: fiscalInvoiceScope(req) }, scopedInvoice);
    }
    it('uses the tenant schema without dropping patients for owners', () => {
        const query = sql('tenant');
        assert.ok(query.includes('"' + schema + '"."invoices"'));
        assert.doesNotMatch(query, /patientID|IS NULL|__none__/);
    });
    it('combines structure and patient restrictions for scoped operators', () => {
        const query = sql('structure');
        assert.match(query, /"patientID" IN \(SELECT "id" FROM/);
        assert.match(query, /"invoice"."structureId" =/);
        assert.ok(query.includes(structureId));
    });
    it('uses patient ownership for personal access', () => {
        const query = sql('own');
        assert.match(query, /"userId" =/);
        assert.ok(query.includes(userId));
    });
    it('uses an always-false condition without invalid UUID sentinels for missing structure', () => {
        const query = sql('structure', null);
        assert.match(query, /1=0/);
        assert.doesNotMatch(query, /__none__/);
    });
});
