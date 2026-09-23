import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { env } from '../../../config/env.js';
import { resolveTransmissionGateway } from './fiscalGatewayFactory.js';

const fiscal = env.fiscal;
const original = { ...fiscal };
afterEach(() => Object.assign(fiscal, original));

describe('resolveTransmissionGateway', () => {
    it('con trasmissione disabilitata usa MOCK per entrambi i canali', () => {
        fiscal.transmissionEnabled = false;
        assert.equal(resolveTransmissionGateway('SDI').gateway.provider, 'MOCK');
        assert.equal(resolveTransmissionGateway('STS').gateway.provider, 'MOCK');
        assert.equal(resolveTransmissionGateway('SDI').live, false);
    });

    it('SDI in modalità MOCK anche con trasmissione abilitata', () => {
        Object.assign(fiscal, { transmissionEnabled: true, sdiProvider: 'MOCK' });
        assert.equal(resolveTransmissionGateway('SDI').gateway.provider, 'MOCK');
    });

    it('SDI provider senza configurazione resta non disponibile', () => {
        Object.assign(fiscal, { transmissionEnabled: true, sdiProvider: 'PROVIDER', sdiEndpoint: '', sdiApiKey: '' });
        const selection = resolveTransmissionGateway('SDI');
        assert.equal(selection.live, false);
        assert.match(selection.reason, /non configurato/);
    });

    it('STS con credenziali complete è live', () => {
        Object.assign(fiscal, { transmissionEnabled: true });
        const selection = resolveTransmissionGateway('STS', {
            endpoint: 'https://sts.example', username: 'u', password: 'p', pincode: '1', live: true,
        });
        assert.equal(selection.gateway.provider, 'STS_DIRECT');
        assert.equal(selection.live, true);
    });

    it('STS senza credenziali non è live', () => {
        Object.assign(fiscal, { transmissionEnabled: true, stsEndpoint: '', stsUsername: '', stsPassword: '', stsPincode: '', stsLive: false });
        const selection = resolveTransmissionGateway('STS');
        assert.equal(selection.live, false);
    });
});
