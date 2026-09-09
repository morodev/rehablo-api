import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isPubliclyShareableUrl } from './publicUrl.js';

describe('URL condivisibili all\'esterno', () => {

    test('accetta i domini pubblici', () => {
        assert.equal(isPubliclyShareableUrl('https://app.rehablo.it/#/fattura/abc'), true);
        assert.equal(isPubliclyShareableUrl('http://rehablo.it'), true);
        assert.equal(isPubliclyShareableUrl('https://studio.example.co.uk/#/fattura/abc'), true);
    });

    test('rifiuta localhost e gli host senza dominio', () => {
        assert.equal(isPubliclyShareableUrl('http://localhost:4200/#/fattura/abc'), false);
        assert.equal(isPubliclyShareableUrl('http://api.localhost:4200'), false);
        assert.equal(isPubliclyShareableUrl('http://rehablo-web:4200'), false);
        assert.equal(isPubliclyShareableUrl('http://nas.local/app'), false);
    });

    test('rifiuta gli indirizzi IP, che il telefono del paziente non raggiunge', () => {
        assert.equal(isPubliclyShareableUrl('http://192.168.1.10:4200/#/fattura/abc'), false);
        assert.equal(isPubliclyShareableUrl('http://127.0.0.1:3000'), false);
    });

    test('rifiuta i valori non utilizzabili come URL', () => {
        assert.equal(isPubliclyShareableUrl(''), false);
        assert.equal(isPubliclyShareableUrl(null), false);
        assert.equal(isPubliclyShareableUrl('rehablo.it'), false);
        assert.equal(isPubliclyShareableUrl('ftp://rehablo.it'), false);
    });
});
