import assert from 'node:assert/strict';
import { describe, it, TestContext } from 'node:test';
import { Request, Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { Structure } from '../../auth/models/index.js';
import { Invoice, InvoicePayment } from '../../invoice/models/index.js';
import { AgendaEvent } from '../../agenda/models/agendaEvent.model.js';
import Patient from '../../patients/models/patient.model.js';
import { Expense, FinancialAccount, PaymentMethod, PurchaseDocument, Reconciliation, Supplier, TreasuryMovement } from '../models/index.js';
import { listTreasuryMovements, getTreasuryExpense } from './treasuryView.controller.js';

const uuid = (n: number) => '11111111-1111-4111-8111-' + String(n).padStart(12, '0');
const tenantId = uuid(1), structureId = uuid(2), otherStructure = uuid(3), accountId = uuid(4), methodId = uuid(5);
const invoiceId = uuid(6), patientId = uuid(7), expenseId = uuid(8), supplierId = uuid(9), purchaseId = uuid(10), userId = uuid(11);
const schema = 'rehablo_' + tenantId.replaceAll('-', '');
const generator = (sequelize.getQueryInterface() as any).queryGenerator;
function record(data: any): any { return { get: (key: string | object) => typeof key === 'string' ? data[key] : { ...data } }; }
function matches(data: any, where: any): boolean {
    return Reflect.ownKeys(where ?? {}).every(key => {
        const value = where[key];
        if (key === Op.and) return Array.isArray(value) ? value.every(term => matches(data, term)) : !value?.val?.includes('1=0');
        if (key === Op.or) return value.some((term: any) => matches(data, term));
        if (typeof key !== 'string') return true;
        if (value && typeof value === 'object') {
            return Reflect.ownKeys(value).every(op => {
                const expected = value[op];
                if (op === Op.in) return Array.isArray(expected) ? expected.includes(data[key]) : true;
                if (op === Op.ne) return data[key] != expected;
                if (op === Op.gte) return new Date(data[key]).getTime() >= new Date(expected).getTime();
                if (op === Op.lte) return new Date(data[key]).getTime() <= new Date(expected).getTime();
                return true;
            });
        }
        return value === null ? data[key] == null : data[key] === value;
    });
}
function run(req: any, handler = listTreasuryMovements): Promise<{ status: number; body: any }> {
    return new Promise(resolve => {
        const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; },
            json(body: unknown) { resolve({ status: this.statusCode, body }); return this; } };
        handler(req, res, (error?: any) => resolve({ status: error?.statusCode ?? 500, body: { message: error?.message } }));
    });
}
function fixture(t: TestContext) {
    const queries: Record<string, any[]> = {};
    const movements: any[] = [{ id: uuid(100), accountId, structureId, paymentMethodId: methodId,
        direction: 'IN', category: 'INVOICE_PAYMENT', amount: '60.50', status: 'POSTED',
        occurredAt: '2026-09-20T10:00:00Z', invoiceId, expenseId: null, sourceType: 'INVOICE_PAYMENT',
        description: 'Incasso fattura ' + invoiceId, counterparty: null }];
    const invoices: any[] = [{ id: invoiceId, documentNumber: 12, documentYear: 2026, documentType: 'fattura', patientID: patientId, structureId }];
    const expenses: any[] = [{ id: expenseId, description: 'Materiale studio', supplierId, purchaseDocumentId: purchaseId, structureId }];
    const reconciliations: any[] = [];
    const payments: any[] = [], appointments: any[] = [];
    const structures: any[] = [{ id: structureId, name: 'Sede centro', tenantId }, { id: otherStructure, name: 'Altra sede', tenantId }];
    function stub(model: any, name: string, rows: any[]) {
        queries[name] = [];
        t.mock.method(model, 'schema', (() => ({ findAll: async (options: any) => {
            queries[name].push(options); return rows.filter(row => matches(row, options.where)).map(record);
        } })) as any);
    }
    stub(TreasuryMovement, 'movements', movements);
    stub(Invoice, 'invoices', invoices);
    stub(InvoicePayment, 'payments', payments);
    stub(AgendaEvent, 'appointments', appointments);
    stub(Expense, 'expenses', expenses);
    stub(Patient, 'patients', [{ id: patientId, name: 'Mario', surname: 'Rossi' }]);
    stub(Supplier, 'suppliers', [{ id: supplierId, businessName: 'Sanitaria Roma' }]);
    stub(PurchaseDocument, 'purchases', [{ id: purchaseId, number: 'FOR-32/2026', documentDate: '2026-09-01', structureId }]);
    stub(FinancialAccount, 'accounts', [{ id: accountId, name: 'Banca studio' }]);
    stub(PaymentMethod, 'methods', [{ id: methodId, label: 'Bonifico' }]);
    stub(Reconciliation, 'reconciliations', reconciliations);
    t.mock.method(Structure, 'findAll', (async (options: any) => structures.filter(row => matches(row, options.where)).map(record)) as any);
    t.mock.method(Structure, 'count', (async (options: any) => structures.filter(row => matches(row, options.where)).length) as any);
    const req: any = { tenantSchema: schema, user: { tid: tenantId, sub: userId, sid: structureId,
        perms: ['treasury:read:tenant', 'invoice:read:tenant', 'expense:read:tenant'] },
        access: { resource: 'treasury', action: 'read', scope: 'tenant', userId, structureId }, query: {} };
    return { req, movements, invoices, expenses, reconciliations, queries, payments, appointments };
}
describe('treasury readable list and filters', () => {
    it('returns invoice number, patient, method, account and structure without UUID in text', async t => {
        const f = fixture(t);
        const result = await run(f.req);
        assert.equal(result.status, 200);
        const row = result.body.data.items[0];
        assert.equal(row.documentLabel, 'Fattura 12/2026');
        assert.equal(row.documentId, invoiceId);
        assert.equal(row.documentType, 'INVOICE');
        assert.equal(row.documentAccessible, true);
        assert.equal(row.hasDocument, true);
        assert.equal(row.counterparty, 'Mario Rossi');
        assert.equal(row.description, 'Incasso · Fattura 12/2026');
        assert.equal(row.accountName, 'Banca studio');
        assert.equal(row.paymentMethodName, 'Bonifico');
        assert.equal(row.structureName, 'Sede centro');
        assert.equal(row.reconciled, false);
    });
    it('distinguishes credit notes and includes expense document and supplier references', async t => {
        const f = fixture(t);
        f.invoices[0].documentType = 'nota_di_credito';
        f.movements.push({ ...f.movements[0], id: uuid(101), invoiceId: null, expenseId, category: 'SUPPLIER_PAYMENT',
            direction: 'OUT', sourceType: null, description: null });
        const rows = (await run(f.req)).body.data.items;
        assert.equal(rows[0].documentLabel, 'Nota di credito 12/2026');
        assert.equal(rows[1].documentLabel, 'Spesa · documento FOR-32/2026');
        assert.equal(rows[1].counterparty, 'Sanitaria Roma');
        assert.equal(rows[1].documentType, 'EXPENSE');
    });
    it('uses a truthful generic label and no link for a deleted source document', async t => {
        const f = fixture(t);
        f.invoices.length = 0;
        const row = (await run(f.req)).body.data.items[0];
        assert.equal(row.hasDocument, true);
        assert.equal(row.documentLabel, 'Documento non disponibile');
        assert.equal(row.documentId, null);
        assert.equal(row.documentAccessible, false);
        assert.equal(row.counterparty, null);
        assert.equal(row.description, 'Incasso fattura');
    });
    it('does not fetch source documents or patient/supplier data without their read permission', async t => {
        const f = fixture(t);
        f.req.user.perms = ['treasury:read:tenant'];
        const row = (await run(f.req)).body.data.items[0];
        assert.equal(row.documentAccessible, false);
        assert.equal(row.counterparty, null);
        assert.equal(f.queries.invoices.length, 0);
        assert.equal(f.queries.patients.length, 0);
        assert.equal(f.queries.suppliers.length, 0);
    });
    it('intersects independent invoice scope with the visible movement structure', async t => {
        const f = fixture(t);
        f.req.user.perms = ['treasury:read:tenant', 'invoice:read:structure'];
        f.invoices[0].structureId = otherStructure;
        const row = (await run(f.req)).body.data.items[0];
        assert.equal(row.documentAccessible, false);
        const sql = generator.selectQuery(Invoice.schema(schema).getTableName?.() ?? 'invoices',
            { where: f.queries.invoices[0].where });
        assert.match(sql, /SELECT "id" FROM.*patients.*structureId/);
        assert.ok(sql.includes(structureId));
    });
    it('preserves own invoice scope even when treasury is tenant-wide', async t => {
        const f = fixture(t);
        f.req.user.perms = ['treasury:read:tenant', 'invoice:read:own'];
        await run(f.req);
        const sql = generator.selectQuery('invoices', { where: f.queries.invoices[0].where });
        assert.ok(sql.includes('"userId" = '));
        assert.ok(sql.includes(userId));
    });
    it('never queries the UUID sentinel when there is no selected structure', async t => {
        const f = fixture(t);
        f.req.access.scope = 'structure';
        f.req.access.structureId = null;
        const result = await run(f.req);
        assert.equal(result.status, 200);
        assert.equal(result.body.data.total, 0);
        const sql = generator.selectQuery('treasury_movements', { where: f.queries.movements[0].where });
        assert.match(sql, /1=0/);
        assert.ok(!sql.includes('__none__'));
    });
    it('uses the token structure and ignores an attempted wider structure filter', async t => {
        const f = fixture(t);
        f.req.access.scope = 'structure';
        f.req.query.structureId = otherStructure;
        f.movements.push({ ...f.movements[0], id: uuid(101), structureId: otherStructure });
        const response = await run(f.req);
        assert.equal(response.body.data.total, 1);
        assert.equal(f.queries.movements[0].where.structureId, structureId);
    });
    it('searches readable document numbers, patient names and Italian category labels', async t => {
        const f = fixture(t);
        for (const query of ['12/2026', 'ROSSI', 'incasso fattura', 'Banca studio', 'Bonifico', 'Sede centro']) {
            f.req.query.query = query;
            assert.equal((await run(f.req)).body.data.total, 1, query);
        }
        f.req.query.query = 'non presente';
        assert.equal((await run(f.req)).body.data.total, 0);
    });
    it('filters direction, state, category, payment method, account and linked state before pagination', async t => {
        const f = fixture(t);
        f.movements.push({ ...f.movements[0], id: uuid(101), direction: 'OUT', category: 'OTHER', paymentMethodId: null, invoiceId: null });
        Object.assign(f.req.query, { direction: 'IN', status: 'POSTED', category: 'INVOICE_PAYMENT', accountId, paymentMethodId: methodId, linkState: 'linked' });
        assert.equal((await run(f.req)).body.data.total, 1);
        for (const [field, value] of Object.entries({ direction: 'IN', status: 'POSTED', category: 'INVOICE_PAYMENT', accountId, paymentMethodId: methodId })) {
            assert.equal((await run(f.req)).body.data.items[0][field], value);
        }
        f.req.query = { linkState: 'unlinked' };
        const unlinked = (await run(f.req)).body.data;
        assert.equal(unlinked.total, 1);
        assert.equal(unlinked.items[0].id, uuid(101));
        assert.equal(unlinked.summary.unlinkedCount, 1);
    });
    it('includes the entire local calendar day using Europe/Rome boundaries', async t => {
        const f = fixture(t);
        f.movements[0].occurredAt = '2026-09-19T22:00:00.000Z';
        f.movements.push({ ...f.movements[0], id: uuid(101), occurredAt: '2026-09-20T21:59:59.999Z' },
            { ...f.movements[0], id: uuid(102), occurredAt: '2026-09-20T22:00:00.000Z' });
        f.req.query = { from: '2026-09-20', to: '2026-09-20' };
        assert.equal((await run(f.req)).body.data.total, 2);
    });
    it('returns totals for all matching rows beyond page 100 and excludes void amounts', async t => {
        const f = fixture(t);
        const base = { ...f.movements[0] };
        f.movements.splice(0, 1, ...Array.from({ length: 230 }, (_, i) => ({ ...base, id: uuid(100 + i), amount: '1.01' })));
        f.movements.push({ ...base, id: uuid(500), direction: 'OUT', amount: 2 },
            { ...base, id: uuid(501), status: 'VOID', amount: 999 });
        f.req.query = { limit: '100', offset: '100' };
        const result = (await run(f.req)).body.data;
        assert.equal(result.items.length, 100);
        assert.equal(result.total, 232);
        assert.deepEqual(result.summary, { income: 232.3, outcome: 2, net: 230.3, postedCount: 231, unlinkedCount: 0 });
        assert.deepEqual(f.queries.movements[0].order, [['occurredAt', 'DESC'], ['id', 'DESC']]);
        f.req.query.limit = '999';
        assert.equal((await run(f.req)).body.data.limit, 200);
    });
    it('marks reconciliation only after a closed or completed bank reconciliation', async t => {
        const f = fixture(t);
        f.reconciliations.push({ accountId, status: 'OPEN', matchedMovementIds: [uuid(100)] });
        assert.equal((await run(f.req)).body.data.items[0].reconciled, false);
        f.reconciliations[0].status = 'COMPLETED';
        assert.equal((await run(f.req)).body.data.items[0].reconciled, true);
    });
    it('rejects malformed filters as 400 before any movement query', async t => {
        const f = fixture(t);
        for (const query of [
            { accountId: '__none__' }, { paymentMethodId: 'x' }, { structureId: 'abc' },
            { direction: 'income' }, { status: 'PENDING' }, { linkState: 'yes' },
            { from: '2026-02-30' }, { from: '2026-09-02', to: '2026-09-01' },
            { to: { bad: 'input' } }, { category: ['one', 'two'] }, { limit: '-1' }, { offset: '1.5' }
        ]) {
            f.req.query = query;
            assert.equal((await run(f.req)).status, 400, JSON.stringify(query));
        }
        assert.equal(f.queries.movements.length, 0);
    });
    it('rejects a requested structure outside the current tenant', async t => {
        const f = fixture(t);
        f.req.query.structureId = uuid(999);
        assert.equal((await run(f.req)).status, 400);
        assert.equal(f.queries.movements.length, 0);
    });
});

describe('treasury balance effects and appointment receipts', () => {
    it('includes legacy VOID originals with a valid posted reversal before period and status filters', async t => {
        const f = fixture(t);
        const original = f.movements[0];
        original.status = 'VOID';
        original.amount = 80;
        original.occurredAt = '2026-09-01T10:00:00Z';
        const reversal = { ...original, id: uuid(120), status: 'POSTED', direction: 'OUT',
            category: 'REVERSAL', reversalOfId: original.id, occurredAt: '2026-10-01T10:00:00Z' };
        f.movements.push(reversal);
        let result = (await run(f.req)).body.data;
        assert.equal(result.summary.income, 80);
        assert.equal(result.summary.outcome, 80);
        assert.equal(result.summary.net, 0);
        assert.equal(result.items[0].affectsBalance, true);
        f.req.query = { from: '2026-09-01', to: '2026-09-30' };
        result = (await run(f.req)).body.data;
        assert.equal(result.total, 1);
        assert.equal(result.summary.income, 80);
        assert.equal(result.summary.net, 80);
        f.req.query = { status: 'POSTED' };
        result = (await run(f.req)).body.data;
        assert.equal(result.total, 1);
        assert.equal(result.summary.income, 0);
        assert.equal(result.summary.outcome, 80);
    });
    it('marks a void record without a valid reversal as not affecting the balance', async t => {
        const f = fixture(t);
        f.movements[0].status = 'VOID';
        const result = (await run(f.req)).body.data;
        assert.equal(result.items[0].affectsBalance, false);
        assert.equal(result.summary.income, 0);
        assert.equal(result.summary.net, 0);
    });
    it('resolves a pre-invoice receipt to a readable session and patient without inventing a document', async t => {
        const f = fixture(t);
        f.req.user.perms.push('agenda:read:tenant', 'patient:read:tenant');
        f.movements[0].invoiceId = null;
        f.movements[0].sourceId = uuid(200);
        f.movements[0].description = null;
        f.payments.push({ id: uuid(200), agendaEventId: uuid(201) });
        f.appointments.push({ id: uuid(201), start: '2026-09-20T09:00:00Z', patientId, structureId });
        const row = (await run(f.req)).body.data.items[0];
        assert.equal(row.description, 'Incasso seduta del 20/09/2026');
        assert.equal(row.categoryLabel, 'Incasso seduta');
        assert.equal(row.counterparty, 'Mario Rossi');
        assert.equal(row.hasDocument, false);
        assert.equal(row.documentType, null);
        assert.equal(row.documentLabel, null);
    });
    it('does not expose appointment data without agenda permission or for another structure', async t => {
        const f = fixture(t);
        f.movements[0].invoiceId = null;
        f.movements[0].sourceId = uuid(200);
        f.payments.push({ id: uuid(200), agendaEventId: uuid(201) });
        f.appointments.push({ id: uuid(201), start: '2026-09-20T09:00:00Z', patientId, structureId: otherStructure });
        assert.equal((await run(f.req)).body.data.items[0].counterparty, null);
        assert.equal(f.queries.appointments.length, 0);
        f.req.user.perms.push('agenda:read:structure', 'patient:read:tenant');
        assert.equal((await run(f.req)).body.data.items[0].counterparty, null);
        assert.ok(!JSON.stringify((await run(f.req)).body.data).includes('20/09/2026'));
    });
});
describe('direct treasury expense reference', () => {
    it('loads a linked expense independently of a list with more than one hundred items', async t => {
        const f = fixture(t);
        f.expenses.unshift(...Array.from({ length: 120 }, (_, i) => ({ id: uuid(300 + i), structureId, description: 'Altra spesa' })));
        f.expenses[120].paymentMethodId = methodId;
        f.req.access.resource = 'expense';
        f.req.params = { id: expenseId };
        const result = await run(f.req, getTreasuryExpense);
        assert.equal(result.status, 200);
        assert.equal(result.body.data.id, expenseId);
        assert.equal(result.body.data.supplierName, 'Sanitaria Roma');
        assert.equal(result.body.data.paymentMethodName, 'Bonifico');
    });
    it('returns 404 for an expense outside the selected structure and 400 for an invalid id', async t => {
        const f = fixture(t);
        f.req.access = { ...f.req.access, resource: 'expense', scope: 'structure' };
        f.req.params = { id: expenseId };
        f.expenses[0].structureId = otherStructure;
        assert.equal((await run(f.req, getTreasuryExpense)).status, 404);
        f.req.params.id = '__none__';
        assert.equal((await run(f.req, getTreasuryExpense)).status, 400);
    });
});
