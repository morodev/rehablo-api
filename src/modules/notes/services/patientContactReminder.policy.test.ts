import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CONTACT_REMINDER_SOURCE, contactReminderOccurrenceAt, dailyContactReminderAlertAt, hasUsablePatientContact, tomorrowContactReminderAt} from './patientContactReminder.policy.js';
import {deliveryStillCurrent, dueExternalAlert} from './reminderExternalDelivery.policy.js';

test('a valid email or phone completes contact collection, without treating nonempty garbage as contact', () => {
    for (const patient of [{emails: [{email: 'person@example.it'}]}, {phoneNumbers: [{phoneNumber: '333 1234567', country: 'it'}]}, {contactPhone: '06 12345678'}]) assert.equal(hasUsablePatientContact(patient), true);
    for (const patient of [{}, {emails: [{email: 'invalid'}]}, {phoneNumbers: [{phoneNumber: 'numero123456789'}]}, {phoneNumbers: [{phoneNumber: '123'}]}, {emails: [null], phoneNumbers: [null]}]) assert.equal(hasUsablePatientContact(patient), false);
});
test('tomorrow means the following Rome calendar day at 09:00 across both DST transitions', () => {
    assert.equal(tomorrowContactReminderAt(new Date('2026-03-28T11:00:00Z')).toISOString(), '2026-03-29T07:00:00.000Z');
    assert.equal(tomorrowContactReminderAt(new Date('2026-10-24T11:00:00Z')).toISOString(), '2026-10-25T08:00:00.000Z');
    assert.equal(tomorrowContactReminderAt(new Date('2026-10-26T23:30:00Z')).toISOString(), '2026-10-28T08:00:00.000Z');
});
test('daily alerts emit only the current day at or after 09:00, without an offline backlog', () => {
    const reminder = {sourceType: CONTACT_REMINDER_SOURCE, status: 'OPEN', remindAt: new Date('2026-10-27T08:00:00Z')};
    assert.equal(dailyContactReminderAlertAt(reminder, new Date('2026-10-26T12:00:00Z')), null);
    assert.equal(dailyContactReminderAlertAt(reminder, new Date('2026-10-29T07:59:00Z')), null);
    assert.equal(dailyContactReminderAlertAt(reminder, new Date('2026-10-29T12:00:00Z'))?.toISOString(), '2026-10-29T08:00:00.000Z');
    assert.equal(contactReminderOccurrenceAt(reminder, new Date('2026-10-26T12:00:00Z'))?.toISOString(), '2026-10-27T08:00:00.000Z');
    assert.equal(dailyContactReminderAlertAt({...reminder, status: 'DONE'}, new Date('2026-10-29T12:00:00Z')), null);
});
test('contact follow-ups are excluded from external discovery and an already queued delivery', () => {
    const date = new Date('2026-10-27T08:00:00Z');
    const reminder = {sourceType: CONTACT_REMINDER_SOURCE, status: 'OPEN', remindAt: date};
    assert.equal(dueExternalAlert(reminder, null, new Date('2026-10-26T08:00:00Z'), new Date('2026-10-27T12:00:00Z')), null);
    assert.equal(deliveryStillCurrent(reminder, date, null, new Date('2026-10-27T12:00:00Z')), false);
});
