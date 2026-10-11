import assert from 'node:assert/strict';
import {test} from 'node:test';
import {activityRetryAt, aggregateActivityPushTargets, classifyActivityDeliveryFailure, consentCoversSchedule} from './activityDelivery.policy.js';

test('only explicit provider rejection or failure before connection allows a retry', () => {
    for (const error of [{statusCode: 429}, {statusCode: 503}, {responseCode: 451}, {code: 'ECONNREFUSED'}, {code: 'ENOTFOUND'}])
        assert.equal(classifyActivityDeliveryFailure(error).kind, 'retry');
    for (const error of [{code: 'ETIMEDOUT'}, {code: 'ECONNRESET'}, new Error('possibly accepted')])
        assert.equal(classifyActivityDeliveryFailure(error).kind, 'uncertain');
    assert.equal(classifyActivityDeliveryFailure({statusCode: 403}).kind, 'failed');
    assert.equal(classifyActivityDeliveryFailure({responseCode: 550}).kind, 'failed');
    assert.equal(classifyActivityDeliveryFailure({statusCode: 410}).kind, 'gone');
});
test('five total attempts use exactly one, two, four and eight minute waits', () => {
    const now = new Date('2026-10-11T10:00:00Z');
    assert.deepEqual([1, 2, 3, 4].map(attempt => activityRetryAt(attempt, now)!.getTime() - now.getTime()), [60_000, 120_000, 240_000, 480_000]);
    assert.equal(activityRetryAt(5, now), null);
});
test('a newly enabled or renewed consent never covers an already due alert', () => {
    const due = new Date('2026-10-11T10:00:00Z');
    assert.equal(consentCoversSchedule(true, new Date(due.getTime() - 1), due), true);
    assert.equal(consentCoversSchedule(true, new Date(due.getTime() + 1), due), false);
    assert.equal(consentCoversSchedule(false, new Date(due.getTime() - 1), due), false);
    assert.equal(consentCoversSchedule(true, null, due), false);
});
test('pending devices finish independently before the channel reports partial uncertainty or failure', () => {
    assert.equal(aggregateActivityPushTargets(['SENT', 'PENDING', 'UNCERTAIN']), 'PENDING');
    assert.equal(aggregateActivityPushTargets(['SENT', 'UNCERTAIN']), 'UNCERTAIN');
    assert.equal(aggregateActivityPushTargets(['SENT', 'FAILED']), 'FAILED');
    assert.equal(aggregateActivityPushTargets(['SENT', 'CANCELLED']), 'SENT');
    assert.equal(aggregateActivityPushTargets([]), 'CANCELLED');
});
