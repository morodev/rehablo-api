import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {deliveryStillCurrent, dueExternalAlert} from './reminderExternalDelivery.policy.js';

const activation = new Date('2026-10-10T09:00:00.000Z');
const now = new Date('2026-10-10T10:00:00.000Z');

describe('external reminder delivery policy', () => {
    it('does not email old overdue reminders at rollout', () => {
        assert.equal(dueExternalAlert({status: 'OPEN', dueAt: new Date('2026-10-09T09:00:00.000Z')}, null, activation, now), null);
    });

    it('sends a newly due alert and a later personal snooze, once each', () => {
        const reminder = {status: 'OPEN', remindAt: new Date('2026-10-10T09:30:00.000Z')};
        assert.equal(dueExternalAlert(reminder, null, activation, now)?.toISOString(), '2026-10-10T09:30:00.000Z');
        assert.equal(dueExternalAlert(reminder, new Date('2026-10-10T11:00:00.000Z'), activation, now), null);
        assert.equal(dueExternalAlert(reminder, new Date('2026-10-10T11:00:00.000Z'), activation,
            new Date('2026-10-10T11:00:00.000Z'))?.toISOString(), '2026-10-10T11:00:00.000Z');
    });

    it('skips completed, rescheduled and currently snoozed deliveries', () => {
        const base = new Date('2026-10-10T09:30:00.000Z');
        assert.equal(deliveryStillCurrent({status: 'DONE', remindAt: base}, base, null, now), false);
        assert.equal(deliveryStillCurrent({status: 'OPEN', remindAt: new Date('2026-10-10T12:00:00.000Z')}, base, null, now), false);
        assert.equal(deliveryStillCurrent({status: 'OPEN', remindAt: base}, base, new Date('2026-10-10T11:00:00.000Z'), now), false);
    });
});
