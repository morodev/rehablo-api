import assert from 'node:assert/strict';
import {test} from 'node:test';
import {analyzeTreasuryIntegrity} from './treasuryIntegrity.policy.js';

const payment = {id: 'p1', structureId: 's1', source: 'APPOINTMENT', status: 'POSTED', amount: 50, paidAt: '2026-10-01'};
const receipt = {id: 'm1', structureId: 's1', sourceType: 'INVOICE_PAYMENT', sourceId: 'p1', accountId: 'a1',
    amount: 50, direction: 'IN', status: 'POSTED', occurredAt: '2026-10-01'};
test('healthy receipt has no anomaly; using credit or package needs no new entry', () => {
    assert.equal(analyzeTreasuryIntegrity([payment], [receipt], ['a1']).total, 0);
    assert.equal(analyzeTreasuryIntegrity(['CREDIT', 'PACKAGE', 'OPENING_BALANCE'].map(source => ({...payment, source})), [], ['a1']).total, 0);
});
test('missing entry always needs the actual historic account, even with a known date', () => {
    const [issue] = analyzeTreasuryIntegrity([payment], [], ['current-default']).issues;
    assert.equal(issue.repair, 'RECEIPT');
    assert.equal(issue.needsAccount, true);
    assert.equal(issue.needsDate, false);
    assert.equal(issue.paidAt, '2026-10-01');
    assert.equal(analyzeTreasuryIntegrity([{...payment, paidAt: null}], [], []).issues[0].needsDate, true);
});
test('retained cash still needs a receipt while credit coverage must never create one', () => {
    assert.equal(analyzeTreasuryIntegrity([{...payment, status: 'CREDIT'}], [], []).issues[0].kind, 'MISSING_RECEIPT');
    const [issue] = analyzeTreasuryIntegrity([{...payment, source: 'CREDIT'}], [receipt], ['a1']).issues;
    assert.equal(issue.kind, 'UNEXPECTED_RECEIPT');
    assert.equal(issue.repair, null);
});
test('reversal can be rebuilt only from original account, exact amount and recorded void date', () => {
    const voided = {...payment, status: 'VOID', voidedAt: '2026-10-02'};
    assert.equal(analyzeTreasuryIntegrity([voided], [receipt], ['a1']).issues[0].repair, 'REVERSAL');
    assert.equal(analyzeTreasuryIntegrity([{...voided, voidedAt: null}], [receipt], ['a1']).issues[0].repair, null);
    const reversed = {...receipt, id: 'm2', direction: 'OUT', sourceType: 'INVOICE_PAYMENT_VOID', reversalOfId: 'm1'};
    assert.equal(analyzeTreasuryIntegrity([voided], [receipt, reversed], ['a1']).total, 0);
});
test('amount/date discrepancies and orphan accounts never get automatic repair', () => {
    const result = analyzeTreasuryIntegrity([payment], [{...receipt, amount: 75, occurredAt: '2026-10-03'}], []);
    assert.deepEqual(result.issues.map(issue => issue.kind), ['AMOUNT_MISMATCH', 'DATE_MISMATCH', 'ORPHAN_ACCOUNT']);
    assert.ok(result.issues.every(issue => issue.repair === null));
});
test('old paid expense is diagnosed without changing it to unpaid or inventing an outflow', () => {
    const expense = {id: 'e1', structureId: 's1', status: 'PAID', amount: 80, paidAt: null};
    assert.equal(analyzeTreasuryIntegrity([], [], [], [expense]).issues[0].kind, 'LEGACY_EXPENSE');
    assert.equal(expense.status, 'PAID');
    assert.equal(analyzeTreasuryIntegrity([], [{...receipt, expenseId: 'e1', sourceType: 'EXPENSE_PAYMENT'}], ['a1'], [expense]).total, 0);
});
test('evidence detects changed amounts or ledger before any repair is attempted', () => {
    const first = analyzeTreasuryIntegrity([payment], [], []).issues[0].evidenceVersion;
    const second = analyzeTreasuryIntegrity([{...payment, amount: 100}], [], []).issues[0].evidenceVersion;
    assert.notEqual(first, second);
});

const creditPayment = {...payment, id: 'p2', source: 'CREDIT', amount: 30};
const settlement = {id: 'sop1', structureId: 's1', result: {cashAmount: 50, creditAmount: 30,
    allocations: [{kind: 'APPOINTMENT', targetId: 'a1', paymentIds: ['p1', 'p2']}], openingBalances: []}};
const analyzeSettlement = (operation = settlement, rows = [payment, creditPayment]) =>
    analyzeTreasuryIntegrity(rows, [receipt], ['a1'], [], [], [], [], [operation]);

test('grouped settlement reconciles original cash and credit independently without duplicating cash for coverage', () => {
    const before = structuredClone(settlement);
    assert.equal(analyzeSettlement().total, 0);
    assert.deepEqual(settlement, before);
    const voided = [payment, creditPayment].map(row => ({...row, status: 'CREDIT'}));
    assert.equal(analyzeSettlement(settlement, voided).total, 0);
});

test('grouped settlement reports changed amounts, missing allocations and duplicate payment references without repair', () => {
    const scenarios = [
        {...settlement, result: {...settlement.result, cashAmount: 51}},
        {...settlement, result: {...settlement.result, creditAmount: 31}},
        {...settlement, result: {...settlement.result, allocations: [{...settlement.result.allocations[0], paymentIds: ['p1', 'absent']}]}},
        {...settlement, result: {...settlement.result, allocations: [...settlement.result.allocations, settlement.result.allocations[0]]}}
    ];
    for (const operation of scenarios) {
        const [issue] = analyzeSettlement(operation).issues;
        assert.equal(issue.kind, 'SETTLEMENT_ALLOCATION_MISMATCH');
        assert.equal(issue.settlementOperationId, 'sop1'); assert.equal(issue.repair, null);
    }
    const first = analyzeSettlement(scenarios[0]).issues[0].evidenceVersion;
    const changed = analyzeSettlement(scenarios[0], [{...payment, amount: 49}, creditPayment]).issues
        .find(issue => issue.kind === 'SETTLEMENT_ALLOCATION_MISMATCH')!.evidenceVersion;
    assert.notEqual(first, changed);
});

test('later voids retain the original grouped amount and opening balances do not become new cash', () => {
    const rows = [{...payment, status: 'VOID', voidedAt: '2026-10-02'}, {...creditPayment, status: 'VOID'}];
    assert.ok(analyzeSettlement(settlement, rows).issues.every(issue => issue.kind !== 'SETTLEMENT_ALLOCATION_MISMATCH'));
    const historicalOnly = {...settlement, result: {cashAmount: 0, creditAmount: 0, allocations: [],
        openingBalances: [{agendaEventId: 'old', paymentId: 'old-payment', after: {paidAmount: 50}}]}};
    assert.equal(analyzeTreasuryIntegrity([], [], [], [], [], [], [], [historicalOnly]).total, 0);
});
