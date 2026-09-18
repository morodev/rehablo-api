import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {agendaDateBoundary, expandAgendaSearchOccurrences} from './agendaSearch.service.js';

function recurringEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: '00000000-0000-4000-8000-000000000001',
        patientId: '00000000-0000-4000-8000-000000000002',
        start: '2026-01-05T09:00:00.000Z',
        end: '2026-01-19T09:00:00.000Z',
        duration: '60',
        recurrence: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO',
        ...overrides
    };
}

describe('agenda search occurrence expansion', () => {
    it('returns concrete recurring occurrences and honors exceptions', () => {
        const occurrences = expandAgendaSearchOccurrences(
            [recurringEvent()],
            [{
                eventId: '00000000-0000-4000-8000-000000000001',
                exdate: '2026-01-12T09:00:00.000Z'
            }]
        );

        assert.deepEqual(
            occurrences.map((event) => event.start),
            ['2026-01-05T09:00:00.000Z', '2026-01-19T09:00:00.000Z']
        );
        assert.ok(occurrences.every((event) => event.agendaEventId === recurringEvent().id));
        assert.ok(occurrences.every((event) => event.recurringEventId === recurringEvent().id));
    });

    it('keeps the Rome local time stable across daylight saving time', () => {
        const occurrences = expandAgendaSearchOccurrences([
            recurringEvent({
                start: '2026-03-23T09:00:00.000Z',
                end: '2026-04-06T08:00:00.000Z'
            })
        ], []);

        assert.deepEqual(
            occurrences.map((event) => event.start),
            [
                '2026-03-23T09:00:00.000Z',
                '2026-03-30T08:00:00.000Z',
                '2026-04-06T08:00:00.000Z'
            ]
        );
    });

    it('applies date boundaries to standalone appointments', () => {
        const occurrences = expandAgendaSearchOccurrences([
            {...recurringEvent({id: 'one', recurrence: null, start: '2026-01-05T09:00:00.000Z', end: '2026-01-05T10:00:00.000Z'})},
            {...recurringEvent({id: 'two', recurrence: null, start: '2026-02-05T09:00:00.000Z', end: '2026-02-05T10:00:00.000Z'})}
        ], [], new Date('2026-02-01T00:00:00.000Z'));

        assert.deepEqual(occurrences.map((event) => event.id), ['two']);
        assert.equal(occurrences[0].agendaEventId, 'two');
    });

    it('builds Rome day boundaries with the correct daylight-saving offset', () => {
        assert.equal(agendaDateBoundary('2026-01-15', false)?.toISOString(), '2026-01-14T23:00:00.000Z');
        assert.equal(agendaDateBoundary('2026-07-15', false)?.toISOString(), '2026-07-14T22:00:00.000Z');
        assert.equal(agendaDateBoundary('2026-07-15', true)?.toISOString(), '2026-07-15T21:59:59.999Z');
        assert.equal(agendaDateBoundary('2026-02-31', false), null);
    });
});
