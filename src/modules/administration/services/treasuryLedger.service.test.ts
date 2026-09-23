import assert from 'node:assert/strict';
import { it, TestContext } from 'node:test';
import { sequelize } from '../../../config/database.js';
import { Structure, Tenant } from '../../auth/models/index.js';
import { Invoice } from '../../invoice/models/index.js';
import { listFinancialAccounts, reports, overview } from '../controllers/administration.view.controller.js';
import { DailyClosing, Expense, FinancialAccount, FiscalSubmission, Quote, TreasuryMovement } from '../models/index.js';
import controller from '../controllers/administration.controller.js';
import {
    balanceEffectiveMovements, closingBalances, closingPreviewVersion, createTreasuryClosing, reverseTreasuryMovement, treasuryBalance
} from './treasuryLedger.service.js';

const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const structureId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const movementId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const otherId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const tenantId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const original = (extra: Record<string, unknown> = {}) => ({
    id: movementId, accountId, structureId, direction: 'IN', amount: 100, status: 'POSTED',
    occurredAt: '2026-01-10T12:00:00Z', category: 'OTHER', ...extra
});
const request = (key = 'request-key') => ({
    tenantSchema: 'rehablo_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', user: { tid: tenantId },
    access: { scope: 'tenant', structureId, userId: otherId }, params: { id: movementId },
    header: (name: string) => name === 'Idempotency-Key' ? key : undefined
}) as any;

function fixture(t: TestContext, movements: any[] = [original()]) {
    const account: any = { id: accountId, structureId, type: 'CASH', isActive: true, openingBalance: 20 };
    const closings: any[] = [], observed: any[] = [];
    const lockTails = new Map<string, Promise<void>>();
    const acquire = async (transaction: any, key: string) => {
        const previous = lockTails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        lockTails.set(key, previous.then(() => pending));
        await previous;
        transaction.releases.push(release);
    };
    t.mock.method(sequelize, 'transaction', (async (work: any) => {
        const transaction = { LOCK: { UPDATE: 'UPDATE' }, releases: [] as Array<() => void> };
        try { return await work(transaction); } finally { transaction.releases.forEach(release => release()); }
    }) as any);
    t.mock.method(sequelize, 'query', (async (_sql: string, options: any) => {
        await acquire(options.transaction, options.replacements.lockKey);
        return [[], {}];
    }) as any);
    const model = (values: any): any => ({
        get: (key: any) => typeof key === 'string' ? values[key] : { ...values },
        update: async (changes: any, options: any) => {
            assert.ok(options.transaction); Object.assign(values, changes); return model(values);
        }
    });
    t.mock.method(FinancialAccount, 'schema', (() => ({
        findAll: async () => [model(account)],
        findOne: async (options: any) => {
            observed.push({ kind: 'account', ...options });
            if (options.lock) await acquire(options.transaction, 'account:' + options.where.id);
            return options.where.id === account.id ? model(account) : null;
        }
    })) as any);
    t.mock.method(Structure, 'findOne', (async (options: any) => {
        observed.push({ kind: 'structure', ...options });
        return options.where.id === structureId && options.where.tenantId === tenantId ? model({ id: structureId }) : null;
    }) as any);
    t.mock.method(TreasuryMovement, 'schema', (() => ({
        findAll: async (options: any) => {
            observed.push({ kind: 'movementList', ...options });
            return movements.filter(row =>
                (typeof options.where.accountId !== 'string' || row.accountId === options.where.accountId)
                && (!options.where.structureId || row.structureId === options.where.structureId)
            ).map(model);
        },
        findOne: async (options: any) => {
            observed.push({ kind: 'movement', ...options });
            if (options.lock) await acquire(options.transaction, 'movement:' + options.where.id);
            const row = movements.find(row => Object.entries(options.where).every(([key, value]) => row[key] === value));
            return row ? model(row) : null;
        },
        create: async (value: any, options: any) => {
            assert.ok(options.transaction);
            const row = { id: 'reversal-' + movements.length, ...value };
            movements.push(row); return model(row);
        }
    })) as any);
    t.mock.method(DailyClosing, 'schema', (() => ({
        findOne: async (options: any) => {
            assert.ok(options.transaction);
            const row = closings.find(row => row.accountId === options.where.accountId && row.closedOn === options.where.closedOn);
            return row ? model(row) : null;
        },
        create: async (value: any, options: any) => {
            assert.ok(options.transaction);
            closings.push(value); return model(value);
        }
    })) as any);
    return { account, movements, closings, observed };
}

it('a posted reversal compensates a legacy VOID original without rewriting historical records', () => {
    const rows = [original({ status: 'VOID' }), original({
        id: otherId, direction: 'OUT', reversalOfId: movementId, occurredAt: '2026-01-12T12:00:00Z'
    })];
    assert.equal(treasuryBalance(balanceEffectiveMovements(rows)), 0);
    assert.deepEqual(closingBalances(rows, 20, '2026-01-11'), { openingBalance: 120, expectedBalance: 120 });
    assert.deepEqual(closingBalances(rows, 20, '2026-01-12'), { openingBalance: 120, expectedBalance: 20 });
    assert.equal(rows[0].status, 'VOID');
});
it('legacy VOID without a verified posted opposite entry has no effect on balances', () => {
    assert.equal(balanceEffectiveMovements([original({ status: 'VOID' })]).length, 0);
    for (const changes of [{ status: 'VOID' }, { accountId: otherId }, { amount: 90 }, { direction: 'IN' }]) {
        const rows = [original({ status: 'VOID' }), original({ id: otherId, direction: 'OUT', reversalOfId: movementId, ...changes })];
        assert.ok(!balanceEffectiveMovements(rows).some(row => row.id === movementId));
    }
});
it('balance arithmetic works in cents and handles ordinary posted originals and reversals once each', () => {
    assert.equal(treasuryBalance(balanceEffectiveMovements([
        original({ amount: 0.1 }), original({ id: 'second', amount: 0.2 }),
        original({ id: 'third', direction: 'OUT', amount: 0.3 })
    ])), 0);
    assert.equal(treasuryBalance(balanceEffectiveMovements([
        original(), original({ id: otherId, direction: 'OUT', reversalOfId: movementId })
    ])), 0);
});
it('historical closing uses Rome day boundaries and excludes later movements', async t => {
    const f = fixture(t, [original(),
        original({ id: 'same-day', amount: 50, occurredAt: '2026-01-11T12:00:00Z' }),
        original({ id: 'late-day', direction: 'OUT', amount: 10, occurredAt: '2026-01-11T22:59:59Z' }),
        original({ id: 'tomorrow', amount: 40, occurredAt: '2026-01-11T23:00:00Z' })
    ]);
    const row = await createTreasuryClosing(request(), { accountId, closedOn: '2026-01-11', countedBalance: 159, notes: '  verifica  ' });
    assert.equal(row.get('openingBalance'), 120);
    assert.equal(row.get('expectedBalance'), 160);
    assert.equal(row.get('difference'), -1);
    assert.equal(row.get('notes'), 'verifica');
    assert.equal(row.get('closedByUserId'), otherId);
    assert.ok(f.observed.some(item => item.kind === 'account' && item.lock === 'UPDATE' && item.transaction));
});
it('closing ignores forged financial fields, structure, status and operator from the request', async t => {
    fixture(t);
    const handler = controller.create('dailyClosings');
    const result = await new Promise<any>(resolve => {
        const req = { ...request(), body: { accountId, closedOn: '2026-01-11', countedBalance: 125,
            openingBalance: 99999, expectedBalance: 99999, difference: 0, structureId: otherId,
            status: 'OPEN', closedByUserId: movementId } };
        const res: any = { status: () => res, json: resolve };
        handler(req, res, (error: any) => resolve({ error }));
    });
    assert.ok(!result.error);
    const data = result.data.get({ plain: true });
    assert.equal(data.openingBalance, 120);
    assert.equal(data.expectedBalance, 120);
    assert.equal(data.difference, 5);
    assert.equal(data.structureId, structureId);
    assert.equal(data.closedByUserId, otherId);
    assert.equal(data.status, 'CLOSED');
});
it('concurrent closures on the same account and day produce a single record and a clear conflict', async t => {
    const f = fixture(t);
    const values = { accountId, closedOn: '2026-01-11', countedBalance: 120 };
    const results = await Promise.allSettled([createTreasuryClosing(request(), values), createTreasuryClosing(request(), values)]);
    assert.equal(f.closings.length, 1);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.statusCode, 409);
    assert.match(rejected.reason.message, /già stata registrata/);
});
it('closing rejects bank or inactive accounts instead of recording a cash count', async t => {
    const f = fixture(t);
    f.account.type = 'BANK';
    await assert.rejects(createTreasuryClosing(request(), { accountId, closedOn: '2026-01-11', countedBalance: 0 }), /solo per i conti cassa/);
    f.account.type = 'CASH'; f.account.isActive = false;
    await assert.rejects(createTreasuryClosing(request(), { accountId, closedOn: '2026-01-11', countedBalance: 0 }), /non è disponibile/);
    assert.equal(f.closings.length, 0);
});
it('closing rejects invalid and future dates and missing or negative counted balances', async t => {
    const f = fixture(t);
    for (const changes of [{ closedOn: '2026-02-30' }, { closedOn: '2999-01-01' },
        { countedBalance: undefined }, { countedBalance: null }, { countedBalance: '' }, { countedBalance: -0.01 }, { countedBalance: true }, { countedBalance: [] }, { countedBalance: 10000000000 }]) {
        await assert.rejects(createTreasuryClosing(request(), {
            accountId, closedOn: '2026-01-11', countedBalance: 0, ...changes
        }), (error: any) => error.statusCode === 400);
    }
    assert.equal(f.closings.length, 0);
});
it('shared cash accounts require a selected trusted structure and ignore a supplied structure', async t => {
    const f = fixture(t); f.account.structureId = null;
    const req = request(); req.access.structureId = null;
    await assert.rejects(createTreasuryClosing(req, {
        accountId, closedOn: '2026-01-11', countedBalance: 0, structureId
    }), /Seleziona una sede/);
    assert.equal(f.closings.length, 0);
});
it('manual reversal preserves a balanced ledger and uses a readable fallback description', async t => {
    const f = fixture(t);
    const result = await reverseTreasuryMovement(request(), { reason: 'Importo errato' });
    assert.equal(result.created, true);
    assert.equal(result.row.get('description'), 'Storno: Movimento manuale');
    assert.equal(result.row.get('voidReason'), 'Importo errato');
    assert.equal(f.movements[0].status, 'VOID');
    assert.equal(treasuryBalance(balanceEffectiveMovements(f.movements)), 0);
    assert.ok(f.observed.some(item => item.kind === 'movement' && item.lock === 'UPDATE' && item.transaction));
});
it('repeating the same reversal request returns its existing result without a duplicate', async t => {
    const f = fixture(t);
    const first = await reverseTreasuryMovement(request(), { reason: 'Correzione importo' });
    const second = await reverseTreasuryMovement(request(), { reason: 'Correzione importo' });
    assert.equal(second.created, false);
    assert.equal(first.row.get('id'), second.row.get('id'));
    assert.equal(f.movements.length, 2);
});
it('concurrent reversal requests with different keys cannot reverse the original twice', async t => {
    const f = fixture(t);
    const results = await Promise.allSettled([
        reverseTreasuryMovement(request('first'), { reason: 'Correzione' }),
        reverseTreasuryMovement(request('second'), { reason: 'Correzione' })
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.statusCode, 409);
    assert.equal(f.movements.length, 2);
    assert.equal(treasuryBalance(balanceEffectiveMovements(f.movements)), 0);
});
it('a reversal key cannot be reused for a different reason or original movement', async t => {
    const f = fixture(t, [original(), original({ id: otherId })]);
    await reverseTreasuryMovement(request(), { reason: 'Correzione' });
    await assert.rejects(reverseTreasuryMovement(request(), { reason: 'Altro motivo' }), (error: any) => error.statusCode === 409);
    const req = request(); req.params.id = otherId;
    await assert.rejects(reverseTreasuryMovement(req, { reason: 'Correzione' }), (error: any) => error.statusCode === 409);
    assert.equal(f.movements.length, 3);
});
it('derived receipts, document payments and existing reversals must be managed at their canonical source', async t => {
    const f = fixture(t);
    for (const changes of [
        { sourceType: 'INVOICE_PAYMENT', sourceId: otherId }, { sourceType: 'INVOICE_PAYMENT_VOID' },
        { sourceType: 'APPOINTMENT' }, { invoiceId: otherId }, { expenseId: otherId }, { reversalOfId: otherId }
    ]) {
        Object.keys(f.movements[0]).forEach(key => delete f.movements[0][key]);
        Object.assign(f.movements[0], original(changes));
        await assert.rejects(reverseTreasuryMovement(request(), { reason: 'Correzione' }),
            (error: any) => error.statusCode === 409 && /documento o dalla seduta/.test(error.message));
    }
    assert.equal(f.movements.length, 1);
});
it('a legacy already compensated original cannot receive another reversal even if still posted', async t => {
    const f = fixture(t, [original(), original({ id: otherId, direction: 'OUT', reversalOfId: movementId })]);
    await assert.rejects(reverseTreasuryMovement(request(), { reason: 'Correzione' }), /già stato stornato/);
    assert.equal(f.movements.length, 2);
});
it('manual reversal requires a reason and an idempotency key', async t => {
    const f = fixture(t);
    await assert.rejects(reverseTreasuryMovement(request(), {}), /motivo dello storno/);
    await assert.rejects(reverseTreasuryMovement(request(''), { reason: 'Correzione' }), /Identificativo/);
    assert.equal(f.movements.length, 1);
});

function fiscalReadFixture(t: TestContext) {
    const emptyModel = { findAll: async () => [] };
    t.mock.method(Invoice, 'schema', (() => emptyModel) as any);
    t.mock.method(FiscalSubmission, 'schema', (() => emptyModel) as any);
    t.mock.method(Expense, 'schema', (() => emptyModel) as any);
    t.mock.method(Quote, 'schema', (() => emptyModel) as any);
    t.mock.method(Structure, 'findAll', (async () => [{ get: () => ({ id: structureId, name: 'Centro' }) }]) as any);
    t.mock.method(Tenant, 'findByPk', (async () => ({ get: () => ({}) })) as any);
}
function runView(handler: any, query: any = {}): Promise<any> {
    return new Promise(resolve => {
        const req = { ...request(), query };
        const res: any = { status(code: number) { this.code = code; return this; },
            json(body: any) { resolve({ code: this.code, ...body }); } };
        handler(req, res, (error: any) => resolve({ code: error.statusCode ?? 500, error: error.message }));
    });
}
it('financial account response preserves the actual balance after a legacy original is reversed', async t => {
    fixture(t, [original({ status: 'VOID' }), original({ id: otherId, direction: 'OUT', reversalOfId: movementId })]);
    const result = await runView(listFinancialAccounts);
    assert.equal(result.code, 200);
    assert.equal(result.data.items[0].balance, 20);
});
it('report keeps original cash flows in their historical period and groups Date timestamps in the Rome month', async t => {
    fixture(t, [
        original({ status: 'VOID', occurredAt: new Date('2026-01-31T23:30:00Z') }),
        original({ id: otherId, direction: 'OUT', reversalOfId: movementId, occurredAt: new Date('2026-03-01T12:00:00Z') }),
        original({ id: 'unpaired', status: 'VOID', amount: 500, occurredAt: new Date('2026-02-03T12:00:00Z') })
    ]);
    fiscalReadFixture(t);
    const result = await runView(reports, { from: '2026-02-01', to: '2026-02-28' });
    assert.equal(result.code, 200, result.error);
    assert.equal(result.data.collected, 100);
    assert.equal(result.data.series[0].collected, 100);
    assert.equal(result.data.structures[0].collected, 100);
});
it('overview cash totals include all selected movements rather than just the latest activity records', async t => {
    fixture(t, Array.from({ length: 27 }, (_, index) => original({ id: 'movement-' + index, amount: 1 })));
    fiscalReadFixture(t);
    const result = await runView(overview, { from: '2026-01-01', to: '2026-01-31' });
    assert.equal(result.code, 200, result.error);
    assert.equal(result.data.income, 27);
    assert.equal(result.data.cashFlow, 27);
    assert.equal(result.data.accounts[0].balance, 47);
    assert.equal(result.data.activities.length, 8);
});

it('a structure user cannot close a shared cash account or a cash account from another structure', async t => {
    const f = fixture(t), req = request(); req.access.scope = 'structure';
    f.account.structureId = null;
    await assert.rejects(createTreasuryClosing(req, { accountId, closedOn: '2026-01-11', countedBalance: 0 }),
        (error: any) => error.statusCode === 403 && /tutte le sedi/.test(error.message));
    f.account.structureId = otherId;
    await assert.rejects(createTreasuryClosing(req, { accountId, closedOn: '2026-01-11', countedBalance: 0 }),
        (error: any) => error.statusCode === 403);
    assert.equal(f.closings.length, 0);
});
it('a structure user receives no shared balance and triggers no read of its movements', async t => {
    const f = fixture(t); f.account.structureId = null;
    const result = await new Promise<any>(resolve => {
        const req = { ...request(), query: {} }; req.access.scope = 'structure';
        const res: any = { status: () => res, json: resolve };
        listFinancialAccounts(req, res, (error: any) => resolve({ error }));
    });
    assert.ok(!result.error);
    assert.equal(result.data.items[0].balance, null);
    assert.equal(result.data.items[0].balanceAvailable, false);
    assert.equal(result.data.items[0].canClose, false);
    assert.ok(!f.observed.some(item => item.kind === 'movementList'));
});
it('an organization user can read and close a shared cash account for the selected trusted structure', async t => {
    const f = fixture(t); f.account.structureId = null;
    const result = await runView(listFinancialAccounts);
    assert.equal(result.data.items[0].balance, 120);
    assert.equal(result.data.items[0].balanceAvailable, true);
    assert.equal(result.data.items[0].canClose, true);
    const closing = await createTreasuryClosing(request(), { accountId, closedOn: '2026-01-11', countedBalance: 120 });
    assert.equal(closing.get('structureId'), structureId);
    assert.equal(closing.get('expectedBalance'), 120);
});

it('closing rejects a stale preview without saving and accepts a refreshed financial version', async t => {
    const f = fixture(t);
    const previewVersion = closingPreviewVersion(accountId, Number(f.account.openingBalance), f.movements, '2026-01-11');
    f.movements.push(original({ id: otherId, amount: 10, occurredAt: '2026-01-11T12:00:00Z' }));
    await assert.rejects(createTreasuryClosing(request(), { accountId, closedOn: '2026-01-11', countedBalance: 120, previewVersion }),
        (error: any) => error.statusCode === 409 && /Ricarica il riepilogo/.test(error.message));
    assert.equal(f.closings.length, 0);
    const currentVersion = closingPreviewVersion(accountId, Number(f.account.openingBalance), f.movements, '2026-01-11');
    const saved = await createTreasuryClosing(request(), { accountId, closedOn: '2026-01-11', countedBalance: 130, previewVersion: currentVersion });
    assert.equal(saved.get('expectedBalance'), 130);
});
it('preview version ignores row order and later-day entries but detects changed opening cash', () => {
    const rows = [original(), original({ id: otherId, amount: 20 })];
    const before = closingPreviewVersion(accountId, 20, rows, '2026-01-11');
    assert.equal(closingPreviewVersion(accountId, 20, [...rows].reverse(), '2026-01-11'), before);
    assert.equal(closingPreviewVersion(accountId, 20, [...rows, original({ id: 'future', occurredAt: '2026-01-12T12:00:00Z' })], '2026-01-11'), before);
    assert.notEqual(closingPreviewVersion(accountId, 25, rows, '2026-01-11'), before);
});