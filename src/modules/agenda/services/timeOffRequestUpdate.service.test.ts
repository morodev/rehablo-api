import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasTimeOffRequestContentChanges } from './timeOffRequestUpdate.service.js';

const current = {
    type: 'VACATION',
    start: new Date('2026-09-10T08:00:00.000Z'),
    end: new Date('2026-09-12T18:00:00.000Z'),
    allDay: true,
    reason: 'Ferie estive'
};

describe('time-off request content changes', () => {
    it('keeps an approved request closed when the PATCH contains the same values', () => {
        assert.equal(hasTimeOffRequestContentChanges(current, {
            ...current,
            start: '2026-09-10T08:00:00.000Z',
            end: '2026-09-12T18:00:00.000Z',
            reason: '  Ferie estive  '
        }), false);
    });

    it('detects changes that require a new approval', () => {
        assert.equal(hasTimeOffRequestContentChanges(current, {
            ...current,
            end: new Date('2026-09-13T18:00:00.000Z')
        }), true);
        assert.equal(hasTimeOffRequestContentChanges(current, {
            ...current,
            reason: 'Periodo modificato'
        }), true);
    });
});
