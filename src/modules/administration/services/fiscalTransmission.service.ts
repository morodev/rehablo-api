/**
 * Orchestratore di trasmissione fiscale (provider-neutral).
 *
 * Fa avanzare una submission attraverso la macchina a stati usando un gateway, applicando le
 * transizioni legali: validazione del payload → invio → esito. È il cuore riusabile sia dalla
 * trasmissione reale sia dai test; la persistenza su `FiscalSubmission` è un livello sottile
 * sopra questo orchestratore, così la logica di stato resta testabile senza database.
 */

import { FiscalPayloadResult } from './fiscalPayload.js';
import {
    FiscalSubmissionStatus,
    assertFiscalTransition,
    canRetryFiscalStatus,
    statusFromGatewayOutcome,
} from './fiscalSubmissionState.js';
import { FiscalTransmissionGateway, FiscalTransmissionRequest } from './fiscalTransmissionGateway.js';

export interface TransmissionOutcome {
    /** Sequenza ordinata degli stati attraversati, a partire da `VALIDATING`. */
    steps: FiscalSubmissionStatus[];
    finalStatus: FiscalSubmissionStatus;
    externalId: string | null;
    protocolNumber: string | null;
    error: string | null;
    rawResponse: string | null;
    /** true se il gateway è in modalità reale (live). */
    live: boolean;
}

export interface RunTransmissionParams {
    /** Stato attuale della submission: deve essere QUEUED o uno stato ritentabile. */
    currentStatus: FiscalSubmissionStatus;
    payload: FiscalPayloadResult;
    gateway: FiscalTransmissionGateway;
    request: FiscalTransmissionRequest;
}

/**
 * Esegue la trasmissione applicando le transizioni. Non accede al database: restituisce gli stati
 * attraversati e l'esito, che il chiamante persiste sulla submission.
 */
export async function runTransmission(params: RunTransmissionParams): Promise<TransmissionOutcome> {
    const { currentStatus, payload, gateway, request } = params;

    if (currentStatus !== 'QUEUED' && !canRetryFiscalStatus(currentStatus)) {
        throw Object.assign(new Error(`La submission non è in uno stato trasmissibile (${currentStatus}).`), { statusCode: 409 });
    }

    const steps: FiscalSubmissionStatus[] = [];
    const advance = (to: FiscalSubmissionStatus) => {
        const from = steps.length ? steps[steps.length - 1] : currentStatus;
        assertFiscalTransition(from, to);
        steps.push(to);
    };

    const base: Omit<TransmissionOutcome, 'steps' | 'finalStatus'> = {
        externalId: null, protocolNumber: null, error: null, rawResponse: null, live: gateway.live,
    };

    // Un documento rifiutato va prima messo in coda di ritentativo, poi rivalidato.
    if (currentStatus === 'REJECTED') advance('RETRY_SCHEDULED');
    advance('VALIDATING');

    if (payload.errors.length > 0 || !payload.xml) {
        advance('INVALID');
        return { ...base, steps, finalStatus: 'INVALID', error: payload.errors.join(' ') || 'Payload non valido.' };
    }

    advance('SUBMITTED');

    const result = await gateway.transmit({ ...request, xml: payload.xml, format: payload.format });
    const nextStatus = statusFromGatewayOutcome(result.outcome);
    advance(nextStatus);

    return {
        ...base,
        steps,
        finalStatus: nextStatus,
        externalId: result.externalId,
        protocolNumber: result.protocolNumber,
        error: result.error,
        rawResponse: result.rawResponse,
    };
}
