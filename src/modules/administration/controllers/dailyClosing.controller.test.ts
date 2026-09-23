import assert from 'node:assert/strict';
import { it, TestContext } from 'node:test';
import { Op } from 'sequelize';
import { Structure, TenantUser, User } from '../../auth/models/index.js';
import { DailyClosing, FinancialAccount, PaymentMethod, TreasuryMovement } from '../models/index.js';
import { closingState, getDailyClosing, listDailyClosings, previewDailyClosing } from './dailyClosing.controller.js';

const id = (n: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0');
const tenantId = id(1), structureId = id(2), otherStructure = id(3), accountId = id(4), sharedAccount = id(5), otherAccount = id(6), userId = id(7);
const record = (row: any): any => ({ get: (key: any) => typeof key === 'string' ? row[key] : { ...row } });
function matches(row: any, where: any): boolean {
    return Reflect.ownKeys(where ?? {}).every(key => {
        const expected = where[key];
        if (key === Op.or) return expected.some((part: any) => matches(row, part));
        if (key === Op.and) return expected.every((part: any) => matches(row, part));
        if (typeof key !== 'string') return true;
        if (expected && typeof expected === 'object') return Reflect.ownKeys(expected).every(op => {
            if (op === Op.in) return expected[op].includes(row[key]);
            if (op === Op.gte) return row[key] >= expected[op];
            if (op === Op.lte) return row[key] <= expected[op];
            return true;
        });
        return expected === null ? row[key] == null : row[key] === expected;
    });
}
function run(req: any, handler = listDailyClosings): Promise<{ status: number; body: any }> {
    return new Promise(resolve => {
        const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; },
            json(body: any) { resolve({ status: this.statusCode, body }); return this; } };
        handler(req, res, (error?: any) => resolve({ status: error?.statusCode ?? 500, body: { message: error?.message } }));
    });
}
function fixture(t: TestContext) {
    const accounts: any[] = [
        { id: accountId, structureId, type: 'CASH', name: 'Cassa centro', openingBalance: '20', isActive: true },
        { id: sharedAccount, structureId: null, type: 'CASH', name: 'Cassa condivisa', openingBalance: '0', isActive: true },
        { id: otherAccount, structureId: otherStructure, type: 'CASH', name: 'Cassa altra sede', openingBalance: '0', isActive: true }
    ];
    const closings: any[] = [{ id: id(10), accountId, structureId, closedOn: '2026-01-11', openingBalance: '120', expectedBalance: '160',
        countedBalance: '159', difference: '-1', status: 'CLOSED', closedByUserId: userId, createdAt: '2026-01-11T22:30:00Z', notes: 'Manca un euro' }];
    const movements: any[] = [
        { id: id(20), accountId, structureId, direction: 'IN', amount: '100', status: 'POSTED', occurredAt: '2026-01-10T12:00:00Z', createdAt: '2026-01-10T12:00:00Z' },
        { id: id(21), accountId, structureId, direction: 'IN', amount: '50', status: 'POSTED', occurredAt: '2026-01-11T12:00:00Z', createdAt: '2026-01-11T12:00:00Z' },
        { id: id(22), accountId, structureId, direction: 'OUT', amount: '10', status: 'POSTED', occurredAt: '2026-01-11T13:00:00Z', createdAt: '2026-01-11T13:00:00Z' },
        { id: id(23), accountId, structureId, direction: 'IN', amount: '80', status: 'POSTED', occurredAt: '2026-01-11T23:00:00Z', createdAt: '2026-01-11T23:00:00Z' }
    ];
    const methods: any[] = [], queries: Record<string, any[]> = {};
    function stub(model: any, name: string, rows: any[]) {
        queries[name] = [];
        const all = async (options: any) => {
            queries[name].push(options);
            const result = rows.filter(row => matches(row, options.where));
            if (options.order) result.sort((a, b) => {
                for (const [field, direction] of options.order) {
                    const comparison = String(a[field]).localeCompare(String(b[field]));
                    if (comparison) return direction === 'DESC' ? -comparison : comparison;
                }
                return 0;
            });
            return result.map(record);
        };
        t.mock.method(model, 'schema', (() => ({ findAll: all, findOne: async (options: any) => (await all(options))[0] ?? null })) as any);
    }
    stub(FinancialAccount, 'accounts', accounts); stub(DailyClosing, 'closings', closings);
    stub(TreasuryMovement, 'movements', movements); stub(PaymentMethod, 'methods', methods);
    const structures: any[] = [{ id: structureId, tenantId, name: 'Centro' }, { id: otherStructure, tenantId, name: 'Altra sede' }];
    const members: any[] = [{ userId, tenantId }];
    const users: any[] = [{ id: userId, name: 'Maria', surname: 'Bianchi', password: 'never expose', email: 'private' }];
    t.mock.method(Structure, 'findAll', (async (options: any) => structures.filter(row => matches(row, options.where)).map(record)) as any);
    t.mock.method(Structure, 'count', (async (options: any) => structures.filter(row => matches(row, options.where)).length) as any);
    t.mock.method(TenantUser, 'findAll', (async (options: any) => members.filter(row => matches(row, options.where)).map(record)) as any);
    t.mock.method(User, 'findAll', (async (options: any) => {
        assert.deepEqual(options.attributes, ['id', 'name', 'surname']);
        return users.filter(row => matches(row, options.where)).map(record);
    }) as any);
    const req: any = { tenantSchema: 'rehablo_' + tenantId.replaceAll('-', ''), user: { tid: tenantId },
        access: { scope: 'tenant', structureId, userId }, query: {}, params: {} };
    return { req, accounts, closings, movements, methods, queries, members, users };
}

it('historical preview uses the chosen Rome day, opening balance and all account movements', async t => {
    const f = fixture(t); f.req.query = { accountId, closedOn: '2026-01-11' };
    const result = await run(f.req, previewDailyClosing);
    assert.equal(result.status, 200);
    assert.deepEqual({ ...result.body.data, previewVersion: undefined }, {
        accountId, accountName: 'Cassa centro', closedOn: '2026-01-11', openingBalance: 120,
        income: 50, outcome: 10, expectedBalance: 160, movementCount: 2, existingClosingId: id(10), previewVersion: undefined, warnings: []
    });
    assert.match(result.body.data.previewVersion, /^[0-9a-f]{64}$/);
});
it('preview includes non-cash payments in the ledger and warns about the account assignment', async t => {
    const f = fixture(t); f.req.query = { accountId, closedOn: '2026-01-11' };
    f.movements[1].paymentMethodId = id(60); f.methods.push({ id: id(60), type: 'BANK', code: 'BANK_TRANSFER' });
    const preview = (await run(f.req, previewDailyClosing)).body.data;
    assert.equal(preview.expectedBalance, 160);
    assert.equal(preview.income, 50);
    assert.equal(preview.warnings.length, 1);
});
it('history presents saved money, account, premise and operator without changing the snapshot', async t => {
    const f = fixture(t);
    const response = await run(f.req);
    assert.equal(response.status, 200);
    const row = response.body.data.items[0];
    assert.equal(row.accountName, 'Cassa centro'); assert.equal(row.structureName, 'Centro');
    assert.equal(row.operatorName, 'Maria Bianchi'); assert.equal(row.expectedBalance, 160);
    assert.equal(row.countedBalance, 159); assert.equal(row.difference, -1);
    assert.equal(row.currentExpectedBalance, 160); assert.equal(row.hasSubsequentChanges, false);
    assert.equal(f.closings[0].expectedBalance, '160');
    assert.ok(!JSON.stringify(row).includes('never expose'));
});
it('history filters and counts the full result before pagination', async t => {
    const f = fixture(t);
    f.closings.push({ ...f.closings[0], id: id(11), closedOn: '2026-01-10', openingBalance: 20, expectedBalance: 120, countedBalance: 120, difference: 0 },
        { ...f.closings[0], id: id(12), closedOn: '2026-01-09', openingBalance: 20, expectedBalance: 20, countedBalance: 20, difference: 0 });
    f.req.query = { accountId, from: '2026-01-10', to: '2026-01-11', limit: '1', offset: '1' };
    const page = (await run(f.req)).body.data;
    assert.equal(page.total, 2); assert.equal(page.items.length, 1); assert.equal(page.items[0].closedOn, '2026-01-10');
    f.req.query = { differenceState: 'difference' };
    assert.equal((await run(f.req)).body.data.total, 1);
    f.req.query = { differenceState: 'balanced' };
    assert.equal((await run(f.req)).body.data.total, 2);
});
it('structure permission cannot list or inspect closures of a shared account even when closure structure matches', async t => {
    const f = fixture(t);
    f.closings.push({ ...f.closings[0], id: id(11), accountId: sharedAccount },
        { ...f.closings[0], id: id(12), accountId: otherAccount, structureId: otherStructure });
    f.req.access.scope = 'structure'; f.req.query = { structureId: otherStructure };
    assert.equal((await run(f.req)).body.data.total, 1);
    f.req.params.id = id(11);
    assert.equal((await run(f.req, getDailyClosing)).status, 404);
    f.req.query = { accountId: sharedAccount, closedOn: '2026-01-11' };
    assert.equal((await run(f.req, previewDailyClosing)).status, 404);
    assert.ok(f.queries.movements.every(options => !options.where.accountId[Op.in].includes(sharedAccount)));
});
it('tenant permission can see shared account history, while a structure filter limits closing premise', async t => {
    const f = fixture(t);
    f.closings.push({ ...f.closings[0], id: id(11), accountId: sharedAccount },
        { ...f.closings[0], id: id(12), accountId: sharedAccount, structureId: otherStructure });
    assert.equal((await run(f.req)).body.data.total, 3);
    f.req.query = { structureId };
    assert.equal((await run(f.req)).body.data.total, 2);
    f.req.query = { accountId: sharedAccount, closedOn: '2026-01-11' };
    assert.equal((await run(f.req, previewDailyClosing)).status, 200);
});
it('no selected structure or own-only permission yields no data', async t => {
    const f = fixture(t);
    f.req.access.scope = 'structure'; f.req.access.structureId = null;
    assert.equal((await run(f.req)).body.data.total, 0);
    f.req.access.scope = 'own'; f.req.access.structureId = structureId;
    assert.equal((await run(f.req)).body.data.total, 0);
    assert.equal(f.queries.movements.length, 0);
});
it('account reassignment does not expose historical closures from another premise', async t => {
    const f = fixture(t); f.req.access.scope = 'structure';
    f.closings[0].structureId = otherStructure;
    assert.equal((await run(f.req)).body.data.total, 0);
});
it('operator names must belong to the active tenant', async t => {
    const f = fixture(t); f.members[0].tenantId = id(99);
    assert.equal((await run(f.req)).body.data.items[0].operatorName, null);
});
it('preview rejects inactive or bank accounts, malformed dates, future dates and compound filters', async t => {
    const f = fixture(t); f.req.query = { accountId, closedOn: '2026-01-11' };
    f.accounts[0].type = 'BANK'; assert.equal((await run(f.req, previewDailyClosing)).status, 400);
    f.accounts[0].type = 'CASH'; f.accounts[0].isActive = false;
    assert.equal((await run(f.req, previewDailyClosing)).status, 404);
    f.accounts[0].isActive = true;
    for (const closedOn of ['2026-02-30', '2999-01-01', 'bad']) {
        f.req.query = { accountId, closedOn }; assert.equal((await run(f.req, previewDailyClosing)).status, 400);
    }
    f.req.query = { accountId: [accountId], closedOn: '2026-01-11' };
    assert.equal((await run(f.req, previewDailyClosing)).status, 400);
    f.req.query = { from: ['2026-01-11'] };
    assert.equal((await run(f.req)).status, 400);
});
it('history remains accessible for inactive cash accounts', async t => {
    const f = fixture(t); f.accounts[0].isActive = false;
    assert.equal((await run(f.req)).body.data.total, 1);
});
it('backdated entry after closing flags the saved snapshot and reports current expected cash separately', async t => {
    const f = fixture(t);
    f.movements.push({ ...f.movements[1], id: id(30), amount: 30, createdAt: '2026-01-13T10:00:00Z' });
    f.req.params.id = id(10);
    const row = (await run(f.req, getDailyClosing)).body.data;
    assert.equal(row.expectedBalance, 160); assert.equal(row.countedBalance, 159); assert.equal(row.difference, -1);
    assert.equal(row.currentExpectedBalance, 190); assert.equal(row.hasSubsequentChanges, true);
    f.req.query = { differenceState: 'changed' }; assert.equal((await run(f.req)).body.data.total, 1);
});
it('balanced compensating later entries are still flagged; later-day entries alone are not', async t => {
    const f = fixture(t);
    assert.equal(closingState(f.closings[0], f.accounts[0], f.movements).hasSubsequentChanges, false);
    f.movements.push({ ...f.movements[1], id: id(31), amount: 30, createdAt: '2026-01-13T10:00:00Z' },
        { ...f.movements[1], id: id(32), amount: 30, direction: 'OUT', createdAt: '2026-01-13T10:01:00Z' });
    const state = closingState(f.closings[0], f.accounts[0], f.movements);
    assert.equal(state.currentExpectedBalance, 160); assert.equal(state.hasSubsequentChanges, true);
});
it('changed initial balance is detected even without new movements', async t => {
    const f = fixture(t); f.accounts[0].openingBalance = 25;
    const state = closingState(f.closings[0], f.accounts[0], f.movements);
    assert.equal(state.currentExpectedBalance, 165); assert.equal(state.hasSubsequentChanges, true);
});
it('shared-account preview requires the same trusted operating premise as registration', async t => {
    const f = fixture(t); f.req.query = { accountId: sharedAccount, closedOn: '2026-01-11' };
    f.req.access.structureId = null;
    assert.equal((await run(f.req, previewDailyClosing)).status, 400);
    f.req.access.structureId = id(999);
    assert.equal((await run(f.req, previewDailyClosing)).status, 400);
    assert.equal(f.queries.movements.length, 0);
});
it('history outcome filters match the displayed state, with subsequent changes taking priority', async t => {
    const f = fixture(t);
    f.closings.push({ ...f.closings[0], id: id(11), countedBalance: 160, difference: 0 });
    f.movements.push({ ...f.movements[1], id: id(30), amount: 30, createdAt: '2026-01-13T10:00:00Z' });
    for (const differenceState of ['balanced', 'difference']) {
        f.req.query = { differenceState }; assert.equal((await run(f.req)).body.data.total, 0);
    }
    f.req.query = { differenceState: 'changed' }; assert.equal((await run(f.req)).body.data.total, 2);
});
it('preview recognizes an explicit non-cash code on a legacy unspecified method', async t => {
    const f = fixture(t); f.req.query = { accountId, closedOn: '2026-01-11' };
    f.movements[1].paymentMethodId = id(60); f.methods.push({ id: id(60), type: 'OTHER', code: 'BANK_TRANSFER' });
    assert.equal((await run(f.req, previewDailyClosing)).body.data.warnings.length, 1);
});