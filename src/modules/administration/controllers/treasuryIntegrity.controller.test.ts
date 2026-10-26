import assert from 'node:assert/strict';
import {test, TestContext} from 'node:test';
import {sequelize} from '../../../config/database.js';
import {Expense, FinancialAccount, PatientCredit, PurchaseDocument, TreasuryMovement} from '../models/index.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import {PatientSettlementOperation} from '../../patients/models/patientSettlementOperation.model.js';
import {getTreasuryIntegrity, repairTreasuryIntegrity} from './treasuryIntegrity.controller.js';
const id = (n: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0');
const site = id(1), accountId = id(2), paymentId = id(3), invoiceId = id(4), userId = id(5);
function invoke(handler: any, req: any): Promise<{status: number; body: any}> {
    return new Promise(resolve => handler(req, {code: 200, status(code: number) {this.code = code; return this;},
        json(body: any) {resolve({status: this.code, body}); return this;}},
    (error: any) => resolve({status: error?.statusCode ?? 500, body: {message: error?.message}})));
}
function fixture(t: TestContext) {
    const payments: any[] = [{id: paymentId, invoiceId, structureId: site, amount: 50, paidAt: null,
        source: 'APPOINTMENT', status: 'POSTED', agendaEventId: null, carePackageId: null, voidedAt: null}];
    const movements: any[] = [];
    const settlements: any[] = [];
    const tx = {LOCK: {UPDATE: 'UPDATE'}};
    const flags = {failMovement: false, reads: 0};
    const record = (row: any): any => ({get: (key: any) => typeof key === 'string' ? row[key] : {...row},
        update: async (values: any, options: any) => {assert.equal(options.transaction, tx); Object.assign(row, values); return record(row);}});
    t.mock.method(sequelize, 'query', (async (sql: string, options: any) => {
        if (sql.includes('FROM') && sql.includes('invoice_payments')) {
            flags.reads++;
            return payments.filter(row => !options.replacements.structureId || row.structureId === options.replacements.structureId).map(row => ({...row}));
        }
        assert.ok(sql.includes('pg_advisory_xact_lock')); assert.equal(options.transaction, tx); return [[]];
    }) as any);
    t.mock.method(sequelize, 'transaction', (async (callback: any) => {
        const before = structuredClone(payments), beforeMovements = structuredClone(movements);
        try {return await callback(tx);} catch (error) {payments.splice(0, payments.length, ...before); movements.splice(0, movements.length, ...beforeMovements); throw error;}
    }) as any);
    t.mock.method(TreasuryMovement, 'schema', (() => ({
        findAll: async ({where}: any) => movements.filter(row => !where.structureId || row.structureId === where.structureId).map(record),
        findOne: async ({where}: any) => {const row = movements.find(item => item.idempotencyKey === where.idempotencyKey); return row ? record(row) : null;},
        findByPk: async (key: string) => {const row = movements.find(item => item.id === key); return row ? record(row) : null;},
        create: async (values: any, options: any) => {assert.equal(options.transaction, tx); if (flags.failMovement) throw new Error('Ledger failure'); movements.push(values); return record(values);}
    })) as any);
    t.mock.method(FinancialAccount, 'schema', (() => ({findAll: async () => [record({id: accountId})],
        findByPk: async (key: string) => key === accountId ? record({id: accountId, structureId: site, currency: 'EUR'}) : null})) as any);
    t.mock.method(Expense, 'schema', (() => ({findAll: async () => []})) as any);
    t.mock.method(PatientCredit, 'schema', (() => ({findAll: async () => []})) as any);
    t.mock.method(PurchaseDocument, 'schema', (() => ({findAll: async () => []})) as any);
    t.mock.method(PatientSettlementOperation, 'schema', (() => ({findAll: async ({where}: any) =>
        settlements.filter(row => !where.structureId || row.structureId === where.structureId).map(record)})) as any);
    t.mock.method(InvoicePayment, 'schema', (() => ({findByPk: async (key: string) => {const row = payments.find(item => item.id === key); return row ? record(row) : null;}})) as any);
    const req: any = {tenantSchema: 'rehablo_0123456789abcdef0123456789abcdef', user: {sub: userId, sid: site, perms: ['treasury:read:structure', 'treasury:update:structure']},
        access: {scope: 'structure', structureId: site, userId}, query: {}, body: {}, header: () => 'repair-operation-1'};
    return {req, payments, movements, flags, settlements};
}
test('read-only check detects missing entry without creating a date, account or movement; source permissions hide invoice links', async t => {
    const f = fixture(t);
    const result = await invoke(getTreasuryIntegrity, f.req);
    assert.equal(result.status, 200); assert.equal(result.body.data.total, 1);
    assert.equal(result.body.data.issues[0].invoiceId, null);
    assert.equal(f.payments[0].paidAt, null); assert.equal(f.movements.length, 0);
});
test('repair requires the real historic account even if only one account currently exists', async t => {
    const f = fixture(t);
    const issue = (await invoke(getTreasuryIntegrity, f.req)).body.data.issues[0];
    f.req.body = {issueId: issue.id, evidenceVersion: issue.evidenceVersion, reason: 'Recupero registrazione', occurredAt: '2026-09-01'};
    assert.equal((await invoke(repairTreasuryIntegrity, f.req)).status, 422);
    assert.equal(f.movements.length, 0);
});
test('explicit repair links one entry and known date; same retry cannot duplicate it', async t => {
    const f = fixture(t);
    const issue = (await invoke(getTreasuryIntegrity, f.req)).body.data.issues[0];
    f.req.body = {issueId: issue.id, evidenceVersion: issue.evidenceVersion, reason: 'Recupero registrazione', accountId, occurredAt: '2026-09-01'};
    const first = await invoke(repairTreasuryIntegrity, f.req), replay = await invoke(repairTreasuryIntegrity, f.req);
    assert.equal(first.status, 201); assert.equal(replay.status, 200); assert.equal(f.movements.length, 1);
    assert.equal(f.movements[0].sourceId, paymentId); assert.equal(f.movements[0].accountId, accountId);
    assert.equal(f.movements[0].createdByUserId, userId);
    assert.equal((await invoke(getTreasuryIntegrity, f.req)).body.data.total, 0);
});
test('changed evidence and conflicting retries are rejected', async t => {
    const f = fixture(t);
    const issue = (await invoke(getTreasuryIntegrity, f.req)).body.data.issues[0];
    f.req.body = {issueId: issue.id, evidenceVersion: issue.evidenceVersion, reason: 'Recupero', accountId, occurredAt: '2026-09-01'};
    f.payments[0].amount = 75;
    assert.equal((await invoke(repairTreasuryIntegrity, f.req)).status, 409); assert.equal(f.movements.length, 0);
    f.payments[0].amount = 50;
    assert.equal((await invoke(repairTreasuryIntegrity, f.req)).status, 201);
    f.req.body.occurredAt = '2026-09-02';
    assert.equal((await invoke(repairTreasuryIntegrity, f.req)).status, 409); assert.equal(f.movements.length, 1);
});
test('historical repair never records a future cash date', async t => {
    const f = fixture(t);
    const issue = (await invoke(getTreasuryIntegrity, f.req)).body.data.issues[0];
    f.req.body = {issueId: issue.id, evidenceVersion: issue.evidenceVersion, reason: 'Recupero', accountId, occurredAt: '2999-01-01'};
    assert.equal((await invoke(repairTreasuryIntegrity, f.req)).status, 422);
    assert.equal(f.payments[0].paidAt, null); assert.equal(f.movements.length, 0);
});
test('failed ledger write rolls back the recovered payment date too', async t => {
    const f = fixture(t);
    const issue = (await invoke(getTreasuryIntegrity, f.req)).body.data.issues[0];
    f.req.body = {issueId: issue.id, evidenceVersion: issue.evidenceVersion, reason: 'Recupero', accountId, occurredAt: '2026-09-01'};
    f.flags.failMovement = true;
    assert.equal((await invoke(repairTreasuryIntegrity, f.req)).status, 500);
    assert.equal(f.payments[0].paidAt, null); assert.equal(f.movements.length, 0);
});
test('structure-scoped diagnostics cannot read another site passed through the query', async t => {
    const f = fixture(t); f.payments[0].structureId = id(99); f.req.query = {structureId: id(99)};
    assert.equal((await invoke(getTreasuryIntegrity, f.req)).body.data.total, 0);
});

test('read-only diagnostics audit grouped allocation totals and never offer a monetary repair', async t => {
    const f = fixture(t);
    f.settlements.push({id: id(10), structureId: site, result: {cashAmount: 75, creditAmount: 0,
        allocations: [{kind: 'APPOINTMENT', targetId: id(11), paymentIds: [paymentId]}]}});
    const before = structuredClone({payments: f.payments, settlements: f.settlements});
    const response = await invoke(getTreasuryIntegrity, f.req);
    const issue = response.body.data.issues.find((row: any) => row.kind === 'SETTLEMENT_ALLOCATION_MISMATCH');
    assert.equal(response.status, 200); assert.equal(issue.settlementOperationId, id(10)); assert.equal(issue.repair, null);
    assert.equal(issue.amount, 75); assert.equal(f.movements.length, 0);
    assert.deepEqual({payments: f.payments, settlements: f.settlements}, before);
    f.req.body = {issueId: issue.id, evidenceVersion: issue.evidenceVersion, reason: 'Verifica attribuzioni'};
    assert.equal((await invoke(repairTreasuryIntegrity, f.req)).status, 409);
    assert.equal(f.movements.length, 0);
});

test('grouped diagnostics remain restricted to the authorized site', async t => {
    const f = fixture(t);
    f.settlements.push({id: id(10), structureId: id(99), result: {cashAmount: 75, creditAmount: 0, allocations: []}});
    f.req.query = {structureId: id(99)};
    const result = await invoke(getTreasuryIntegrity, f.req);
    assert.ok(result.body.data.issues.every((row: any) => row.kind !== 'SETTLEMENT_ALLOCATION_MISMATCH'));
});
