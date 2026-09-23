import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    FISCAL_SUBMISSION_STATES,
    assertFiscalTransition,
    canRetryFiscalStatus,
    canTransitionFiscalStatus,
    isTerminalFiscalStatus,
    statusFromGatewayOutcome,
} from './fiscalSubmissionState.js';

describe('fiscalSubmissionState', () => {
    it('espone gli stati canonici', () => {
        assert.ok(FISCAL_SUBMISSION_STATES.includes('QUEUED'));
        assert.ok(FISCAL_SUBMISSION_STATES.includes('ACTION_REQUIRED'));
    });

    it('consente il percorso nominale QUEUED→ACCEPTED', () => {
        assert.ok(canTransitionFiscalStatus('QUEUED', 'VALIDATING'));
        assert.ok(canTransitionFiscalStatus('VALIDATING', 'SUBMITTED'));
        assert.ok(canTransitionFiscalStatus('SUBMITTED', 'ACCEPTED'));
    });

    it('permette il retry temporaneo e la ripresa', () => {
        assert.ok(canTransitionFiscalStatus('SUBMITTED', 'RETRY_SCHEDULED'));
        assert.ok(canTransitionFiscalStatus('RETRY_SCHEDULED', 'SUBMITTED'));
        assert.ok(canTransitionFiscalStatus('REJECTED', 'RETRY_SCHEDULED'));
    });

    it('vieta transizioni incoerenti', () => {
        assert.equal(canTransitionFiscalStatus('QUEUED', 'ACCEPTED'), false);
        assert.equal(canTransitionFiscalStatus('ACCEPTED', 'SUBMITTED'), false);
        assert.equal(canTransitionFiscalStatus('CANCELLED', 'VALIDATING'), false);
    });

    it('riconosce gli stati terminali', () => {
        assert.ok(isTerminalFiscalStatus('ACCEPTED'));
        assert.ok(isTerminalFiscalStatus('CANCELLED'));
        assert.equal(isTerminalFiscalStatus('REJECTED'), false);
    });

    it('assertFiscalTransition lancia con statusCode', () => {
        assert.doesNotThrow(() => assertFiscalTransition('QUEUED', 'VALIDATING'));
        assert.throws(() => assertFiscalTransition('QUEUED', 'ACCEPTED'), (err: any) => err.statusCode === 409);
        assert.throws(() => assertFiscalTransition('QUEUED', 'BOGUS' as any), (err: any) => err.statusCode === 400);
    });

    it('mappa gli esiti del gateway sugli stati', () => {
        assert.equal(statusFromGatewayOutcome('ACCEPTED'), 'ACCEPTED');
        assert.equal(statusFromGatewayOutcome('REJECTED'), 'REJECTED');
        assert.equal(statusFromGatewayOutcome('RETRIABLE'), 'RETRY_SCHEDULED');
        assert.equal(statusFromGatewayOutcome('ACTION_REQUIRED'), 'ACTION_REQUIRED');
    });

    it('consente il retry solo dagli stati di fallimento', () => {
        assert.ok(canRetryFiscalStatus('REJECTED'));
        assert.ok(canRetryFiscalStatus('INVALID'));
        assert.equal(canRetryFiscalStatus('ACCEPTED'), false);
        assert.equal(canRetryFiscalStatus('SUBMITTED'), false);
    });
});
