import test from 'node:test';
import assert from 'node:assert/strict';
import {
    contactChannelAllowed,
    firstUsableEmail,
    shouldSendAppointmentEmail
} from './contactConsent';

test('un consenso mai chiesto non blocca il canale', () => {
    // Le anagrafiche esistenti hanno null: devono continuare a ricevere le conferme.
    assert.equal(contactChannelAllowed(null), true);
    assert.equal(contactChannelAllowed(undefined), true);
});

test('solo il rifiuto esplicito blocca il canale', () => {
    assert.equal(contactChannelAllowed(false), false);
    assert.equal(contactChannelAllowed(true), true);
});

test('firstUsableEmail ignora voci vuote e non stringhe', () => {
    assert.equal(firstUsableEmail([{ email: '   ' }, { email: null }, { email: ' a@b.it ' }]), 'a@b.it');
    assert.equal(firstUsableEmail([]), null);
    assert.equal(firstUsableEmail(null), null);
    assert.equal(firstUsableEmail('a@b.it'), null);
});

test('la mail di conferma parte se c-è un indirizzo e nessun rifiuto', () => {
    assert.equal(shouldSendAppointmentEmail({ emails: [{ email: 'a@b.it' }] }, null), true);
    assert.equal(shouldSendAppointmentEmail({ emails: [{ email: 'a@b.it' }] }, true), true);
});

test('la mail di conferma non parte se il paziente ha rifiutato', () => {
    assert.equal(shouldSendAppointmentEmail({ emails: [{ email: 'a@b.it' }] }, false), false);
});

test('senza indirizzo non si invia, qualunque sia il consenso', () => {
    assert.equal(shouldSendAppointmentEmail({ emails: [] }, true), false);
    assert.equal(shouldSendAppointmentEmail({}, true), false);
    assert.equal(shouldSendAppointmentEmail(null, true), false);
});
