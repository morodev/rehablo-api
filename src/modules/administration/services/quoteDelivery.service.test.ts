import assert from 'node:assert/strict';
import { describe, it, TestContext } from 'node:test';
import { Request } from 'express';
import { Op } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { transporter } from '../../../services/email.service.js';
import Tenant from '../../auth/models/tenant.model.js';
import Structure from '../../auth/models/structure.model.js';
import Patient from '../../patients/models/patient.model.js';
import { Quote } from '../models/administration.model.js';
import { QuoteDelivery, QuoteShareLink } from '../models/quoteDelivery.model.js';
import { quoteConsentAllows, quotePhone, quoteRecipient } from './quoteContact.js';
import { quoteDateError, quoteDocument, documentHash } from './quoteDocument.js';
import { quoteScopeWhere, validateQuoteDraft } from './quoteAccess.js';
import {
    deliverQuote, publicQuoteDocument, quoteDeliveryTransport, quoteDeliveryView, quoteShareToken,
    sendQuoteMail, updateQuoteDelivery, revokeQuoteLinks, hasUnsharedQuoteChanges, currentQuoteDocument
} from './quoteDelivery.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const quoteId = '22222222-2222-4222-8222-222222222222';
const patientId = '33333333-3333-4333-8333-333333333333';
const structureId = '44444444-4444-4444-8444-444444444444';
const userId = '55555555-5555-4555-8555-555555555555';

function record(value: Record<string, any>): any {
    const data = structuredClone(value);
    return {
        data, id: data.id, get: (key: string | object) => typeof key === 'string' ? data[key] : { ...data },
        update: async (changes: object) => { Object.assign(data, changes); return record; }
    };
}

function fixture(t: TestContext) {
    const quote = record({ id: quoteId, patientId, structureId, status: 'DRAFT', number: 7, year: 2026,
        issuedAt: '2026-01-01', expiresAt: '2099-12-31', currency: 'EUR', createdByUserId: userId,
        lines: [{ itemType: 'SERVICE', description: 'Trattamento', quantity: 2, unitPrice: 30, total: 60 }],
        subtotal: 60, total: 60, taxTotal: 0, notes: 'Buongiorno' });
    const patient = record({ id: patientId, name: 'Mario', surname: 'Rossi', emails: [{ email: 'mario@example.test' }],
        phoneNumbers: [{ country: 'it', phoneNumber: '3331234567' }], structureId, userId });
    const tenant = record({ id: tenantId, businessName: 'Studio', VATNumber: '12345678901', address: 'Via Roma 1' });
    const deliveries: any[] = [];
    const links: any[] = [];
    const request = {
        tenantSchema: 'rehablo_' + tenantId.replace(/-/g, ''), params: { id: quoteId }, body: {},
        user: { tid: tenantId, sub: userId, perms: ['quote:manage:tenant', 'patient:update:tenant'] },
        access: { scope: 'tenant', resource: 'quote', action: 'export', structureId, userId },
        header: () => 'request-0001'
    } as unknown as Request;
    const matches = (row: any, where: any): boolean => Object.keys(where ?? {}).every(key => {
        const expected = where[key];
        if (expected && typeof expected === 'object' && expected[Op.gt]) return new Date(row.data[key]) > expected[Op.gt];
        return expected == null ? row.data[key] == null : row.data[key] === expected;
    });
    let tail = Promise.resolve();
    t.mock.method(sequelize, 'transaction', ((work: any) => {
        const task = tail.then(() => work({ LOCK: { UPDATE: 'UPDATE' } }));
        tail = task.then(() => undefined, () => undefined);
        return task;
    }) as any);
    t.mock.method(Quote, 'schema', (() => ({
        findOne: async ({ where }: any) => where.id === quoteId ? quote : null,
        findByPk: async (id: string) => id === quoteId ? quote : null
    })) as any);
    t.mock.method(Patient, 'schema', (() => ({ findOne: async () => patient })) as any);
    t.mock.method(Tenant, 'findByPk', (async () => tenant) as any);
    t.mock.method(Structure, 'findOne', (async () => record({ id: structureId, tenantId })) as any);
    t.mock.method(QuoteDelivery, 'schema', (() => ({
        findOne: async ({ where, order }: any) => {
            const matching = deliveries.filter(row => matches(row, where));
            return (order ? matching.reverse() : matching)[0] ?? null;
        },
        findByPk: async (id: string) => deliveries.find(row => row.data.id === id) ?? null,
        count: async ({ where }: any) => deliveries.filter(row => matches(row, where)).length,
        create: async (values: any) => { const row = record({ createdAt: new Date(), revokedAt: null, ...values }); deliveries.push(row); return row; },
        update: async (values: any, { where }: any) => { for (const row of deliveries.filter(row => matches(row, where))) await row.update(values); }
    })) as any);
    t.mock.method(QuoteShareLink, 'create', (async (values: any) => { const row = record({ revokedAt: null, ...values }); links.push(row); return row; }) as any);
    t.mock.method(QuoteShareLink, 'findOne', (async ({ where }: any) => links.find(row => matches(row, where)) ?? null) as any);
    t.mock.method(QuoteShareLink, 'update', (async (values: any, { where }: any) => { for (const row of links.filter(row => matches(row, where))) await row.update(values); }) as any);
    const send = t.mock.method(quoteDeliveryTransport, 'send', async () => undefined);
    return { request, quote, patient, tenant, deliveries, links, send };
}

describe('quote document and recipients', () => {
    it('rejects invalid/reversed calendar dates without UTC date shifts', () => {
        assert.equal(quoteDateError('2026-03-29', '2026-03-29'), null);
        assert.match(quoteDateError('2026-02-30', '2026-03-01')!, /data/);
        assert.match(quoteDateError('2026-03-29', '2026-03-28')!, /precedere/);
        assert.match(quoteDateError('2026-03-29T00:00:00Z', null)!, /data/);
    });
    it('uses contact arrays and legacy fallback while rejecting an explicitly invalid recipient', () => {
        assert.equal(quoteRecipient('email', null, { emails: [{ email: 'bad' }], contactEmail: 'Old@Example.test' }), 'old@example.test');
        assert.equal(quoteRecipient('email', 'bad', { emails: [{ email: 'ok@example.test' }] }), null);
        assert.equal(quoteRecipient('whatsapp', null, { phoneNumbers: [{ country: 'it', phoneNumber: '333 123 4567' }] }), '+393331234567');
        assert.equal(quotePhone('+41 791234567'), '+41791234567');
        assert.equal(quotePhone('123'), null);
    });
    it('blocks only an explicit refusal on the selected channel', () => {
        assert.equal(quoteConsentAllows('email', { emailNotificationsConsent: false }), false);
        assert.equal(quoteConsentAllows('email', { emailNotificationsConsent: null, whatsappNotificationsConsent: false }), true);
        assert.equal(quoteConsentAllows('whatsapp', { whatsappNotificationsConsent: false }), false);
    });
    it('uses a public whitelist and hashes only document contents, independent of quote status', () => {
        const quote = { id: quoteId, number: 1, year: 2026, issuedAt: '2026-01-01', notes: 'Nota', lines: [], total: 20, subtotal: 20, taxTotal: 0 };
        const first = quoteDocument(quote, { name: 'Mario', notes: 'Clinica', emails: ['secret'] }, { businessName: 'Studio', VATNumber: '123', stripeId: 'secret' });
        assert.equal(first.issuer.vatNumber, '123');
        assert.equal(JSON.stringify(first).includes('secret'), false);
        assert.equal(JSON.stringify(first).includes('Clinica'), false);
        assert.equal(documentHash(first), documentHash(quoteDocument({ ...quote, status: 'SENT' }, { name: 'Mario' }, { businessName: 'Studio', VATNumber: '123' })));
    });
    it('isolates token derivation by tenant and delivery without revealing identifiers', () => {
        const token = quoteShareToken(tenantId, quoteId);
        assert.match(token, /^[a-f0-9]{64}$/);
        assert.equal(token, quoteShareToken(tenantId, quoteId));
        assert.notEqual(token, quoteShareToken(patientId, quoteId));
    });
});

describe('quote save/access policy', () => {
    it('preserves SENT when saving and rejects direct status transitions', async t => {
        const f = fixture(t);
        f.quote.data.status = 'SENT';
        const payload: Record<string, unknown> = { notes: 'Aggiornata' };
        await validateQuoteDraft(f.request, payload, f.quote);
        assert.equal(payload.status, 'SENT');
        assert.equal(payload.number, 7);
        await assert.rejects(validateQuoteDraft(f.request, { status: 'DRAFT' }, f.quote), /stato cambia/);
    });
    it('requires a selected patient and valid dates for a new saved quote', async t => {
        const f = fixture(t);
        await assert.rejects(validateQuoteDraft(f.request, { issuedAt: '2026-01-01', expiresAt: '2026-02-01', structureId }), /paziente/);
        await assert.rejects(validateQuoteDraft(f.request, { issuedAt: '2026-02-01', expiresAt: '2026-01-01', patientId, structureId }), /precedere/);
    });
    it('combines quote ownership/structure and patient scope, never a foreign UUID sentinel', () => {
        const req = { tenantSchema: 'rehablo_' + tenantId.replace(/-/g, ''), access: { scope: 'structure', structureId, userId } } as Request;
        const where = quoteScopeWhere(req) as any;
        assert.equal(where[Op.and][0].structureId, structureId);
        assert.deepEqual(where[Op.and][1][Op.or][0], { patientId: null });
        assert.ok(where[Op.and][1][Op.or][1].patientId[Op.in]);
        req.access!.structureId = null;
        assert.ok((quoteScopeWhere(req) as any)[Op.and][0][Op.and]);
    });
    it('keeps ownership mandatory for a legacy draft while restricting any non-null patient', () => {
        const req = { tenantSchema: 'rehablo_' + tenantId.replace(/-/g, ''), access: { scope: 'own', structureId, userId } } as Request;
        const where = quoteScopeWhere(req) as any;
        assert.deepEqual(where[Op.and][0], { createdByUserId: userId });
        assert.deepEqual(where[Op.and][1][Op.or][0], { patientId: null });
        const patientQuery = where[Op.and][1][Op.or][1].patientId[Op.in].val as string;
        assert.ok(patientQuery.includes(userId));
        assert.ok(patientQuery.includes('SELECT'));
    });
    it('allows repairing a legacy draft but still refuses document/share without a patient', async t => {
        const f = fixture(t);
        f.request.access!.scope = 'structure';
        f.quote.data.patientId = null;
        await assert.rejects(currentQuoteDocument(f.request, f.quote), /paziente valido/);
        await assert.rejects(deliverQuote(f.request, 'whatsapp'), /paziente valido/);
        const replacement = { patientId };
        await validateQuoteDraft(f.request, replacement, f.quote);
        assert.equal(replacement.patientId, patientId);
        t.mock.method(Patient, 'schema', (() => ({ findOne: async () => null })) as any);
        await assert.rejects(validateQuoteDraft(f.request, { patientId: userId }, f.quote), /Paziente non disponibile/);
    });
});

describe('quote scope SQL regression', () => {
    const schema = 'rehablo_' + tenantId.replace(/-/g, '');
    const sqlFor = (scope: 'tenant' | 'structure' | 'own', selectedStructure: string | null = structureId): string => {
        const req = {
            tenantSchema: schema,
            access: { scope, structureId: selectedStructure, userId }
        } as Request;
        const model = Quote.schema(schema);
        return (sequelize.getQueryInterface() as any).queryGenerator.selectQuery(model.getTableName(), {
            attributes: ['id'], where: { id: quoteId, ...quoteScopeWhere(req) }
        }, model);
    };

    it('loads normal and legacy quotes for tenant scope within the tenant schema', () => {
        const sql = sqlFor('tenant');
        assert.ok(sql.includes(`FROM "${schema}"."quotes"`));
        assert.ok(sql.includes(`WHERE "quote"."id" = '${quoteId}'`));
        assert.equal(sql.includes('patientId'), false);
        assert.equal(sql.includes('IS NULL'), false);
    });

    it('retains structure and patient constraints while permitting a legacy null patient', () => {
        const sql = sqlFor('structure');
        assert.ok(sql.includes(`"quote"."structureId" = '${structureId}' AND (`));
        assert.ok(sql.includes('"quote"."patientId" IS NULL OR "quote"."patientId" IN (SELECT'));
        assert.ok(sql.includes(`FROM "${schema}"."patients" WHERE "structureId" = '${structureId}'`));
        assert.ok(sql.includes(`AND "quote"."id" = '${quoteId}'`));
    });

    it('retains quote ownership and patient ownership for own scope', () => {
        const sql = sqlFor('own');
        assert.ok(sql.includes(`"quote"."createdByUserId" = '${userId}' AND (`));
        assert.ok(sql.includes('"quote"."patientId" IS NULL OR "quote"."patientId" IN (SELECT'));
        assert.ok(sql.includes(`FROM "${schema}"."patients" WHERE "userId" = '${userId}'`));
    });

    it('returns no rows when structure scope has no selected structure, including legacy quotes', () => {
        const sql = sqlFor('structure', null);
        assert.ok(sql.includes('WHERE (1=0 AND ('));
        assert.ok(sql.includes('"quote"."patientId" IS NULL OR 1=0'));
        assert.equal(sql.includes('__none__'), false);
    });
});

describe('quote deliveries without real network/database', () => {
    it('prepares WhatsApp without marking sent; confirmation is explicit and idempotent', async t => {
        const f = fixture(t);
        const result = await deliverQuote(f.request, 'whatsapp');
        assert.equal(f.quote.data.status, 'DRAFT');
        assert.equal(f.deliveries[0].data.status, 'READY');
        assert.equal(f.send.mock.callCount(), 0);
        const retry = await deliverQuote(f.request, 'whatsapp');
        assert.equal(result.url, retry.url);
        assert.equal(f.deliveries.length, 1);
        f.request.params.deliveryId = f.deliveries[0].data.id;
        await updateQuoteDelivery(f.request, 'confirm');
        const confirmed = f.deliveries[0].data.sentAt;
        await updateQuoteDelivery(f.request, 'confirm');
        assert.equal(f.quote.data.status, 'SENT');
        assert.equal(f.deliveries[0].data.sentAt, confirmed);
        assert.equal(f.deliveries[0].data.confirmedByUserId, userId);
    });
    it('marks SENT only after SMTP acceptance and replays the same key without a second email', async t => {
        const f = fixture(t);
        f.send.mock.mockImplementation(async () => { assert.equal(f.quote.data.status, 'DRAFT'); });
        await deliverQuote(f.request, 'email');
        assert.equal(f.quote.data.status, 'SENT');
        assert.equal(f.deliveries[0].data.status, 'SENT');
        await deliverQuote(f.request, 'email');
        assert.equal(f.send.mock.callCount(), 1);
    });
    it('blocks concurrent duplicate and distinct requests while an SMTP operation is pending', async t => {
        const f = fixture(t);
        let release!: () => void;
        let started!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        const sending = new Promise<void>(resolve => { started = resolve; });
        f.send.mock.mockImplementation(async () => { started(); await pending; });
        const first = deliverQuote(f.request, 'email');
        await sending;
        await assert.rejects(deliverQuote(f.request, 'email'), /già in corso/);
        const other = { ...f.request, header: () => 'request-0002' } as unknown as Request;
        await assert.rejects(deliverQuote(other, 'email'), /invio in corso/);
        release();
        await first;
        assert.equal(f.send.mock.callCount(), 1);
    });
    it('rejects altered payload reuse and explicit channel refusal without sending', async t => {
        const f = fixture(t);
        await deliverQuote(f.request, 'whatsapp');
        f.request.body = { recipient: '+393339999999' };
        await assert.rejects(deliverQuote(f.request, 'whatsapp'), /richiesta di invio è cambiata/);
        f.patient.data.emailNotificationsConsent = false;
        await assert.rejects(deliverQuote(f.request, 'email'), /rifiutato/);
        assert.equal(f.send.mock.callCount(), 0);
    });
    it('records definite SMTP refusal as FAILED and revokes its token without changing quote state', async t => {
        const f = fixture(t);
        f.send.mock.mockImplementation(async () => { throw Object.assign(new Error('refused'), { code: 'EENVELOPE' }); });
        await assert.rejects(deliverQuote(f.request, 'email'), (error: any) => {
            assert.equal(error.details.delivery.status, 'FAILED');
            return /Email non inviata/.test(error.message);
        });
        assert.equal(f.quote.data.status, 'DRAFT');
        assert.ok(f.links[0].data.revokedAt);
        await assert.rejects(deliverQuote(f.request, 'email'), /Email non inviata/);
        assert.equal(f.send.mock.callCount(), 1);
    });
    it('records uncertain outcomes, blocks resend and permits explicit revoke before a new attempt', async t => {
        const f = fixture(t);
        f.send.mock.mockImplementation(async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', command: 'DATA' }); });
        await assert.rejects(deliverQuote(f.request, 'email'), /potrebbe essere arrivata/);
        assert.equal(f.deliveries[0].data.status, 'PREPARING');
        assert.equal(f.quote.data.status, 'DRAFT');
        await assert.rejects(deliverQuote({ ...f.request, header: () => 'request-0002' } as unknown as Request, 'email'), /invio in corso/);
        f.request.params.deliveryId = f.deliveries[0].data.id;
        await updateQuoteDelivery(f.request, 'revoke');
        f.send.mock.mockImplementation(async () => undefined);
        await deliverQuote({ ...f.request, header: () => 'request-0003' } as unknown as Request, 'email');
        assert.equal(f.deliveries[0].data.status, 'PREPARING');
        assert.equal(f.deliveries[1].data.status, 'SENT');
    });
    it('refuses revocation of in-flight email but allows recovery of a stale crashed attempt', async t => {
        const f = fixture(t);
        await deliverQuote(f.request, 'whatsapp');
        const delivery = f.deliveries[0];
        delivery.data.status = 'PREPARING';
        f.request.params.deliveryId = delivery.data.id;
        await assert.rejects(updateQuoteDelivery(f.request, 'revoke'), /Attendi/);
        delivery.data.createdAt = new Date(Date.now() - 6 * 60 * 1000);
        await updateQuoteDelivery(f.request, 'revoke');
        assert.ok(delivery.data.revokedAt);
    });
    it('serves the immutable sent snapshot while edits flag unshared changes', async t => {
        const f = fixture(t);
        await deliverQuote(f.request, 'email');
        const token = quoteShareToken(tenantId, f.deliveries[0].data.id);
        f.quote.data.lines[0].description = 'Modificata dopo invio';
        const response = await publicQuoteDocument(token);
        assert.equal(response.document.lines[0].description, 'Trattamento');
        assert.equal(await hasUnsharedQuoteChanges(f.request, quoteDocument(f.quote.data, f.patient.data, f.tenant.data)), true);
        const view = quoteDeliveryView(f.deliveries[0]);
        assert.equal('snapshot' in view, false);
        assert.equal('tokenHash' in view, false);
    });
    it('rejects malformed, revoked and expired public links and changed patients', async t => {
        const f = fixture(t);
        await deliverQuote(f.request, 'whatsapp');
        const token = quoteShareToken(tenantId, f.deliveries[0].data.id);
        await assert.rejects(publicQuoteDocument('bad'), /Link non valido/);
        f.links[0].data.expiresAt = new Date(0);
        await assert.rejects(publicQuoteDocument(token), /Link non valido/);
        f.links[0].data.expiresAt = new Date('2099-01-01');
        f.quote.data.patientId = userId;
        await assert.rejects(publicQuoteDocument(token), /Link non valido/);
        f.quote.data.patientId = patientId;
        await revokeQuoteLinks(f.request, quoteId);
        await assert.rejects(publicQuoteDocument(token), /Link non valido/);
        assert.ok(f.deliveries[0].data.revokedAt);
    });
    it('does not save supplied contacts unless requested and authorized', async t => {
        const f = fixture(t);
        f.request.body = { recipient: 'occasional@example.test' };
        await deliverQuote(f.request, 'email');
        assert.equal(f.patient.data.emails.length, 1);
        f.request.body = { recipient: 'new@example.test', saveToPatient: true };
        f.request.header = (() => 'request-0002') as any;
        f.request.user!.perms = ['quote:manage:tenant'];
        await assert.rejects(deliverQuote(f.request, 'email'), /permesso/);
        assert.equal(f.send.mock.callCount(), 1);
    });
});

describe('quote email transport', () => {
    it('requires recipient acceptance and escapes user-provided HTML', async t => {
        const f = fixture(t);
        const input = { recipient: 'mario@example.test', message: '<script>alert(1)</script>', url: 'https://example.test/#/preventivo/token',
            document: quoteDocument(f.quote.data, f.patient.data, f.tenant.data), expiresAt: new Date('2099-01-01') };
        const smtp = t.mock.method(transporter, 'sendMail', (async (mail: any) => {
            assert.ok(mail.html.includes('&lt;script&gt;'));
            assert.equal(mail.html.includes('<script>'), false);
            return { accepted: ['mario@example.test'], rejected: [] };
        }) as any);
        await sendQuoteMail(input);
        smtp.mock.mockImplementation((async () => ({ accepted: [], rejected: ['mario@example.test'] })) as any);
        await assert.rejects(sendQuoteMail(input), /non ha accettato/);
    });
});
