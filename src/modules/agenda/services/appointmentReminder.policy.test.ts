import assert from 'node:assert/strict';
import {it} from 'node:test';
import {reminderOccurrence, reminderAvailability, reminderMessage, summarizeAppointmentReminders,
    REMINDER_PENDING_TTL_MS, REMINDER_UNKNOWN_ERROR} from './appointmentReminder.policy.js';

const start = '2026-10-29T09:00:00.000Z';
const now = Date.parse('2026-10-28T10:00:00Z');
const event = {id: 'event', patientId: 'patient', structureId: 'structure', status: 'CONFIRMED', start};
const patient = {id: 'patient', name: 'Mario', emails: [{email: 'mario@example.test'}], phoneNumbers: [{phoneNumber: '3331234567', country: 'it'}]};

it('reminders read live channel refusals, allow null consent and explain missing contacts', () => {
    const occurrence = reminderOccurrence(event, null);
    assert.equal(reminderAvailability(event, patient, occurrence, 'whatsapp', now).recipient, '+393331234567');
    assert.equal(reminderAvailability(event, {...patient, whatsappNotificationsConsent: false}, occurrence, 'whatsapp', now).available, false);
    assert.equal(reminderAvailability(event, {...patient, emailNotificationsConsent: null}, occurrence, 'email', now).available, true);
    assert.match(reminderAvailability(event, {...patient, emails: []}, occurrence, 'email', now).unavailableReason!, /mancante/);
    for (const status of ['COMPLETED', 'CANCELLED', 'NO_SHOW']) assert.equal(reminderAvailability({...event, status}, patient, occurrence, 'email', now).available, false);
    assert.equal(reminderAvailability(event, patient, occurrence, 'email', Date.parse(start) + 1).available, false);
    assert.equal(reminderAvailability(event, null, occurrence, 'email', now).available, false);
});

it('recurrences validate the concrete occurrence and DST without treating series end as appointment time', () => {
    const recurring = {...event, start: '2026-10-23T08:00:00Z', end: '2026-11-27T23:00:00Z', recurrence: 'FREQ=WEEKLY;BYDAY=FR', duration: 45};
    const occurrence = reminderOccurrence(recurring, '2026-10-30T09:00:00Z');
    assert.equal(occurrence.occurrenceStart, '2026-10-30T09:00:00.000Z');
    assert.throws(() => reminderOccurrence(recurring, '2026-10-30T08:00:00Z'), /non è più disponibile/);
    assert.throws(() => reminderOccurrence(recurring, null), /singola occorrenza/);
    assert.throws(() => reminderOccurrence(recurring, occurrence.start, [{eventId: event.id, exdate: occurrence.start}]), /non è più disponibile/);
    assert.throws(() => reminderOccurrence(event, '2026-10-30T09:00:00Z'), /cambiato/);
});

it('messages contain only patient name, appointment date/time and premise', () => {
    const message = reminderMessage({...patient, diagnosis: 'Dato clinico'}, reminderOccurrence(event, null), 'Studio Centro');
    assert.match(message, /Ciao Mario/);
    assert.match(message, /29 ottobre alle 10:00 presso Studio Centro/);
    assert.doesNotMatch(message, /Dato clinico|patient|event/);
});

it('failed resend preserves channel success and does not affect another occurrence or changed patient', () => {
    const occurrence = reminderOccurrence(event, null);
    const base = {agendaEventId: event.id, occurrenceKey: occurrence.occurrenceKey, snapshotHash: occurrence.snapshotHash};
    const deliveries = [
        {...base, channel: 'email', status: 'SENT', sentAt: '2026-10-28T08:00:00Z', createdAt: '2026-10-28T08:00:00Z'},
        {...base, channel: 'email', status: 'FAILED', lastError: 'Riprova', createdAt: '2026-10-28T09:00:00Z'},
        {...base, channel: 'whatsapp', status: 'OPENED', openedAt: '2026-10-28T09:20:00Z', createdAt: '2026-10-28T09:20:00Z'},
        {...base, occurrenceKey: 'other', channel: 'email', sentAt: '2026-10-28T09:50:00Z', createdAt: '2026-10-28T09:50:00Z'}
    ];
    const summary = summarizeAppointmentReminders(event, patient, occurrence, deliveries, now);
    assert.equal(summary.email.lastSentAt, '2026-10-28T08:00:00.000Z');
    assert.equal(summary.email.error, 'Riprova');
    assert.equal(summary.whatsapp.lastOpenedAt, '2026-10-28T09:20:00.000Z');
    const changed = reminderOccurrence({...event, patientId: 'other-patient'}, null);
    assert.equal(summarizeAppointmentReminders(event, patient, changed, deliveries, now).email.lastSentAt, null);
});

it('stale in-flight delivery becomes uncertain without pretending failure or blocking indefinitely', () => {
    const occurrence = reminderOccurrence(event, null);
    const delivery = {agendaEventId: event.id, occurrenceKey: occurrence.occurrenceKey, snapshotHash: occurrence.snapshotHash,
        channel: 'email', status: 'PENDING', createdAt: new Date(now - REMINDER_PENDING_TTL_MS - 1)};
    const summary = summarizeAppointmentReminders(event, patient, occurrence, [delivery], now);
    assert.equal(summary.email.pending, false);
    assert.equal(summary.email.error, REMINDER_UNKNOWN_ERROR);
    assert.equal(summary.email.lastSentAt, null);
    delivery.createdAt = new Date(now - 100);
    assert.equal(summarizeAppointmentReminders(event, patient, occurrence, [delivery], now).email.pending, true);
});
