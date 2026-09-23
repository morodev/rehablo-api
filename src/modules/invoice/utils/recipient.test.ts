import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRecipientSnapshot } from './recipient.js';

describe('buildRecipientSnapshot', () => {
    it('congela il paziente come destinatario persona fisica', () => {
        const snapshot = buildRecipientSnapshot({
            name: 'Mario', surname: 'Rossi', fiscalCode: 'rssmra80a01h501u',
            address: 'Via Roma 1', emails: [{ email: 'mario@example.it' }],
        });
        assert.equal(snapshot?.kind, 'PERSON');
        assert.equal(snapshot?.firstName, 'Mario');
        assert.equal(snapshot?.lastName, 'Rossi');
        assert.equal(snapshot?.taxCode, 'rssmra80a01h501u');
        assert.equal(snapshot?.address, 'Via Roma 1');
        assert.equal(snapshot?.email, 'mario@example.it');
        assert.equal(snapshot?.country, 'IT');
        assert.equal(snapshot?.vatNumber, null);
    });

    it('estrae la prima email valorizzata da forme diverse', () => {
        assert.equal(buildRecipientSnapshot({ emails: ['a@b.it'] })?.email, 'a@b.it');
        assert.equal(buildRecipientSnapshot({ emails: [{ value: 'c@d.it' }] })?.email, 'c@d.it');
        assert.equal(buildRecipientSnapshot({ emails: [{ label: 'x' }, { address: 'e@f.it' }] })?.email, 'e@f.it');
        assert.equal(buildRecipientSnapshot({ emails: [] })?.email, null);
        assert.equal(buildRecipientSnapshot({ emails: null })?.email, null);
    });

    it('normalizza stringhe vuote a null', () => {
        const snapshot = buildRecipientSnapshot({ name: '  ', surname: '', fiscalCode: null });
        assert.equal(snapshot?.firstName, null);
        assert.equal(snapshot?.lastName, null);
        assert.equal(snapshot?.taxCode, null);
    });

    it('restituisce null senza paziente né intestatario', () => {
        assert.equal(buildRecipientSnapshot(null), null);
        assert.equal(buildRecipientSnapshot(undefined), null);
    });

    it('un billing party con partita IVA prevale come B2B', () => {
        const snapshot = buildRecipientSnapshot(
            { name: 'Mario', surname: 'Rossi' },
            {
                type: 'BUSINESS', businessName: 'Palestra Alfa Srl', vatNumber: '12345678901',
                address: 'Via Milano 9', city: 'Milano', province: 'MI', postalCode: '20100',
                sdiCode: 'ABCDEF1', pec: 'alfa@pec.it',
            }
        );
        assert.equal(snapshot?.kind, 'BUSINESS');
        assert.equal(snapshot?.businessName, 'Palestra Alfa Srl');
        assert.equal(snapshot?.vatNumber, '12345678901');
        assert.equal(snapshot?.city, 'Milano');
        assert.equal(snapshot?.province, 'MI');
        assert.equal(snapshot?.zipCode, '20100');
        assert.equal(snapshot?.sdiCode, 'ABCDEF1');
    });

    it('un billing party persona fisica resta PERSON', () => {
        const snapshot = buildRecipientSnapshot(null, {
            type: 'PERSON', firstName: 'Luca', lastName: 'Bianchi', taxCode: 'BNCLCU85M01H501Z',
        });
        assert.equal(snapshot?.kind, 'PERSON');
        assert.equal(snapshot?.firstName, 'Luca');
        assert.equal(snapshot?.vatNumber, null);
    });
});
