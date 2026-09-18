import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {overlayCurrentPatients} from './currentPatientOverlay.service.js';

const patientId = '00000000-0000-4000-8000-000000000001';

describe('agenda current patient overlay', () => {
    it('replaces stale demographic and contact data with the current patient', () => {
        const events = [{
            id: 'event-1',
            title: 'Visita',
            patientId,
            patient: {
                id: patientId,
                name: 'Mario',
                surname: 'Vecchio',
                emails: [{email: 'old@example.test'}],
                phoneNumbers: [{phoneNumber: '111'}],
                whatsappNotificationsConsent: null,
                color: 'blue',
                snapshotOnly: 'preserved'
            }
        }];
        const currentPatients = [{
            id: patientId,
            name: 'Marco',
            surname: 'Nuovo',
            emails: [{email: 'new@example.test'}],
            phoneNumbers: [{phoneNumber: '222'}],
            whatsappNotificationsConsent: true,
            color: 'emerald'
        }];

        const [result] = overlayCurrentPatients(events, currentPatients);

        assert.equal(result.patient.name, 'Marco');
        assert.equal(result.patient.surname, 'Nuovo');
        assert.deepEqual(result.patient.emails, [{email: 'new@example.test'}]);
        assert.deepEqual(result.patient.phoneNumbers, [{phoneNumber: '222'}]);
        assert.equal(result.patient.whatsappNotificationsConsent, true);
        assert.equal(result.patient.color, 'emerald');
        assert.equal(result.patient.snapshotOnly, 'preserved');
        assert.equal(result.title, 'Visita');
        assert.notStrictEqual(result, events[0]);
        assert.equal(events[0].patient.name, 'Mario');
    });

    it('uses the nested legacy patient id and can restore a missing snapshot', () => {
        const [legacyResult, missingSnapshotResult] = overlayCurrentPatients([
            {id: 'legacy', patient: {id: patientId, name: 'Old'}},
            {id: 'missing-snapshot', patientId, patient: null}
        ], [{id: patientId, name: 'Current'}]);

        assert.equal(legacyResult.patient.name, 'Current');
        assert.equal(missingSnapshotResult.patient.name, 'Current');
    });

    it('keeps the stored snapshot when the current patient cannot be resolved', () => {
        const event = {id: 'event-1', patient: {id: 'legacy-placeholder', name: 'Storico'}};
        const [result] = overlayCurrentPatients([event], []);

        assert.strictEqual(result, event);
        assert.equal(result.patient.name, 'Storico');
    });
});