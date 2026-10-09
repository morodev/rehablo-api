import { StructureAvailability, StructureUser, StructureUserAvailability, User } from '../../auth/models/index.js';
import TimeOffRequest from '../../agenda/models/timeOffRequest.model.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    AnalyticsQuery,
    ReportOccurrence,
    aggregateActivity,
    comparisonRange,
    documentDiscountRatio,
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

describe('analytics no-show accounting', () => {
    const occurrence = (overrides: Partial<ReportOccurrence>): ReportOccurrence => ({
        id: 'event-1',
        sourceEventId: 'event-1',
        occurrenceKey: '2026-08-10T08:00:00.000Z',
        start: new Date('2026-08-10T08:00:00.000Z'),
        end: new Date('2026-08-10T09:00:00.000Z'),
        durationMinutes: 60,
        status: 'NO_SHOW',
        calendarId: null,
        structureId: null,
        patientId: 'patient-1',
        eventTypeId: null,
        invoiceId: null,
        noShowBillingDecision: 'PENDING',
        title: 'Terapia',
        patientName: 'Mario Rossi',
        ...overrides
    });

    it('separates invoiced, waived and pending no-shows without counting delivered minutes', async () => {
        const result = await aggregateActivity('unused', query({from: '2026-08-10', to: '2026-08-10'}), [
            occurrence({id: 'pending'}),
            occurrence({id: 'waived', noShowBillingDecision: 'WAIVED'}),
            occurrence({id: 'invoiced', invoiceId: 'invoice-1'})
        ]);

        assert.equal(result.totals.noShow, 3);
        assert.equal(result.totals.noShowPendingBilling, 1);
        assert.equal(result.totals.noShowWaived, 1);
        assert.equal(result.totals.noShowInvoiced, 1);
        assert.equal(result.totals.deliveredMinutes, 0);
    });
});

describe('catalog revenue allocation', () => {
    it('does not apply an appointment concession twice', () => {
        assert.equal(25 * documentDiscountRatio(25, 25), 25);
        assert.equal(25 * documentDiscountRatio(20, 25), 20);
    });
});


describe('operator capacity by premise', () => {
    it('uses the selected premise schedule and keeps historical capacity when its agenda is disabled', async t => {
        const record = (row: any): any => ({...row, get: () => ({...row})});
        t.mock.method(User, 'findAll', (async () => [{id: 'operator', name: 'Anna', surname: 'Test', availabilityMode: 'INHERIT_STRUCTURE'}]) as any);
        t.mock.method(StructureUser, 'findAll', (async ({where}: any) => {
            assert.equal(where.calendarEnabled, undefined);
            return [{userId: 'operator', calendarEnabled: false, availabilityMode: where.structureId === 'a' ? 'CUSTOM' : 'INHERIT_STRUCTURE'}];
        }) as any);
        t.mock.method(StructureUserAvailability, 'findAll', (async ({where}: any) => where.structureId === 'a'
            ? [record({userId: 'operator', structureId: 'a', day: 0, enabled: true, rangeOneStart: '09:00', rangeOneFinish: '12:00'})] : []) as any);
        t.mock.method(StructureAvailability, 'findAll', (async () => [record({day: 0, enabled: true, open: '08:00', close: '16:00'})]) as any);
        t.mock.method(TimeOffRequest, 'schema', (() => ({findAll: async () => []})) as any);
        const period = {from: '2026-10-05', to: '2026-10-05', operatorId: 'operator'};
        const first = await aggregateActivity('schema', query({...period, structureId: 'a'}), []);
        const second = await aggregateActivity('schema', query({...period, structureId: 'b'}), []);
        assert.equal(first.operators[0].availableMinutes, 180);
        assert.equal(second.operators[0].availableMinutes, 480);
        assert.equal(first.operators[0].operatorName, 'Anna Test');
    });
});
