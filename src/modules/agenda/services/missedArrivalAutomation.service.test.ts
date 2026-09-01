import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    appointmentEndAt,
    shouldAutoReportMissedArrival
} from './missedArrivalAutomation.service.js';

const appointment = (overrides: Record<string, unknown> = {}) => ({
    start: '2026-09-01T08:00:00.000Z',
    end: '2026-09-01T09:00:00.000Z',
    duration: '60',
    status: 'CONFIRMED',
    recurrence: null,
    recurringEventId: null,
    invoiceId: null,
    patientId: 'patient-1',
    patient: null,
    missedArrivalReportedAt: null,
    ...overrides
});

describe('automatic missed-arrival eligibility', () => {
    it('uses the explicit appointment end', () => {
        assert.equal(
            appointmentEndAt(appointment())?.toISOString(),
            '2026-09-01T09:00:00.000Z'
        );
    });

    it('falls back to the configured duration when end is missing', () => {
        assert.equal(
            appointmentEndAt(appointment({ end: null, duration: '45' }))?.toISOString(),
            '2026-09-01T08:45:00.000Z'
        );
    });

    it('opens the report only after the appointment has ended', () => {
        assert.equal(
            shouldAutoReportMissedArrival(appointment(), new Date('2026-09-01T08:59:59.000Z')),
            false
        );
        assert.equal(
            shouldAutoReportMissedArrival(appointment(), new Date('2026-09-01T09:00:00.000Z')),
            true
        );
    });

    it('does not override an explicit action or a final appointment state', () => {
        const now = new Date('2026-09-01T09:05:00.000Z');
        assert.equal(shouldAutoReportMissedArrival(appointment({ missedArrivalReportedAt: now }), now), false);
        assert.equal(shouldAutoReportMissedArrival(appointment({ status: 'COMPLETED' }), now), false);
        assert.equal(shouldAutoReportMissedArrival(appointment({ status: 'NO_SHOW' }), now), false);
        assert.equal(shouldAutoReportMissedArrival(appointment({ recurrence: 'FREQ=WEEKLY' }), now), false);
        assert.equal(shouldAutoReportMissedArrival(appointment({ patientId: null }), now), false);
        assert.equal(
            shouldAutoReportMissedArrival(appointment({ patientId: undefined, patient: { id: 'legacy-patient' } }), now),
            true
        );
    });
});
