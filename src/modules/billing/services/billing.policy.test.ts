import assert from 'node:assert/strict';
import test from 'node:test';
import { assertUsageFits, billingAccessAllowed, changeKind, effectiveLimits, monthlyAmount, validateQuantities } from './billing.policy.js';

test('one base seat is included; 2 premises and 4 staff cost EUR 90', () => {
    assert.equal(monthlyAmount(1, 1), 1000);
    assert.equal(monthlyAmount(4, 2), 9000);
});
test('only integral positive quantities and changes in one direction are accepted', () => {
    for (const invalid of [0, -1, 1.5, '2', NaN, Infinity, 10001]) assert.throws(() => validateQuantities(invalid, 1));
    assert.equal(changeKind({ users: 1, structures: 1 }, { users: 2, structures: 2 }), 'increase');
    assert.equal(changeKind({ users: 4, structures: 2 }, { users: 3, structures: 2 }), 'decrease');
    assert.throws(() => changeKind({ users: 4, structures: 2 }, { users: 3, structures: 3 }));
    assert.throws(() => changeKind({ users: 1, structures: 1 }, { users: 1, structures: 1 }));
});
test('cannot remove occupied capacity and future reduction reserves those places immediately', () => {
    assert.throws(() => assertUsageFits({ users: 3, structures: 2 }, { users: 2, structures: 2 }));
    assert.deepEqual(effectiveLimits({ usersLimit: 5, structuresLimit: 3, scheduledChange: { users: 3, structures: 2 } }), { users: 3, structures: 2 });
    assert.deepEqual(effectiveLimits({ usersLimit: 5, structuresLimit: 3, scheduledChange: null }), { users: 5, structures: 3 });
});
test('legacy access is preserved; access requires confirmed payment and ends at paid expiry', () => {
    const now = Date.now();
    assert.equal(billingAccessAllowed(null, now), true);
    assert.equal(billingAccessAllowed({ status: 'active', paidThrough: new Date(now + 1) }, now), true);
    assert.equal(billingAccessAllowed({ status: 'past_due', paidThrough: new Date(now + 1) }, now), true);
    assert.equal(billingAccessAllowed({ status: 'active', paidThrough: null }, now), false);
    assert.equal(billingAccessAllowed({ status: 'active', paidThrough: new Date(now) }, now), false);
    for (const status of ['pending', 'canceled', 'incomplete', 'unpaid', 'paused']) assert.equal(billingAccessAllowed({ status, paidThrough: new Date(now + 60000) }, now), false);
});
