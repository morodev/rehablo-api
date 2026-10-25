import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AppointmentAdjustmentError, resolveAppointmentPricing} from './appointmentAdjustment.js';

test('a price agreement does not confirm old receipts; confirmation can be submitted separately', () => {
    const priced = resolveAppointmentPricing(null, {adjustment: null, baseAmount: 65.5}, 0, null, false);
    assert.equal(priced.amount, 65.5);
    assert.equal(priced.originalAmount, 65.5);
    assert.equal(priced.historyKnown, false);
    assert.equal(resolveAppointmentPricing(65.5, {adjustment: null, confirmHistory: true}, 0, null, false).historyKnown, true);
    assert.equal(resolveAppointmentPricing(65.5, {adjustment: null, confirmHistory: false}, 0, null, true).historyKnown, true);
});

test('manual prices accept valid customer totals only and cannot overwrite an existing agreement', () => {
    for (const baseAmount of [null, '', '50', 0, -1, NaN, Infinity, 0.001, 10.123, 100000000]) {
        assert.throws(() => resolveAppointmentPricing(null, {adjustment: null, baseAmount}, 0, null, false), AppointmentAdjustmentError);
    }
    assert.throws(() => resolveAppointmentPricing(50, {adjustment: null, baseAmount: 40}, 0, null, true),
        (error: any) => error.status === 409);
    for (const confirmHistory of [null, 'true', 1]) {
        assert.throws(() => resolveAppointmentPricing(50, {adjustment: null, confirmHistory}, 0, null, false));
    }
    assert.equal(resolveAppointmentPricing(null, {adjustment: null, baseAmount: 0.01}, 0, null, true).amount, 0.01);
});

test('discounts and gifts preserve receipts and do not implicitly verify historical sessions', () => {
    assert.equal(resolveAppointmentPricing(null, {adjustment: 'DISCOUNT', baseAmount: 100, discountAmount: 20}, 30, 0, false).amount, 80);
    assert.throws(() => resolveAppointmentPricing(null, {adjustment: null, baseAmount: 20}, 30, null, true), /inferiore agli incassi/);
    assert.throws(() => resolveAppointmentPricing(null, {adjustment: 'COMPLIMENTARY'}, 1, null, false), /inferiore agli incassi/);
    const gift = resolveAppointmentPricing(null, {adjustment: 'COMPLIMENTARY'}, 0, null, false);
    assert.equal(gift.amount, 0);
    assert.equal(gift.originalAmount, null);
    assert.equal(gift.historyKnown, false);
});
