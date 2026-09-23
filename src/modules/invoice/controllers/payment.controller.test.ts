import assert from 'node:assert/strict';
import { describe, it, TestContext } from 'node:test';
import { Request, Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import Invoice from '../models/invoice.model.js';
import InvoicePayment from '../models/invoicePayment.model.js';
import { CarePackage, FinancialAccount, PackageConsumption, PatientCredit, PaymentMethod, TreasuryMovement } from '../../administration/models/index.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import Tenant from '../../auth/models/tenant.model.js';
import { Structure } from '../../auth/models/index.js';
import administration from '../../administration/controllers/administration.controller.js';
import { createPayment, voidPayment } from './payment.controller.js';

const id = '11111111-1111-4111-8111-111111111111';
const structureId = '22222222-2222-4222-8222-222222222222';
const accountId = '33333333-3333-4333-8333-333333333333';
const methodId = '44444444-4444-4444-8444-444444444444';
const userId = '55555555-5555-4555-8555-555555555555';
const tenantId = '66666666-6666-4666-8666-666666666666';
const schema = 'rehablo_' + tenantId.replaceAll('-', '');
const ScopedPayment = InvoicePayment.schema(schema);
const generator = (sequelize.getQueryInterface() as any).queryGenerator;

function record(values: Record<string, any>): any {
    return { ...values, get(key: string | object) { return typeof key === 'string' ? this[key] : { ...values, status: this.status }; },
        async update(changes: object) { Object.assign(this, changes); return this; } };
}

function run(handler: (req: Request, res: Response, next: NextFunction) => void, req: any): Promise<{ status: number; body: any }> {
    return new Promise(resolve => {
        const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; },
            json(body: unknown) { resolve({ status: this.statusCode, body }); return this; } };
        handler(req, res, (error?: any) => resolve({ status: error?.statusCode ?? error?.status ?? 500, body: { message: error?.message } }));
    });
}

function fixture(t: TestContext) {
    const invoice = record({ id, structureId, patientID: userId, invoiceTotal: 100, status: 'unpaid', documentType: 'fattura' });
    const accounts = [record({ id: accountId, structureId, isActive: true })];
    const payments: any[] = [];
    const movements: any[] = [];
    const credits: any[] = [];
    const queries: Array<{ sql: string; options: any }> = [];
    const invoiceWhere: any[] = [];
    let failMovement = false;
    let tail = Promise.resolve();
    t.mock.method(sequelize, 'transaction', ((work: any) => {
        const task = tail.then(async () => {
            const counts = [payments.length, movements.length];
            const status = invoice.status;
            try { return await work({ LOCK: { UPDATE: 'UPDATE' } }); }
            catch (error) { payments.length = counts[0]; movements.length = counts[1]; invoice.status = status; throw error; }
        });
        tail = task.then(() => undefined, () => undefined);
        return task;
    }) as any);
    t.mock.method(Invoice, 'schema', (() => ({
        findOne: async ({ where }: any) => { invoiceWhere.push(where); return where.id === invoice.id ? invoice : null; },
        findByPk: async () => invoice
    })) as any);
    t.mock.method(InvoicePayment, 'schema', (() => ({
        findAll: async () => payments,
        findOne: async ({ where }: any) => payments.find(payment => payment.id === where.id && payment.invoiceId === where.invoiceId),
        create: async (values: any, options: any) => {
            const payment = ScopedPayment.build(values);
            payments.push(payment);
            await (ScopedPayment as any).runHooks('afterCreate', payment, options);
            return payment;
        }
    })) as any);
    t.mock.method(FinancialAccount, 'schema', (() => ({ findOne: async ({ where }: any) => accounts.find(account => account.id === where.id && account.isActive) })) as any);
    t.mock.method(PaymentMethod, 'schema', (() => ({ findOne: async ({ where }: any) => where.id === methodId ? record({ id: methodId, label: 'Bonifico', isActive: true }) : null })) as any);
    t.mock.method(Structure, 'findOne', (async ({ where }: any) => where.id === structureId && where.tenantId === tenantId ? record({ id: structureId, tenantId }) : null) as any);
    t.mock.method(TreasuryMovement, 'schema', (() => ({
        findOne: async ({ where }: any) => movements.find(movement => where.sourceType
            ? movement.sourceType === where.sourceType && movement.sourceId === where.sourceId && movement.status === where.status
            : movement.idempotencyKey === where.idempotencyKey),
        count: async ({ where }: any) => movements.filter(movement => movement.reversalOfId === where.reversalOfId && movement.status === where.status).length,
        create: async (payload: any) => { const movement = record(payload); movements.push(movement); return movement; }
    })) as any);
    t.mock.method(PatientCredit, 'schema', (() => ({
        create: async (payload: any) => { const credit = record(payload); credits.push(credit); return credit; }
    })) as any);
    t.mock.method(sequelize, 'query', (async (sql: string, options: any) => {
        queries.push({ sql, options });
        if (sql.includes('pg_advisory_xact_lock')) return [[], {}];
        if (sql.startsWith('SELECT COALESCE')) return [[{ structureId }], {}];
        if (sql.startsWith('SELECT "id"')) return [[{ id: accountId }], {}];
        if (sql.includes('INSERT INTO') && sql.includes('treasury_movements')) {
            if (failMovement) throw new Error('simulated database failure');
            const values = options.replacements;
            if (sql.includes("'INVOICE_PAYMENT_VOID'")) movements.push(record({ ...values, sourceType: 'INVOICE_PAYMENT_VOID', direction: 'OUT', status: 'POSTED' }));
            else if (!movements.some(row => row.sourceId === values.sourceId)) movements.push(record({ ...values, sourceType: 'INVOICE_PAYMENT', status: 'POSTED' }));
            return [[], {}];
        }
        throw new Error('Unexpected SQL: ' + sql);
    }) as any);
    const req: any = {
        tenantSchema: schema, params: { invoiceId: id },
        access: { scope: 'tenant', structureId, userId, resource: 'invoice', action: 'update' },
        user: { tid: tenantId, sub: userId },
        body: { amount: 60, paidAt: '2025-01-15', accountId, paymentMethodId: methodId, note: 'Acconto' },
        header: () => 'receipt-test-1'
    };
    return { req, invoice, accounts, payments, movements, credits, queries, invoiceWhere, failMovement: () => { failMovement = true; } };
}

describe('invoice receipt controller and treasury hook', () => {
    it('posts one receipt and one movement to the chosen account, updating the residual in the same transaction', async t => {
        const f = fixture(t);
        const response = await run(createPayment, f.req);
        assert.equal(response.status, 201);
        assert.equal(response.body.data.summary.balance, 40);
        assert.equal(f.invoice.status, 'partial');
        assert.equal(f.payments.length, 1);
        assert.equal(f.movements.length, 1);
        assert.equal(f.movements[0].accountId, accountId);
        assert.equal(f.movements[0].paymentMethodId, methodId);
        assert.equal(f.movements[0].invoiceId, id);
        assert.equal(f.movements[0].sourceId, f.payments[0].id);
        assert.equal(f.movements[0].idempotencyKey, 'receipt-test-1');
        assert.equal(f.payments[0].method, 'Bonifico');
        assert.equal(f.queries.some(query => query.sql.startsWith('SELECT "id"')), false);
        const lock = f.queries.find(query => query.sql.includes('pg_advisory'))!;
        const insertion = f.queries.find(query => query.sql.includes('INSERT INTO'))!;
        assert.equal(insertion.options.transaction, lock.options.transaction);
        assert.match(insertion.sql, /"paymentMethodId","idempotencyKey"/);
    });
    it('retries the same receipt after a lost response without duplicate collections, including simultaneous requests', async t => {
        const f = fixture(t);
        const results = await Promise.all([run(createPayment, f.req), run(createPayment, f.req)]);
        assert.deepEqual(results.map(result => result.status), [201, 200]);
        assert.equal(f.payments.length, 1);
        assert.equal(f.movements.length, 1);
        assert.equal(results[1].body.data.summary.balance, 40);
    });
    it('rejects a reused key with changed amount or note', async t => {
        const f = fixture(t);
        await run(createPayment, f.req);
        f.req.body.amount = 30;
        assert.equal((await run(createPayment, f.req)).status, 409);
        f.req.body.amount = 60;
        f.req.body.note = 'Modificata';
        assert.equal((await run(createPayment, f.req)).status, 409);
        assert.equal(f.payments.length, 1);
    });
    it('settles only the remaining amount after an initial partial receipt', async t => {
        const f = fixture(t);
        await run(createPayment, f.req);
        f.req.body.amount = 40;
        f.req.header = () => 'receipt-test-2';
        const response = await run(createPayment, f.req);
        assert.equal(response.status, 201);
        assert.equal(response.body.data.summary.balance, 0);
        assert.equal(f.invoice.status, 'paid');
        assert.equal(f.movements.length, 2);
        assert.equal((await run(createPayment, f.req)).status, 200);
        assert.equal(f.movements.length, 2);
    });
    it('rejects reuse of a key on a different invoice without another payment', async t => {
        const f = fixture(t);
        await run(createPayment, f.req);
        f.invoice.id = userId;
        f.req.params.invoiceId = userId;
        assert.equal((await run(createPayment, f.req)).status, 409);
        assert.equal(f.payments.length, 1);
    });
    it('rejects missing, void and credit-note invoices before creating movements', async t => {
        const f = fixture(t);
        f.req.params.invoiceId = userId;
        assert.equal((await run(createPayment, f.req)).status, 404);
        f.req.params.invoiceId = id;
        f.invoice.status = 'void';
        assert.equal((await run(createPayment, f.req)).status, 409);
        f.invoice.status = 'unpaid';
        f.invoice.documentType = 'nota_di_credito';
        assert.equal((await run(createPayment, f.req)).status, 409);
        assert.equal(f.payments.length, 0);
    });
    it('does not create either record for an overpayment', async t => {
        const f = fixture(t);
        f.req.body.amount = 101;
        assert.equal((await run(createPayment, f.req)).status, 409);
        assert.equal(f.payments.length, 0);
        assert.equal(f.movements.length, 0);
    });
    it('rolls back the payment when the movement insert fails', async t => {
        const f = fixture(t);
        f.failMovement();
        assert.equal((await run(createPayment, f.req)).status, 500);
        assert.equal(f.payments.length, 0);
        assert.equal(f.movements.length, 0);
        assert.equal(f.invoice.status, 'unpaid');
    });
    it('rejects an inactive account and a different-site account', async t => {
        const f = fixture(t);
        f.accounts[0].isActive = false;
        assert.equal((await run(createPayment, f.req)).status, 400);
        f.accounts[0].isActive = true;
        f.accounts[0].structureId = userId;
        assert.equal((await run(createPayment, f.req)).status, 400);
        assert.equal(f.payments.length, 0);
    });
    it('accepts a shared tenant account and a blank optional payment method as NULL', async t => {
        const f = fixture(t);
        f.accounts[0].structureId = null;
        f.req.body.paymentMethodId = '';
        assert.equal((await run(createPayment, f.req)).status, 201);
        assert.equal(f.movements[0].paymentMethodId, null);
    });
    it('uses the selected account site for a legacy invoice with tenant-wide access and no selected site', async t => {
        const f = fixture(t);
        f.invoice.structureId = null;
        f.req.access.structureId = null;
        const response = await run(createPayment, f.req);
        assert.equal(response.status, 201);
        assert.equal(f.movements[0].structureId, structureId);
        assert.equal(f.movements[0].accountId, accountId);
    });
    it('requires a site when both a legacy invoice and the selected shared account have none', async t => {
        const f = fixture(t);
        f.invoice.structureId = null;
        f.req.access.structureId = null;
        f.accounts[0].structureId = null;
        const response = await run(createPayment, f.req);
        assert.equal(response.status, 400);
        assert.match(response.body.message, /Seleziona una sede/);
        assert.equal(f.payments.length, 0);
    });
    it('rejects an account site outside the current tenant before creating the receipt', async t => {
        const f = fixture(t);
        f.invoice.structureId = null;
        f.req.access.structureId = null;
        f.accounts[0].structureId = userId;
        const response = await run(createPayment, f.req);
        assert.equal(response.status, 400);
        assert.match(response.body.message, /sede selezionata/);
        assert.equal(f.payments.length, 0);
    });
    it('does not infer an unselected site from the account for an own-scope user', async t => {
        const f = fixture(t);
        f.invoice.structureId = null;
        f.req.access.structureId = null;
        f.req.access.scope = 'own';
        assert.equal((await run(createPayment, f.req)).status, 400);
        assert.equal(f.payments.length, 0);
    });
    it('rejects invalid UUIDs and unavailable payment methods before saving', async t => {
        const f = fixture(t);
        f.req.body.paymentMethodId = 'not-a-uuid';
        assert.equal((await run(createPayment, f.req)).status, 400);
        f.req.body.paymentMethodId = userId;
        assert.equal((await run(createPayment, f.req)).status, 400);
        assert.equal(f.payments.length, 0);
    });
    it('preserves legacy invoice callers and their automatic treasury mirroring', async t => {
        const f = fixture(t);
        delete f.req.body.accountId;
        delete f.req.body.paymentMethodId;
        f.req.header = () => undefined;
        assert.equal((await run(createPayment, f.req)).status, 201);
        assert.equal(f.movements.length, 1);
        assert.equal(f.movements[0].accountId, accountId);
        assert.equal(f.movements[0].idempotencyKey, null);
    });
    it('keeps the patient restriction in actual SQL for structure and own permission scopes', async t => {
        const f = fixture(t);
        f.req.access.scope = 'structure';
        await run(createPayment, f.req);
        const sql = generator.selectQuery({ tableName: 'invoices', schema }, { where: f.invoiceWhere[0] });
        assert.match(sql, /SELECT "id" FROM "rehablo_[a-f0-9]+"."patients" WHERE "structureId"/);
        f.req.access.scope = 'own';
        await run(createPayment, f.req);
        const ownSql = generator.selectQuery({ tableName: 'invoices', schema }, { where: f.invoiceWhere[1] });
        assert.match(ownSql, /WHERE "userId" =/);
        assert.ok(f.invoiceWhere[0].patientID[Op.in]);
    });
});

describe('package coverage and retained patient credits', () => {
    it('settles a visit once without creating a second treasury receipt', async t => {
        const packageId = '77777777-7777-4777-8777-777777777777';
        const eventId = '88888888-8888-4888-8888-888888888888';
        const pack = record({ id: packageId, structureId, patientId: userId, status: 'ACTIVE', remainingUnits: 2, purchasedUnits: 2, totalPrice: 200, expiresAt: null });
        const event = record({ id: eventId, structureId, patientId: userId, status: 'CONFIRMED', invoiceId: null,
            recurrence: null, recurringEventId: null, appointmentExpectedAmount: null, appointmentPaymentStatus: 'unpaid', appointmentPaidAmount: 0 });
        event.get = function (key: string | object) {
            if (typeof key === 'string') return this[key];
            const { get, update, ...values } = this;
            return values;
        };
        const consumptions: any[] = [];
        const payments: any[] = [];
        const queries: string[] = [];
        t.mock.method(sequelize, 'transaction', (async (work: any) => work({ LOCK: { UPDATE: 'UPDATE' } })) as any);
        t.mock.method(sequelize, 'query', (async (sql: string) => { queries.push(sql); return [[], {}]; }) as any);
        t.mock.method(CarePackage, 'schema', (() => ({ findOne: async () => pack })) as any);
        t.mock.method(AgendaEvent, 'schema', (() => ({ findByPk: async () => event })) as any);
        t.mock.method(Tenant, 'findByPk', (async () => null) as any);
        t.mock.method(PackageConsumption, 'schema', (() => ({
            count: async () => consumptions.length,
            create: async (values: any) => { const row = record(values); consumptions.push(row); return row; }
        })) as any);
        t.mock.method(InvoicePayment, 'schema', (() => ({
            count: async () => payments.length,
            findAll: async () => payments,
            create: async (values: any, options: any) => {
                const row = ScopedPayment.build(values);
                payments.push(row);
                await (ScopedPayment as any).runHooks('afterCreate', row, options);
                return row;
            }
        })) as any);
        const req: any = { tenantSchema: schema, params: { id: packageId }, body: { units: 1, agendaEventId: eventId },
            access: { scope: 'tenant', structureId, userId } };
        const first = await run(administration.consumePackage, req);
        assert.equal(first.status, 201);
        assert.equal(pack.remainingUnits, 1);
        assert.equal(event.appointmentPaymentStatus, 'paid');
        assert.equal(event.appointmentExpectedAmount, 100);
        assert.equal(event.appointmentPaidAmount, 100);
        assert.equal(payments[0].source, 'PACKAGE');
        assert.equal(consumptions.length, 1);
        assert.equal(queries.length, 0);
        const duplicate = await run(administration.consumePackage, req);
        assert.equal(duplicate.status, 409);
        assert.equal(pack.remainingUnits, 1);
        assert.equal(consumptions.length, 1);
    });

    it('moves a real receipt to patient credit without refunding it', async t => {
        const f = fixture(t);
        f.invoice.structureId = null;
        assert.equal((await run(createPayment, f.req)).status, 201);
        const paid = f.payments[0];
        t.mock.method(paid, 'update', (async (changes: any, options: any) => {
            paid.set(changes);
            await (ScopedPayment as any).runHooks('afterUpdate', paid, options);
            return paid;
        }) as any);
        f.req.params.paymentId = paid.id;
        f.req.body = { reason: 'Acconto non allocato', convertToCredit: true };
        const result = await run(voidPayment, f.req);
        assert.equal(result.status, 200);
        assert.equal(result.body.data.creditCreated, true);
        assert.equal(f.credits.length, 1);
        assert.equal(f.credits[0].amount, 60);
        assert.equal(f.credits[0].structureId, structureId);
        assert.equal(f.credits[0].sourceId, paid.id);
        assert.equal(f.movements.length, 1);
        assert.equal(paid.status, 'CREDIT');
        assert.equal(f.invoice.status, 'unpaid');
    });

    it('still reverses treasury cash for an ordinary payment void', async t => {
        const f = fixture(t);
        assert.equal((await run(createPayment, f.req)).status, 201);
        const paid = f.payments[0];
        t.mock.method(paid, 'update', (async (changes: any, options: any) => {
            paid.set(changes);
            await (ScopedPayment as any).runHooks('afterUpdate', paid, options);
            return paid;
        }) as any);
        f.req.params.paymentId = paid.id;
        f.req.body = { reason: 'Rimborso al paziente', convertToCredit: false };
        const result = await run(voidPayment, f.req);
        assert.equal(result.status, 200);
        assert.equal(paid.status, 'VOID');
        assert.equal(f.movements.length, 2);
        assert.equal(f.movements[1].direction, 'OUT');
        assert.equal(f.credits.length, 0);
    });

    it('refuses to create a credit without a retained receipt', async t => {
        const f = fixture(t);
        assert.equal((await run(createPayment, f.req)).status, 201);
        f.movements.length = 0;
        f.req.params.paymentId = f.payments[0].id;
        f.req.body = { reason: 'Acconto non allocato', convertToCredit: true };
        const result = await run(voidPayment, f.req);
        assert.equal(result.status, 409);
        assert.equal(f.payments[0].status, 'POSTED');
        assert.equal(f.credits.length, 0);
    });
});

describe('manual treasury controller validation', () => {
    function manual(t: TestContext) {
        const f = fixture(t);
        f.req.body = { accountId, structureId, amount: 25, direction: 'IN', occurredAt: '2025-01-15T12:00:00.000Z', paymentMethodId: '', description: 'Versamento' };
        f.req.access.resource = 'treasury';
        return f;
    }
    it('normalizes optional empty UUIDs and produces SQL NULL instead of an invalid UUID', async t => {
        const f = manual(t);
        assert.equal((await run(administration.create('treasuryMovements'), f.req)).status, 201);
        assert.equal(f.movements[0].paymentMethodId, null);
        const insertion = generator.insertQuery({ tableName: 'treasury_movements', schema }, { paymentMethodId: f.movements[0].paymentMethodId }, TreasuryMovement.getAttributes(), {});
        assert.deepEqual(insertion.bind, [null]);
        assert.doesNotMatch(insertion.query, /''/);
    });
    for (const [field, value] of [['amount', 0], ['direction', 'TRANSFER'], ['occurredAt', '2025-02-30T12:00:00.000Z'], ['accountId', ''], ['paymentMethodId', 'invalid']]) {
        it('rejects invalid ' + field + ' before insert', async t => {
            const f = manual(t);
            f.req.body[field] = value;
            assert.equal((await run(administration.create('treasuryMovements'), f.req)).status, 400);
            assert.equal(f.movements.length, 0);
        });
    }
    it('prevents manually linked invoice movements that would leave the invoice balance unchanged', async t => {
        const f = manual(t);
        f.req.body.invoiceId = id;
        assert.equal((await run(administration.create('treasuryMovements'), f.req)).status, 400);
        assert.equal(f.movements.length, 0);
    });
});
