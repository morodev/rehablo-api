import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    appointmentEndAt,
    shouldAutoCompleteAppointment,
    shouldOpenAttendanceCorrection
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

describe('automatic appointment completion eligibility', () => {
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

    it('completes the appointment only after it has ended', () => {
        assert.equal(
            shouldAutoCompleteAppointment(appointment(), new Date('2026-09-01T08:59:59.000Z')),
            false
        );
        assert.equal(
            shouldAutoCompleteAppointment(appointment(), new Date('2026-09-01T09:00:00.000Z')),
            true
        );
    });

    it('does not override an explicit action or a final appointment state', () => {
        const now = new Date('2026-09-01T09:05:00.000Z');
        assert.equal(shouldAutoCompleteAppointment(appointment({ missedArrivalReportedAt: now }), now), false);
        assert.equal(shouldAutoCompleteAppointment(appointment({ status: 'COMPLETED' }), now), false);
        assert.equal(shouldAutoCompleteAppointment(appointment({ status: 'NO_SHOW' }), now), false);
        assert.equal(shouldAutoCompleteAppointment(appointment({ status: 'CANCELLED' }), now), false);
        assert.equal(shouldAutoCompleteAppointment(appointment({ recurrence: 'FREQ=WEEKLY' }), now), false);
        assert.equal(shouldAutoCompleteAppointment(appointment({ patientId: null }), now), false);
        assert.equal(
            shouldAutoCompleteAppointment(appointment({ patientId: undefined, patient: { id: 'legacy-patient' } }), now),
            true
        );
    });

    it('opens an attendance correction when an ended appointment is manually reopened', () => {
        const completed = appointment({ status: 'COMPLETED' });

        assert.equal(
            shouldOpenAttendanceCorrection(completed, 'CONFIRMED', new Date('2026-09-01T09:05:00.000Z')),
            true
        );
        assert.equal(
            shouldOpenAttendanceCorrection(completed, 'CONFIRMED', new Date('2026-09-01T08:59:59.000Z')),
            false
        );
        assert.equal(
            shouldOpenAttendanceCorrection(appointment(), 'CONFIRMED', new Date('2026-09-01T09:05:00.000Z')),
            false
        );
    });
});
