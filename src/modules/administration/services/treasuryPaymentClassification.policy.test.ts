import assert from 'node:assert/strict';
import {it} from 'node:test';
import {treasuryClassificationAllocator, treasuryOperationSource} from './treasuryPaymentClassification.policy.js';

it('preserves omitted automation and an explicit unclassified category for every actual receipt', () => {
    assert.equal(treasuryClassificationAllocator(undefined, 70)(30), undefined);
    const choice = {businessCategoryId: null};
    assert.deepEqual(treasuryClassificationAllocator(choice, 70)(30), choice);
});

it('partitions mixed cash shares across obligations without duplicating category amounts', () => {
    const choice = {businessCategoryId: null, allocations: [
        {businessCategoryId: 'physio', amount: 60}, {businessCategoryId: 'products', amount: 40}]};
    const original = structuredClone(choice);
    const next = treasuryClassificationAllocator(choice, 100);
    assert.deepEqual(next(30)?.allocations, [{businessCategoryId: 'physio', amount: 18}, {businessCategoryId: 'products', amount: 12}]);
    assert.deepEqual(next(70)?.allocations, [{businessCategoryId: 'physio', amount: 42}, {businessCategoryId: 'products', amount: 28}]);
    assert.deepEqual(choice, original);
});

it('allocates every cent exactly once even when tiny partial receipts have several categories', () => {
    const next = treasuryClassificationAllocator({businessCategoryId: null, allocations: [
        {businessCategoryId: 'a', amount: 0.02}, {businessCategoryId: 'b', amount: 0.01}, {businessCategoryId: null, amount: 0.02}]}, 0.05);
    const totals = new Map<string | null, number>();
    for (let i = 0; i < 5; i++) {
        const allocations = next(0.01)!.allocations!;
        assert.equal(allocations.reduce((sum, row) => sum + Math.round(row.amount * 100), 0), 1);
        for (const row of allocations) totals.set(row.businessCategoryId, (totals.get(row.businessCategoryId) ?? 0) + Math.round(row.amount * 100));
    }
    assert.deepEqual(Object.fromEntries([...totals].map(([key, value]) => [String(key), value])), {a: 2, null: 2, b: 1});
    assert.throws(() => next(0.01), /Ripartizione/);
});

it('rejects shares for the full debt when only part is new cash', () => {
    assert.throws(() => treasuryClassificationAllocator({businessCategoryId: null,
        allocations: [{businessCategoryId: 'a', amount: 100}]}, 60), /nuovo incasso/);
});

it('keeps default categories for incoming and outgoing manual money distinct', () => {
    assert.equal(treasuryOperationSource('OTHER', 'IN'), 'MANUAL_IN');
    assert.equal(treasuryOperationSource('OTHER', 'OUT'), 'MANUAL_OUT');
    assert.equal(treasuryOperationSource('PATIENT_CREDIT_REFUND', 'OUT'), 'PATIENT_REFUND');
    assert.equal(treasuryOperationSource('COLLECTION', 'IN'), 'INVOICE_PAYMENT');
});
