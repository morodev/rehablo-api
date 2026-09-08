import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {resolveOverviewDate} from './reports.controller.js';

describe('dashboard economic overview date', () => {
    it('accepts today and past dates', () => {
        assert.equal(resolveOverviewDate(undefined, '2026-09-08'), '2026-09-08');
        assert.equal(resolveOverviewDate('2026-09-07', '2026-09-08'), '2026-09-07');
    });

    it('rejects invalid and future dates', () => {
        assert.throws(() => resolveOverviewDate('2026-02-30', '2026-09-08'), /non valida/);
        assert.throws(() => resolveOverviewDate('2026-09-09', '2026-09-08'), /non valida/);
    });
});
