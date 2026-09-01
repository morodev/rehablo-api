import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeIdentityEmail } from './userEmail.model.js';

test('normalizeIdentityEmail normalizza maiuscole e spazi per l’identità globale', () => {
    assert.equal(normalizeIdentityEmail('  Paziente@Example.IT  '), 'paziente@example.it');
});

test('normalizeIdentityEmail rifiuta valori non testuali', () => {
    assert.equal(normalizeIdentityEmail(undefined), '');
    assert.equal(normalizeIdentityEmail(42), '');
});
