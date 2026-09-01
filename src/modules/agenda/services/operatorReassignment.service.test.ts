import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { recurrenceBoundary, recurrenceWithUntil } from './operatorReassignment.service.js';

describe('operator reassignment recurrence boundary', () => {
    const weeklySeries = {
        id: 'series-1',
        start: '2026-08-03T08:00:00.000Z',
        end: '2026-09-28T08:00:00.000Z',
        recurrence: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO'
    };

    it('separates a series at the first future occurrence and preserves a past side', () => {
        const boundary = recurrenceBoundary(
            weeklySeries,
            [],
            new Date('2026-08-12T12:00:00.000Z')
        );

        assert.ok(boundary?.previousStart);
        assert.equal(boundary.previousStart.toISOString(), '2026-08-10T08:00:00.000Z');
        assert.equal(boundary.nextStart.toISOString(), '2026-08-17T08:00:00.000Z');
    });

    it('does not reassign an occurrence excluded from the original series', () => {
        const boundary = recurrenceBoundary(
            weeklySeries,
            [new Date('2026-08-17T08:00:00.000Z')],
            new Date('2026-08-12T12:00:00.000Z')
        );

        assert.equal(boundary?.nextStart.toISOString(), '2026-08-24T08:00:00.000Z');
    });

    it('reports no historical side when the whole series is still in the future', () => {
        const boundary = recurrenceBoundary(
            weeklySeries,
            [],
            new Date('2026-08-01T00:00:00.000Z')
        );

        assert.equal(boundary?.previousStart, null);
        assert.equal(boundary?.nextStart.toISOString(), '2026-08-03T08:00:00.000Z');
    });

    it('normalizes COUNT and UNTIL to the new authoritative series end', () => {
        assert.equal(
            recurrenceWithUntil(
                'FREQ=WEEKLY;INTERVAL=2;COUNT=10;UNTIL=20261231T000000Z',
                new Date('2026-09-01T07:59:59.000Z')
            ),
            'FREQ=WEEKLY;INTERVAL=2;UNTIL=20260901T075959Z'
        );
    });

    it('keeps the local appointment time across the daylight-saving transition', () => {
        const boundary = recurrenceBoundary({
            id: 'dst-series',
            // 10:00 Europe/Rome while daylight-saving time is active.
            start: '2026-10-19T08:00:00.000Z',
            end: '2026-11-30T09:00:00.000Z',
            recurrence: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO'
        }, [], new Date('2026-10-20T00:00:00.000Z'));

        // On 26 October Italy is back to UTC+1: 10:00 local is therefore 09:00Z.
        assert.equal(boundary?.nextStart.toISOString(), '2026-10-26T09:00:00.000Z');
    });
});
