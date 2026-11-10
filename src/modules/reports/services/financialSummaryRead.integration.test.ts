import assert from 'node:assert/strict';
import {it} from 'node:test';

const databaseUrl = process.env.PERFORMANCE_TEST_DATABASE_URL;
it('SQL summary equals the ledger projection across DST, historic reversals, transfers, null legacy values and fresh snapshots',
    {skip: !databaseUrl}, async () => {
    const target = new URL(databaseUrl!);
    assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname));
    assert.equal(target.port, '5548');
    assert.equal(target.pathname, '/rehablo_performance_financial_test');
    process.env.DATABASE_URL = databaseUrl; process.env.DB_SSL = 'false';
    const {sequelize} = await import('../../../config/database.js');
    (sequelize as any).options.logging = false;
    const {Sequelize, QueryTypes} = await import('sequelize');
    const {loadTreasurySummaries} = await import('./financialSummaryRead.service.js');
    const {treasuryProjection} = await import('./financialReporting.service.js');
    const {withReportReadSnapshot} = await import('./reportReadContext.js');
    const schema = 'performance_summary_' + process.pid + '_' + Date.now();
    const table = '"' + schema + '".treasury_movements';
    const uuid = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
    const site = uuid(1), other = uuid(2), account = uuid(3);
    const scope: any = {tenantId: uuid(4), userId: uuid(5), scope: 'assigned', selectedStructureIds: [site],
        allowedStructureIds: [site], structures: [{id: site, name: 'Synthetic'}]};
    const req: any = {tenantSchema: schema, query: {}, reportScope: scope};
    const rows: any[] = [
        {id: 10, direction: 'IN', amount: 100, status: 'VOID', occurredAt: '2026-03-29T08:00:00Z'},
        {id: 11, direction: 'OUT', amount: 100, reversalOfId: 10, occurredAt: '2026-04-01T08:00:00Z'},
        {id: 12, direction: 'IN', amount: 80, status: 'VOID', occurredAt: '2026-03-29T08:00:00Z'},
        {id: 13, direction: 'OUT', amount: 80, structureId: other, reversalOfId: 12, occurredAt: '2026-04-01T08:00:00Z'},
        {id: 14, direction: 'IN', amount: 7, occurredAt: '2026-03-28T23:30:00Z'},
        {id: 15, direction: 'IN', amount: 9, occurredAt: '2026-03-29T22:30:00Z'},
        {id: 16, direction: 'IN', amount: 500, sourceType: 'TRANSFER_IN', occurredAt: '2026-03-29T08:00:00Z'},
        {id: 17, direction: 'OUT', amount: 500, sourceType: 'TRANSFER_OUT', occurredAt: '2026-03-29T08:00:00Z'},
        {id: 18, direction: 'IN', amount: 30, sourceType: 'PATIENT_ADVANCE', occurredAt: '2026-03-29T08:00:00Z'},
        {id: 19, direction: 'OUT', amount: 10, sourceType: 'PATIENT_ADVANCE_VOID', occurredAt: '2026-03-29T08:00:00Z'},
        {id: 20, direction: 'OUT', amount: 8, sourceType: 'PATIENT_CREDIT_REFUND', occurredAt: '2026-03-29T08:00:00Z'},
        {id: 21, direction: 'IN', amount: 3, sourceType: 'PATIENT_REFUND_VOID', occurredAt: '2026-03-29T08:00:00Z'},
        {id: 22, direction: 'IN', amount: 15, status: 'VOID', accountId: null, occurredAt: '2026-03-29T08:00:00Z'},
        {id: 23, direction: 'OUT', amount: 15, accountId: null, reversalOfId: 22, occurredAt: '2026-04-01T08:00:00Z'},
        {id: 24, direction: 'IN', amount: 400, status: 'VOID', occurredAt: '2026-03-29T08:00:00Z'}
    ];
    const writer = new Sequelize(databaseUrl!, {logging: false});
    try {
        await sequelize.query('CREATE SCHEMA "' + schema + '"');
        await sequelize.query('CREATE TABLE ' + table + ' (id uuid PRIMARY KEY, "structureId" uuid, "accountId" uuid, direction text, amount numeric(12,2), status text, "occurredAt" timestamptz, "sourceType" text, "reversalOfId" uuid)');
        await sequelize.query('CREATE TABLE "' + schema + '".expenses (id uuid PRIMARY KEY, "structureId" uuid, amount numeric(12,2), status text, "incurredAt" date)');
        for (const row of rows) await sequelize.query('INSERT INTO ' + table + ' VALUES (:id,:structureId,:accountId,:direction,:amount,:status,:occurredAt,:sourceType,:reversalOfId)',
            {replacements: {id: uuid(row.id), structureId: row.structureId ?? site,
                accountId: Object.hasOwn(row, 'accountId') ? row.accountId : account, direction: row.direction,
                amount: row.amount, status: row.status ?? 'POSTED', occurredAt: row.occurredAt,
                sourceType: row.sourceType ?? null, reversalOfId: row.reversalOfId ? uuid(row.reversalOfId) : null}});
        await sequelize.query('INSERT INTO "' + schema + '".expenses VALUES (:a,:site,20,\'OPEN\',\'2026-03-29\'),(:b,:site,7,\'cancelled\',\'2026-03-29\'),(:c,:site,5,NULL,\'2026-03-29\'),(:d,:other,200,\'OPEN\',\'2026-03-29\')',
            {replacements: {a: uuid(100), b: uuid(101), c: uuid(102), d: uuid(103), site, other}});
        await sequelize.query('INSERT INTO ' + table + ' SELECT md5(n::text)::uuid, :site::uuid, :account::uuid, \'IN\', 1, \'POSTED\', \'2020-01-01\'::timestamptz, NULL, NULL FROM generate_series(1,10000) n',
            {replacements: {site, account}});
        const periods = [{key: 'current', from: '2026-03-29', to: '2026-03-29'}, {key: 'previous', from: '2026-04-01', to: '2026-04-01'}];
        const movements = await sequelize.query<Record<string, any>>('SELECT * FROM ' + table + ' WHERE "structureId"=:site', {type: QueryTypes.SELECT, replacements: {site}});
        const expenses = await sequelize.query<Record<string, any>>('SELECT * FROM "' + schema + '".expenses WHERE "structureId"=:site', {type: QueryTypes.SELECT, replacements: {site}});
        const summaries = await withReportReadSnapshot(req, snapshot => loadTreasurySummaries(snapshot, scope, periods));
        for (const period of periods) {
            const reference = treasuryProjection(movements, expenses, period.from, period.to);
            const {rows: _rows, costs: _costs, ...expected} = reference;
            assert.deepEqual(summaries.get(period.key), expected);
        }
        assert.equal(summaries.size, 2, 'the database returns aggregates, not 10,000 ledger rows');
        const before = summaries.get('current')!.income;
        await withReportReadSnapshot(req, async snapshot => {
            const first = await loadTreasurySummaries(snapshot, scope, periods);
            await writer.query('INSERT INTO ' + table + ' VALUES (:id,:site,:account,\'IN\',25,\'POSTED\',\'2026-03-29T10:00:00Z\',NULL,NULL)',
                {replacements: {id: uuid(99999), site, account}});
            const sameSnapshot = await loadTreasurySummaries(snapshot, scope, periods);
            assert.deepEqual(sameSnapshot, first);
        });
        const fresh = await withReportReadSnapshot(req, snapshot => loadTreasurySummaries(snapshot, scope, periods));
        assert.equal(fresh.get('current')!.income, before + 25, 'the next request sees committed writes immediately');
        assert.deepEqual(await loadTreasurySummaries(req, {...scope, selectedStructureIds: []}, periods),
            new Map(periods.map(period => [period.key, {income: 0, outcome: 0, cashFlow: 0, advances: 0, creditRefunds: 0, expenses: 0}])));
    } finally {
        await writer.close();
        if (!/^performance_summary_[0-9]+_[0-9]+$/.test(schema)) throw new Error('Unsafe test schema cleanup');
        await sequelize.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
        await sequelize.close();
    }
});
