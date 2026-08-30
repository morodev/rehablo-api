import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    AnalyticsQuery,
    comparisonRange,
    expandRecurringEvent,
    percentageChange
} from './analytics.service.js';

const query = (overrides: Partial<AnalyticsQuery> = {}): AnalyticsQuery => ({
    from: '2026-08-01',
    to: '2026-08-31',
    granularity: 'day',
    compare: 'none',
    structureId: null,
    operatorId: null,
    eventTypeId: null,
    ...overrides
});

describe('analytics recurrence expansion', () => {
    const recurringEvent = {
        id: 'series-1',
        start: '2026-08-03T08:00:00.000Z',
        end: '2026-08-31T23:59:59.000Z',
        duration: 60,
        recurrence: 'FREQ=WEEKLY;BYDAY=MO',
        status: 'COMPLETED',
        patientId: 'patient-1'
    };

    it('counts every occurrence of a recurring therapy in the selected period', () => {
        const rows = expandRecurringEvent(recurringEvent, new Set(), query());
        assert.equal(rows.length, 5);
        assert.equal(rows[0].durationMinutes, 60);
        assert.equal(rows[4].occurrenceKey, '2026-08-31T08:00:00.000Z');
    });

    it('excludes individual recurrence exceptions', () => {
        const rows = expandRecurringEvent(
            recurringEvent,
            new Set([Date.parse('2026-08-17T08:00:00.000Z')]),
            query()
        );
        assert.equal(rows.length, 4);
        assert.ok(rows.every((row) => row.occurrenceKey !== '2026-08-17T08:00:00.000Z'));
    });

    it('assigns appointments around UTC midnight to the Europe/Rome reporting day', () => {
        const rows = expandRecurringEvent({
            ...recurringEvent,
            id: 'single-1',
            start: '2026-07-31T22:30:00.000Z',
            end: '2026-07-31T23:30:00.000Z',
            duration: null,
            recurrence: null
        }, new Set(), query({from: '2026-08-01', to: '2026-08-01'}));
        assert.equal(rows.length, 1);
    });
});

describe('analytics comparisons', () => {
    it('builds an adjacent previous period with the same number of days', () => {
        assert.deepEqual(comparisonRange(query({
            from: '2026-08-10',
            to: '2026-08-16',
            compare: 'previous_period'
        })), query({
            from: '2026-08-03',
            to: '2026-08-09',
            compare: 'none'
        }));
    });

    it('clamps leap day when comparing with a non-leap previous year', () => {
        const result = comparisonRange(query({
            from: '2024-02-29',
            to: '2024-02-29',
            compare: 'previous_year'
        }));
        assert.equal(result?.from, '2023-02-28');
        assert.equal(result?.to, '2023-02-28');
    });

    it('returns null when a percentage variation has no meaningful baseline', () => {
        assert.equal(percentageChange(10, 0), null);
        assert.equal(percentageChange(120, 100), 20);
    });
});
