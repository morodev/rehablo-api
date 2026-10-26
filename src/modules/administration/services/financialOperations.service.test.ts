import assert from 'node:assert/strict';
import {it, TestContext} from 'node:test';
import {Request} from 'express';
import {Op} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {Structure, Tenant} from '../../auth/models/index.js';
import {DailyClosing, Expense, FinancialAccount, PatientCredit, PaymentMethod, Reconciliation, TreasuryMovement} from '../models/index.js';
import {PatientCreditMovement} from '../models/patientCreditMovement.model.js';
import {FinancialOperation} from '../models/financialOperation.model.js';
import {expensePaymentPosition, protectAccountChange, protectExpenseChange, recordExpensePayment, recordManualMovement,
    recordTransfer, voidExpensePayment, voidManualMovement, voidTransfer} from './financialOperations.service.js';
import {voidPatientAdvance, voidPatientRefund} from './financialCreditReversal.service.js';
import {balanceEffectiveMovements, treasuryBalance} from './treasuryLedger.service.js';
import {administrationFinancialProjection, treasuryProjection} from '../../reports/services/financialReporting.service.js';
import administration from '../controllers/administration.controller.js';
import Patient from '../../patients/models/patient.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import {recordPatientAdvance, recordPatientRefund} from './patientCashOperations.service.js';
import {creditCorrectionCapabilities, refundCorrectionCapabilities} from './financialCreditReversal.service.js';

const ids = Array.from({length: 12}, (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, '0')}`);
const [site, account1, account2, expenseId, actor, patient, creditId, refundId, receiptId, methodId] = ids;
const day = '2026-01-10';
type Row = Record<string, any>;
function request(body: Row = {}, key = 'operation-test-001', params: Row = {id: expenseId}): Request {
    return {tenantSchema: 'rehablo_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', body, params,
        user: {sub: actor, sid: site, tid: actor, isSuperAdmin: true}, access: {scope: 'tenant', userId: actor, structureId: site},
        header: (name: string) => name === 'Idempotency-Key' ? key : undefined} as any;
}
function matches(value: Row, where: any): boolean {
    if (!where) return true;
    return Reflect.ownKeys(where).every(key => {
        const expected = where[key];
        if (key === Op.and) return expected.every((part: any) => matches(value, part));
        if (key === Op.or) return expected.some((part: any) => matches(value, part));
        if (expected && typeof expected === 'object') {
            if (Op.in in expected) return expected[Op.in].includes(value[key as string]);
            if (Op.ne in expected) return expected[Op.ne] !== value[key as string];
        }
        return value[key as string] === expected;
    });
}
function fixture(t: TestContext) {
    const accounts: Row[] = [account1, account2].map((id, i) => ({id, structureId: site, isActive: true, currency: 'EUR', type: i ? 'BANK' : 'CASH', openingBalance: 0, name: 'Conto ' + i}));
    const expenses: Row[] = [{id: expenseId, structureId: site, amount: 100, status: 'OPEN', createdByUserId: actor, description: 'Affitto'}];
    const treasury: Row[] = [], credits: Row[] = [], movements: Row[] = [], operations: Row[] = [], closings: Row[] = [], reconciliations: Row[] = [], payments: Row[] = [];
    const tables = [accounts, expenses, treasury, credits, movements, operations, closings, reconciliations, payments];
    const locks = new Map<string, Promise<void>>();
    const acquire = async (tx: any, key: string) => {
        if (tx.held.has(key)) return;
        const old = locks.get(key) ?? Promise.resolve();
        let release!: () => void;
        const pending = new Promise<void>(resolve => {release = resolve;});
        locks.set(key, old.then(() => pending)); await old;
        tx.held.add(key); tx.releases.push(release);
    };
    const state = {failTreasuryCreate: 0, treasuryCreates: 0};
    function model(values: Row): any {
        return {get: (key: any) => typeof key === 'string' ? values[key] : {...values},
            update: async (changes: Row, options: any) => {assert.ok(options?.transaction); Object.assign(values, changes); return model(values);},
            destroy: async (options: any) => {assert.ok(options?.transaction); const table = tables.find(rows => rows.includes(values))!; table.splice(table.indexOf(values), 1);}};
    }
    function repository(rows: Row[], kind = ''): any {
        return {findAll: async (options: any = {}) => rows.filter(row => matches(row, options.where)).map(model),
            findOne: async (options: any = {}) => {
                if (options.lock) await acquire(options.transaction, kind + ':' + (options.where?.id ?? JSON.stringify(options.where)));
                const found = rows.find(row => matches(row, options.where)); return found ? model(found) : null;
            }, findByPk: async (id: string, options: any = {}) => {
                if (options.lock) await acquire(options.transaction, kind + ':' + id);
                const found = rows.find(row => row.id === id); return found ? model(found) : null;
            }, count: async (options: any = {}) => rows.filter(row => matches(row, options.where)).length,
            create: async (values: Row, options: any) => {
                assert.ok(options?.transaction);
                if (kind === 'credit-ledger') {
                    for (const field of ['creditId', 'type', 'amount', 'idempotencyKey', 'createdByUserId']) assert.notEqual(values[field], undefined, 'required credit ledger field ' + field);
                }
                if (kind === 'treasury' && ++state.treasuryCreates === state.failTreasuryCreate) throw new Error('injected ledger failure');
                const created = {id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(rows.length + 1).padStart(12, '0')}`, ...values}; rows.push(created); return model(created);
            }};
    }
    for (const [entity, rows, kind] of [[Expense, expenses, 'expense'], [FinancialAccount, accounts, 'account'],
        [TreasuryMovement, treasury, 'treasury'], [PatientCredit, credits, 'credit'], [PatientCreditMovement, movements, 'credit-ledger'],
        [FinancialOperation, operations, 'operation'], [DailyClosing, closings, 'closing'], [Reconciliation, reconciliations, 'reconciliation'],
        [InvoicePayment, payments, 'payment']] as const) {
        t.mock.method(entity, 'schema', (() => repository(rows, kind)) as any);
    }
    t.mock.method(PaymentMethod, 'schema', (() => repository([{id: methodId, isActive: true, label: 'Contanti'}])) as any);
    t.mock.method(Tenant, 'findByPk', (async () => model({administrationSettings: {}})) as any);
    t.mock.method(Structure, 'findOne', (async () => model({id: site})) as any);
    t.mock.method(Patient, 'schema', (() => ({findByPk: async () => model({id: patient, structureId: site, userId: actor, name: 'Mario', surname: 'Rossi'})})) as any);
    t.mock.method(sequelize, 'query', (async (_sql: string, options: any) => {await acquire(options.transaction, options.replacements.lockKey); return [[], {}];}) as any);
    t.mock.method(sequelize, 'transaction', (async (work: any) => {
        const snapshots = tables.map(rows => structuredClone(rows));
        const tx = {LOCK: {UPDATE: 'UPDATE'}, held: new Set<string>(), releases: [] as Array<() => void>};
        try {return await work(tx);} catch (error) {tables.forEach((rows, i) => rows.splice(0, rows.length, ...snapshots[i])); throw error;}
        finally {tx.releases.forEach(release => release());}
    }) as any);
    return {accounts, expenses, treasury, credits, movements, operations, closings, payments, state};
}
const payment = (amount: number, accountId: string | undefined = account1) => ({amount, paidAt: day, ...(accountId ? {accountId} : {})});

it('records partial/full expense payments once and reverses one payment without losing the other', async t => {
    const f = fixture(t);
    const partial = await recordExpensePayment(request(payment(30)));
    assert.equal(partial.paidAmount, 30); assert.equal(partial.balance, 70); assert.equal(partial.paymentState, 'PARTIAL');
    assert.equal(f.expenses[0].status, 'PARTIAL'); assert.equal(f.treasury[0].direction, 'OUT');
    assert.deepEqual(await recordExpensePayment(request(payment(30))), partial);
    const full = await recordExpensePayment(request(payment(70), 'operation-test-002'));
    assert.equal(full.balance, 0); assert.equal(f.expenses[0].status, 'PAID'); assert.equal(f.treasury.length, 2);
    const reverseReq = request({reason: 'Importo errato', occurredAt: '2026-01-11'}, 'operation-void-001', {id: expenseId, paymentId: f.treasury[0].id});
    const reversed = await voidExpensePayment(reverseReq);
    assert.equal(reversed.paidAmount, 70); assert.equal(reversed.balance, 30); assert.equal(reversed.paymentState, 'PARTIAL');
    assert.equal(f.treasury[0].status, 'VOID'); assert.equal(f.treasury[2].reversalOfId, f.treasury[0].id);
    assert.equal(treasuryBalance(balanceEffectiveMovements(f.treasury)), -70);
    assert.deepEqual(await voidExpensePayment(reverseReq), reversed); assert.equal(f.treasury.length, 3);
});

it('refuses an expense overpayment, a changed replay and a future date without any cash/state mutation', async t => {
    const f = fixture(t);
    await assert.rejects(recordExpensePayment(request(payment(101))), {statusCode: 409});
    await recordExpensePayment(request(payment(30)));
    await assert.rejects(recordExpensePayment(request(payment(31))), {statusCode: 409});
    await assert.rejects(recordExpensePayment(request({...payment(20), paidAt: '2999-01-01'}, 'another-key')), {statusCode: 422});
    assert.equal(f.treasury.length, 1); assert.equal(f.operations.length, 1); assert.equal(f.expenses[0].status, 'PARTIAL');
});

it('does not infer a second expense cash payment from an old PAID flag or an unclassified movement', async t => {
    const f = fixture(t); f.expenses[0].status = 'PAID';
    assert.equal(expensePaymentPosition(f.expenses[0], []).balance, null);
    await assert.rejects(recordExpensePayment(request(payment(100))), {statusCode: 409});
    f.expenses[0].status = 'OPEN'; f.treasury.push({expenseId, sourceType: null, amount: 100, direction: 'OUT', status: 'POSTED'});
    await assert.rejects(recordExpensePayment(request(payment(100))), {statusCode: 409});
    assert.equal(f.treasury.length, 1); assert.equal(f.operations.length, 0);
});

it('rolls back the expense payment when final idempotency persistence fails', async t => {
    const f = fixture(t);
    t.mock.method(FinancialOperation, 'schema', (() => ({findOne: async () => null, create: async () => {throw new Error('operation storage failed');}})) as any);
    await assert.rejects(recordExpensePayment(request(payment(30))), /operation storage failed/);
    assert.equal(f.expenses[0].status, 'OPEN'); assert.equal(f.treasury.length, 0);
});

it('enforces source and treasury permissions before replaying an expense payment', async t => {
    const f = fixture(t); await recordExpensePayment(request(payment(30)));
    const denied = request(payment(30)); denied.user = {sub: actor, sid: site, permissions: ['expense:update:structure']} as any;
    await assert.rejects(recordExpensePayment(denied), {statusCode: 403}); assert.equal(f.treasury.length, 1);
});

it('creates both transfer legs atomically and excludes them from economic totals while preserving account balances', async t => {
    const f = fixture(t);
    const result = await recordTransfer(request({fromAccountId: account1, toAccountId: account2, amount: 40, occurredAt: day}));
    assert.equal(f.treasury.length, 2); assert.equal(result.outMovementId, f.treasury[0].id);
    assert.equal(treasuryBalance(f.treasury.filter(row => row.accountId === account1)), -40);
    assert.equal(treasuryBalance(f.treasury.filter(row => row.accountId === account2)), 40);
    const report = treasuryProjection(f.treasury, [], day, day, {accountId: account2});
    assert.equal(report.income, 0); assert.equal(report.outcome, 0); assert.equal(report.rows.length, 1);
    const admin = administrationFinancialProjection([], f.treasury, [], [{id: site}], day, day);
    assert.equal(admin.income, 0); assert.equal(admin.series[0].income, 0); assert.equal(admin.structures[0].income, 0);
    await voidTransfer(request({reason: 'Giroconto errato', occurredAt: '2026-01-11'}, 'transfer-void-001', {id: result.id}));
    assert.equal(f.treasury.length, 4); assert.equal(treasuryBalance(balanceEffectiveMovements(f.treasury)), 0);
    for (const id of [account1, account2]) assert.equal(treasuryBalance(balanceEffectiveMovements(f.treasury).filter(row => row.accountId === id)), 0);
    assert.equal(treasuryProjection(f.treasury, [], day, '2026-01-11').outcome, 0);
});

it('rolls back the first transfer leg when the second fails and rejects same account/currency mismatch', async t => {
    const f = fixture(t); f.state.failTreasuryCreate = 2;
    const body = {fromAccountId: account1, toAccountId: account2, amount: 40, occurredAt: day};
    await assert.rejects(recordTransfer(request(body)), /injected ledger failure/);
    assert.equal(f.treasury.length, 0); assert.equal(f.operations.length, 0);
    await assert.rejects(recordTransfer(request({...body, toAccountId: account1})), {statusCode: 422});
    f.accounts[1].currency = 'USD'; await assert.rejects(recordTransfer(request(body)), {statusCode: 422});
});

it('serializes duplicate manual submissions and rejects a changed fingerprint', async t => {
    const f = fixture(t);
    const body = {structureId: site, accountId: account1, direction: 'IN', category: 'OTHER', amount: 25, occurredAt: day, description: 'Versamento'};
    const [first, second] = await Promise.all([recordManualMovement(request(body), body), recordManualMovement(request(body), body)]);
    assert.equal(first.id, second.id); assert.equal(f.treasury.length, 1); assert.equal(f.operations.length, 1);
    await assert.rejects(recordManualMovement(request({...body, amount: 26}), {...body, amount: 26}), {statusCode: 409});
    const reversed = await voidManualMovement(request({reason: 'Registrazione errata', occurredAt: day}, 'manual-void-001', {id: first.id}), {reason: 'Registrazione errata', occurredAt: day});
    assert.equal(reversed.reversalOfId, first.id); assert.equal(treasuryBalance(balanceEffectiveMovements(f.treasury)), 0);
});

it('preserves the supplied manual date and rejects impossible ISO days instead of normalizing them', async t => {
    const f = fixture(t);
    const body = {structureId: site, accountId: account1, direction: 'IN', amount: 25, occurredAt: '2025-02-30T12:00:00.000Z'};
    await assert.rejects(recordManualMovement(request(body), body), {statusCode: 422});
    body.occurredAt = '2025-02-28T16:30:00.000Z';
    await recordManualMovement(request(body), body);
    assert.equal(new Date(f.treasury[0].occurredAt).toISOString(), body.occurredAt);
});

it('cannot bypass expense payments through a manual movement or change cached status without the ledger', async t => {
    const f = fixture(t);
    await assert.rejects(recordManualMovement(request(), {expenseId, amount: 1}), {statusCode: 422});
    await assert.rejects(protectExpenseChange(request(), expenseId, {status: 'PAID'}), {statusCode: 409});
    await recordExpensePayment(request(payment(30)));
    await assert.rejects(protectExpenseChange(request(), expenseId, {amount: 200}), {statusCode: 409});
    await assert.rejects(protectExpenseChange(request(), expenseId, null), {statusCode: 409});
    await assert.rejects(protectExpenseChange(request(), expenseId, {status: 'OPEN'}), {statusCode: 409});
    assert.equal(f.expenses[0].status, 'PARTIAL');
});

it('protects used accounts from deletion and balance/currency/site changes while allowing deactivation', async t => {
    const f = fixture(t); f.closings.push({accountId: account1});
    await assert.rejects(protectAccountChange(request(), account1, null), {statusCode: 409});
    for (const changes of [{openingBalance: 100}, {structureId: account2}, {currency: 'USD'}]) await assert.rejects(protectAccountChange(request(), account1, changes), {statusCode: 409});
    await protectAccountChange(request(), account1, {isActive: false, name: 'Cassa chiusa', openingBalance: '0.00'});
    assert.equal(f.accounts[0].isActive, false); assert.equal(f.accounts[0].openingBalance, '0.00');
});

function seedAdvance(f: ReturnType<typeof fixture>) {
    f.credits.push({id: creditId, structureId: site, patientId: patient, amount: 100, remainingAmount: 100, status: 'ACTIVE', sourceType: 'TREASURY_ADVANCE', sourceId: receiptId});
    f.treasury.push({id: receiptId, accountId: account1, structureId: site, amount: 100, direction: 'IN', status: 'POSTED', sourceType: 'PATIENT_ADVANCE', sourceId: creditId, occurredAt: day + 'T12:00:00Z'});
}

it('reverses an unused backed advance once and refuses one that has already funded care', async t => {
    const f = fixture(t); seedAdvance(f);
    const req = request({reason: 'Anticipo errato', occurredAt: '2026-01-11'}, 'advance-void-001', {id: creditId});
    const result = await voidPatientAdvance(req);
    assert.equal(result.credit.remainingAmount, 0); assert.equal(f.credits[0].status, 'VOID');
    assert.equal(f.movements[0].type, 'VOID_ADVANCE'); assert.equal(treasuryBalance(balanceEffectiveMovements(f.treasury)), 0);
    assert.deepEqual(await voidPatientAdvance(req), result); assert.equal(f.treasury.length, 2);
});

it('blocks advance reversal on dependencies even after the cached credit has been restored', async t => {
    const f = fixture(t); seedAdvance(f); f.movements.push({creditId, type: 'APPLY_INVOICE', amount: 20});
    await assert.rejects(voidPatientAdvance(request({reason: 'Correzione anticipo'}, 'advance-void-001', {id: creditId})), {statusCode: 409});
    assert.equal(f.treasury.length, 1); assert.equal(f.credits[0].remainingAmount, 100);
});

function seedResolvedApplication(f: ReturnType<typeof fixture>, type = 'APPLY_APPOINTMENT') {
    seedAdvance(f);
    const original = {id: refundId, creditId, type, amount: 40, targetId: expenseId, invoicePaymentId: ids[10]};
    const reverse = {...original, id: ids[11], type: 'REVERSE_APPLY', reversalOfId: original.id};
    f.movements.push(original, reverse);
    f.payments.push({id: ids[10], source: 'CREDIT', status: 'VOID', amount: 40,
        ...(type === 'APPLY_APPOINTMENT' ? {agendaEventId: expenseId} : {invoiceId: expenseId})});
}

for (const type of ['APPLY_APPOINTMENT', 'APPLY_INVOICE']) {
    it(`allows advance reversal after a verified ${type} compensation and preserves both history rows`, async t => {
        const f = fixture(t); seedResolvedApplication(f, type);
        const before = structuredClone(f.movements);
        assert.equal((await creditCorrectionCapabilities(request(), f.credits)).get(creditId)?.canVoidAdvance, true);
        await voidPatientAdvance(request({reason: 'Anticipo ripristinato', occurredAt: '2026-01-11'}, 'advance-after-undo', {id: creditId}));
        assert.deepEqual(f.movements.slice(0, 2), before);
        assert.equal(f.movements[2].type, 'VOID_ADVANCE');
        assert.equal(f.credits[0].status, 'VOID');
        assert.equal(treasuryBalance(balanceEffectiveMovements(f.treasury)), 0);
    });
}

it('allows advance reversal after a refund has been reversed on its original account', async t => {
    const f = fixture(t); seedAdvance(f); f.credits[0].remainingAmount = 60;
    f.movements.push({id: refundId, creditId, type: 'REFUND', amount: 40, treasuryMovementId: ids[10]});
    f.treasury.push({id: ids[10], accountId: account2, structureId: site, amount: 40, direction: 'OUT', status: 'POSTED',
        sourceType: 'PATIENT_CREDIT_REFUND', sourceId: refundId, occurredAt: day + 'T12:00:00Z'});
    await voidPatientRefund(request({reason: 'Rimborso errato', occurredAt: '2026-01-11'}, 'refund-before-advance', {id: creditId, movementId: refundId}));
    assert.equal(f.credits[0].remainingAmount, 100);
    assert.equal((await creditCorrectionCapabilities(request(), f.credits)).get(creditId)?.canVoidAdvance, true);
    await voidPatientAdvance(request({reason: 'Anticipo errato', occurredAt: '2026-01-11'}, 'advance-after-refund', {id: creditId}));
    assert.deepEqual(f.movements.map(row => row.type), ['REFUND', 'REVERSE_REFUND', 'VOID_ADVANCE']);
    assert.equal(treasuryBalance(balanceEffectiveMovements(f.treasury)), 0);
});

const invalidResolvedApplications: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ['active application with a falsely restored cache', f => {f.movements.pop(); f.payments[0].status = 'POSTED';}],
    ['orphan compensation', f => {f.movements.shift();}],
    ['different reversed amount', f => {f.movements[1].amount = 39;}],
    ['different reversed target', f => {f.movements[1].targetId = account2;}],
    ['different payment reference', f => {f.movements[1].invoicePaymentId = account2;}],
    ['coverage that is still posted', f => {f.payments[0].status = 'POSTED';}],
    ['coverage from another target', f => {f.payments[0].agendaEventId = account2;}],
    ['duplicate compensation', f => {f.movements.push({...f.movements[1], id: account2});}],
    ['unclassified movements with a cancelling sum', f => {f.movements[0].type = 'UNKNOWN'; f.movements[1].type = 'UNKNOWN_REVERSE';}],
];
for (const [label, mutate] of invalidResolvedApplications) {
    it(`refuses advance correction for ${label} in both capabilities and the writer`, async t => {
        const f = fixture(t); seedResolvedApplication(f); mutate(f);
        assert.equal((await creditCorrectionCapabilities(request(), f.credits)).get(creditId)?.canVoidAdvance, false);
        await assert.rejects(voidPatientAdvance(request({reason: 'Correzione anticipo'}, 'invalid-advance-undo', {id: creditId})), {statusCode: 409});
        assert.equal(f.treasury.length, 1); assert.equal(f.operations.length, 0); assert.equal(f.credits[0].status, 'ACTIVE');
    });
}

it('refuses balanced refund compensation records when the actual cash account or source does not match', async t => {
    const f = fixture(t); seedAdvance(f);
    const original = {id: refundId, creditId, type: 'REFUND', amount: 40, treasuryMovementId: ids[10]};
    const reverse = {id: ids[11], creditId, type: 'REVERSE_REFUND', amount: 40, treasuryMovementId: expenseId, reversalOfId: refundId};
    f.movements.push(original, reverse);
    f.treasury.push({id: ids[10], accountId: account1, structureId: site, amount: 40, direction: 'OUT', status: 'VOID', sourceType: 'PATIENT_CREDIT_REFUND', sourceId: refundId},
        {id: expenseId, accountId: account2, structureId: site, amount: 40, direction: 'IN', status: 'POSTED', sourceType: 'PATIENT_REFUND_VOID', sourceId: refundId, reversalOfId: ids[10]});
    assert.equal((await creditCorrectionCapabilities(request(), f.credits)).get(creditId)?.canVoidAdvance, false);
    await assert.rejects(voidPatientAdvance(request({reason: 'Correzione anticipo'}, 'wrong-refund-undo', {id: creditId})), {statusCode: 409});
    f.treasury[2].accountId = account1; f.treasury[2].sourceId = account2;
    assert.equal((await creditCorrectionCapabilities(request(), f.credits)).get(creditId)?.canVoidAdvance, false);
    assert.equal(f.treasury.length, 3); assert.equal(f.credits[0].status, 'ACTIVE');
});

it('reverses a refund into the same account and restores existing credit without creating new credit', async t => {
    const f = fixture(t); seedAdvance(f); f.credits[0].remainingAmount = 60;
    f.movements.push({id: refundId, creditId, type: 'REFUND', amount: 40, treasuryMovementId: ids[10]});
    f.treasury.push({id: ids[10], accountId: account2, structureId: site, amount: 40, direction: 'OUT', status: 'POSTED', sourceType: 'PATIENT_CREDIT_REFUND', sourceId: refundId, occurredAt: day + 'T12:00:00Z'});
    const req = request({reason: 'Rimborso errato', occurredAt: day}, 'refund-void-001', {id: creditId, movementId: refundId});
    const result = await voidPatientRefund(req);
    assert.equal(result.credit.remainingAmount, 100); assert.equal(f.credits.length, 1);
    assert.equal(f.treasury[2].accountId, account2); assert.equal(f.treasury[2].direction, 'IN');
    assert.equal(f.movements[1].type, 'REVERSE_REFUND'); assert.equal(f.movements[1].reversalOfId, refundId);
    assert.deepEqual(await voidPatientRefund(req), result); assert.equal(f.treasury.length, 3);
    assert.equal(treasuryProjection(f.treasury, [], day, day).creditRefunds, 0);
});

async function controllerStatus(handler: any, req: Request): Promise<number> {
    return new Promise(resolve => {
        const res: any = {statusCode: 200, status(code: number) {this.statusCode = code; return this;}, json() {resolve(this.statusCode); return this;}};
        handler(req, res, (error?: any) => resolve(error?.statusCode ?? 500));
    });
}

it('rejects new expenses and supplier documents directly marked paid before persisting a misleading flag', async t => {
    const f = fixture(t);
    assert.equal(await controllerStatus(administration.create('expenses'), request({amount: 100, status: 'PAID', structureId: site})), 422);
    assert.equal(await controllerStatus(administration.create('purchaseDocuments'), request({total: 100, status: 'PARTIAL', structureId: site})), 422);
    assert.equal(f.expenses.length, 1); assert.equal(f.treasury.length, 0);
});

it('unknown expense totals and orphan corrections cannot become a payable cash residual', () => {
    assert.equal(expensePaymentPosition({id: expenseId, amount: null}, []).paymentState, 'UNRECONCILED');
    assert.equal(expensePaymentPosition({id: expenseId, amount: 100}, [{expenseId, sourceType: 'EXPENSE_PAYMENT_VOID', direction: 'IN', amount: 20, status: 'POSTED'}]).balance, null);
});

it('an expense void accepts the same calendar day and rolls back when its compensating movement fails', async t => {
    const f = fixture(t); await recordExpensePayment(request(payment(30)));
    f.treasury[0].occurredAt = day + 'T18:00:00.000Z'; f.state.failTreasuryCreate = 2;
    const req = request({reason: 'Pagamento errato', occurredAt: day}, 'expense-void-key', {id: expenseId, paymentId: f.treasury[0].id});
    await assert.rejects(voidExpensePayment(req), /injected ledger failure/);
    assert.equal(f.treasury[0].status, 'POSTED'); assert.equal(f.treasury.length, 1); assert.equal(f.expenses[0].status, 'PARTIAL');
    await voidExpensePayment(req); assert.equal(f.expenses[0].status, 'OPEN');
});

it('records an advance with the chosen date and the only account, then refunds existing cash once', async t => {
    const f = fixture(t); f.accounts.splice(1, 1);
    const advanceReq = request({patientId: patient, amount: 80, paidAt: day}, 'advance-create-001');
    const credit = await recordPatientAdvance(advanceReq);
    assert.equal(f.treasury[0].accountId, account1); assert.equal(new Date(f.treasury[0].occurredAt).toISOString().slice(0, 10), day);
    assert.equal(credit.remainingAmount, 80); assert.deepEqual(await recordPatientAdvance(advanceReq), credit);
    const refundReq = request({amount: 30, paidAt: '2026-01-11'}, 'refund-create-001', {id: credit.id});
    const refunded = await recordPatientRefund(refundReq);
    assert.equal(refunded.type, 'REFUND'); assert.equal(f.credits[0].remainingAmount, 50); assert.equal(f.treasury.length, 2);
    assert.equal(f.treasury[1].direction, 'OUT'); assert.equal(f.treasury[1].accountId, account1);
    assert.equal(new Date(f.treasury[1].occurredAt).toISOString().slice(0, 10), '2026-01-11');
    assert.deepEqual(await recordPatientRefund(refundReq), refunded); assert.equal(f.treasury.length, 2);
    await assert.rejects(recordPatientRefund(request({amount: 31, paidAt: '2026-01-11'}, 'refund-create-001', {id: credit.id})), {statusCode: 409});
});

it('requires a choice for multiple accounts and rolls back an advance when its cash receipt fails', async t => {
    const f = fixture(t);
    await assert.rejects(recordPatientAdvance(request({patientId: patient, amount: 80, paidAt: day})), {statusCode: 422});
    assert.equal(f.credits.length, 0); f.state.failTreasuryCreate = 1;
    await assert.rejects(recordPatientAdvance(request({patientId: patient, amount: 80, paidAt: day, accountId: account1})), /injected ledger failure/);
    assert.equal(f.credits.length, 0); assert.equal(f.treasury.length, 0); assert.equal(f.operations.length, 0);
});

it('projects correction actions only for backed originals without dependencies and with both write permissions', async t => {
    const f = fixture(t); seedAdvance(f);
    const req = request();
    assert.equal((await creditCorrectionCapabilities(req, f.credits)).get(creditId)?.canVoidAdvance, true);
    f.movements.push({id: refundId, creditId, type: 'REFUND', amount: 20, treasuryMovementId: ids[10]}); f.credits[0].remainingAmount = 80;
    f.treasury.push({id: ids[10], accountId: account2, structureId: site, direction: 'OUT', amount: 20, status: 'POSTED', sourceType: 'PATIENT_CREDIT_REFUND', sourceId: refundId});
    assert.equal((await creditCorrectionCapabilities(req, f.credits)).get(creditId)?.canVoidAdvance, false);
    assert.equal((await refundCorrectionCapabilities(req, f.credits[0], f.movements)).get(refundId), true);
    req.user = {sub: actor, sid: site, permissions: ['quote:read:structure']} as any;
    assert.equal((await refundCorrectionCapabilities(req, f.credits[0], f.movements)).get(refundId), false);
    req.user = {sub: actor, sid: site, isSuperAdmin: true} as any;
    f.movements.push({id: ids[11], creditId, type: 'REVERSE_REFUND', reversalOfId: refundId});
    assert.equal((await refundCorrectionCapabilities(req, f.credits[0], f.movements)).get(refundId), false);
});

it('allows the own patient author to register an advance and refuses an unrelated operator', async t => {
    const f = fixture(t), body = {patientId: patient, amount: 30, accountId: account1, paidAt: day};
    const req = request(body); req.user = {sub: actor, sid: site, permissions: ['quote:create:own', 'treasury:create:own']} as any;
    await recordPatientAdvance(req); assert.equal(f.treasury.length, 1);
    req.user = {sub: account2, sid: site, permissions: ['quote:create:own', 'treasury:create:own']} as any;
    await assert.rejects(recordPatientAdvance(req), {statusCode: 403}); assert.equal(f.treasury.length, 1);
});
