import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    MockTransmissionGateway,
    StsDirectGateway,
    buildStsRequestDescriptor,
    parseStsResponse,
    stsDirectConfigured,
} from './fiscalTransmissionGateway.js';
import { runTransmission } from './fiscalTransmission.service.js';
import { FiscalPayloadResult } from './fiscalPayload.js';

const validPayload: FiscalPayloadResult = { channel: 'STS', format: 'SistemaTS', xml: '<invioTelematico/>', errors: [] };
const invalidPayload: FiscalPayloadResult = { channel: 'STS', format: 'SistemaTS', xml: null, errors: ['Manca il codice fiscale.'] };
const request = { channel: 'STS' as const, documentId: 'doc-1', format: 'SistemaTS', xml: '', idempotencyKey: 'k1' };

describe('stsDirectConfigured', () => {
    it('richiede credenziali complete e live abilitato', () => {
        assert.equal(stsDirectConfigured(null), false);
        assert.equal(stsDirectConfigured({ username: 'u', password: 'p', pincode: '1', endpoint: 'https://x', live: false }), false);
        assert.equal(stsDirectConfigured({ username: 'u', password: 'p', pincode: '1', endpoint: 'https://x', live: true }), true);
        assert.equal(stsDirectConfigured({ username: 'u', password: '', pincode: '1', endpoint: 'https://x', live: true }), false);
    });
});

describe('StsDirectGateway', () => {
    it('senza credenziali resta non-live e richiede intervento', async () => {
        const gateway = new StsDirectGateway(null);
        assert.equal(gateway.live, false);
        const result = await gateway.transmit(request);
        assert.equal(result.outcome, 'ACTION_REQUIRED');
        assert.match(result.error ?? '', /non configurate|non ancora attivata/);
    });

    it('costruisce un descrittore di richiesta senza inviare', () => {
        const descriptor = buildStsRequestDescriptor(
            { username: 'u', password: 'p', pincode: '1', endpoint: 'https://sts.example/invio', live: true },
            { ...request, xml: '<x/>' }
        );
        assert.equal(descriptor.url, 'https://sts.example/invio');
        assert.equal(descriptor.body, '<x/>');
        assert.equal(descriptor.headers['X-STS-User'], 'u');
    });
});

describe('parseStsResponse', () => {
    it('interpreta esito OK/KO e protocollo', () => {
        assert.deepEqual(
            parseStsResponse('<r><esito>OK</esito><protocollo>ABC123</protocollo></r>'),
            { outcome: 'ACCEPTED', protocolNumber: 'ABC123', error: null }
        );
        const ko = parseStsResponse('<r><esito>KO</esito><descrizione>CF errato</descrizione></r>');
        assert.equal(ko.outcome, 'REJECTED');
        assert.equal(ko.error, 'CF errato');
        assert.equal(parseStsResponse('<r/>').outcome, 'ACTION_REQUIRED');
    });
});

describe('runTransmission', () => {
    it('percorso nominale QUEUED→VALIDATING→SUBMITTED→ACCEPTED', async () => {
        const outcome = await runTransmission({
            currentStatus: 'QUEUED', payload: validPayload, gateway: new MockTransmissionGateway(), request,
        });
        assert.deepEqual(outcome.steps, ['VALIDATING', 'SUBMITTED', 'ACCEPTED']);
        assert.equal(outcome.finalStatus, 'ACCEPTED');
        assert.ok(outcome.protocolNumber);
        assert.equal(outcome.live, false);
    });

    it('payload non valido si ferma a INVALID senza invio', async () => {
        const outcome = await runTransmission({
            currentStatus: 'QUEUED', payload: invalidPayload, gateway: new MockTransmissionGateway(), request,
        });
        assert.deepEqual(outcome.steps, ['VALIDATING', 'INVALID']);
        assert.equal(outcome.finalStatus, 'INVALID');
        assert.match(outcome.error ?? '', /codice fiscale/);
    });

    it('esito rifiutato porta a REJECTED', async () => {
        const outcome = await runTransmission({
            currentStatus: 'QUEUED', payload: validPayload, gateway: new MockTransmissionGateway(),
            request: { ...request, scenario: 'REJECTED' },
        });
        assert.equal(outcome.finalStatus, 'REJECTED');
    });

    it('un retry da REJECTED è ammesso', async () => {
        const outcome = await runTransmission({
            currentStatus: 'REJECTED', payload: validPayload, gateway: new MockTransmissionGateway(), request,
        });
        assert.equal(outcome.finalStatus, 'ACCEPTED');
    });

    it('rifiuta l’avvio da uno stato non trasmissibile', async () => {
        await assert.rejects(
            runTransmission({ currentStatus: 'ACCEPTED', payload: validPayload, gateway: new MockTransmissionGateway(), request }),
            (err: any) => err.statusCode === 409
        );
    });

    it('un gateway non-live (StsDirect senza credenziali) porta a ACTION_REQUIRED', async () => {
        const outcome = await runTransmission({
            currentStatus: 'QUEUED', payload: validPayload, gateway: new StsDirectGateway(null), request,
        });
        assert.equal(outcome.finalStatus, 'ACTION_REQUIRED');
        assert.equal(outcome.live, false);
    });
});
