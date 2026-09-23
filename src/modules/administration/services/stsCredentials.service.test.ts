import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    loadStsCredentialsForTenant,
    maskStsCredentials,
    mergeStsCredentials,
} from './stsCredentials.service.js';

const tenantWith = (stsCredentials: any) => ({ administrationSettings: { fiscal: { stsCredentials } } });

describe('stsCredentials.service', () => {
    it('maschera i segreti, esponendo solo la loro presenza', () => {
        const stored = mergeStsCredentials(null, { username: 'studio1', password: 'segreta', pincode: '12345', live: true });
        const view = maskStsCredentials(tenantWith(stored));
        assert.equal(view.username, 'studio1');
        assert.equal(view.hasPassword, true);
        assert.equal(view.hasPincode, true);
        assert.equal(view.live, true);
        // Nessun segreto in chiaro nella vista.
        assert.equal((view as any).password, undefined);
        assert.equal((view as any).passwordEnc, undefined);
    });

    it('cifra i segreti e li rilegge decifrati per il gateway', () => {
        const stored = mergeStsCredentials(null, { username: 'studio1', password: 'segreta', pincode: '12345', live: true });
        assert.notEqual(stored.passwordEnc, 'segreta');
        const override = loadStsCredentialsForTenant(tenantWith(stored));
        assert.equal(override?.username, 'studio1');
        assert.equal(override?.password, 'segreta');
        assert.equal(override?.pincode, '12345');
        assert.equal(override?.live, true);
    });

    it('un campo segreto omesso o vuoto non cancella quello esistente', () => {
        const first = mergeStsCredentials(null, { username: 'studio1', password: 'segreta', pincode: '12345' });
        const second = mergeStsCredentials(tenantWith(first), { live: true });
        assert.equal(second.passwordEnc, first.passwordEnc);
        assert.equal(second.pincodeEnc, first.pincodeEnc);
        assert.equal(second.live, true);
        const third = mergeStsCredentials(tenantWith(second), { password: '   ' });
        assert.equal(third.passwordEnc, first.passwordEnc);
    });

    it('un null esplicito rimuove il segreto', () => {
        const first = mergeStsCredentials(null, { password: 'segreta', pincode: '12345' });
        const cleared = mergeStsCredentials(tenantWith(first), { password: null });
        assert.equal(cleared.passwordEnc, null);
        assert.equal(cleared.pincodeEnc, first.pincodeEnc);
    });

    it('senza credenziali restituisce null per il gateway', () => {
        assert.equal(loadStsCredentialsForTenant(null), null);
        assert.equal(loadStsCredentialsForTenant(tenantWith({})), null);
    });
});
