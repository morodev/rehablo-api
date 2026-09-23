/**
 * Macchina a stati delle trasmissioni fiscali (`FiscalSubmission`) — provider-neutral e pura.
 *
 * Governa le transizioni legali del ciclo di vita di un invio a SDI o Sistema TS, così che
 * l'outbox non possa passare a uno stato incoerente (cfr. docs/analisi-piano-gestione-amministrativa-fiscale.md §6.5):
 *
 *   QUEUED -> VALIDATING -> SUBMITTED -> ACCEPTED
 *                    |            |           
 *                    v            v           
 *                 INVALID      REJECTED / RETRY_SCHEDULED / ACTION_REQUIRED
 *
 * Errori temporanei: RETRY_SCHEDULED -> SUBMITTED. Revisione umana: ACTION_REQUIRED.
 * Le correzioni definitive creano una NUOVA submission, non riscrivono lo storico.
 */

export const FISCAL_SUBMISSION_STATES = [
    'QUEUED',
    'VALIDATING',
    'SUBMITTED',
    'ACCEPTED',
    'REJECTED',
    'INVALID',
    'RETRY_SCHEDULED',
    'ACTION_REQUIRED',
    'CANCELLED',
] as const;

export type FiscalSubmissionStatus = typeof FISCAL_SUBMISSION_STATES[number];

const TRANSITIONS: Record<FiscalSubmissionStatus, FiscalSubmissionStatus[]> = {
    QUEUED: ['VALIDATING', 'CANCELLED'],
    VALIDATING: ['SUBMITTED', 'INVALID', 'CANCELLED'],
    SUBMITTED: ['ACCEPTED', 'REJECTED', 'RETRY_SCHEDULED', 'ACTION_REQUIRED'],
    RETRY_SCHEDULED: ['VALIDATING', 'SUBMITTED', 'CANCELLED'],
    ACTION_REQUIRED: ['VALIDATING', 'CANCELLED'],
    INVALID: ['VALIDATING', 'CANCELLED'],
    REJECTED: ['RETRY_SCHEDULED', 'CANCELLED'],
    ACCEPTED: [],
    CANCELLED: [],
};

/** Stati definitivi: una submission in questo stato non evolve più. */
export function isTerminalFiscalStatus(status: FiscalSubmissionStatus): boolean {
    return TRANSITIONS[status].length === 0;
}

export function isFiscalSubmissionStatus(value: unknown): value is FiscalSubmissionStatus {
    return typeof value === 'string' && (FISCAL_SUBMISSION_STATES as readonly string[]).includes(value);
}

export function canTransitionFiscalStatus(from: FiscalSubmissionStatus, to: FiscalSubmissionStatus): boolean {
    return TRANSITIONS[from].includes(to);
}

/** Verifica una transizione e lancia un errore 409 se non ammessa. */
export function assertFiscalTransition(from: FiscalSubmissionStatus, to: FiscalSubmissionStatus): void {
    if (!isFiscalSubmissionStatus(from) || !isFiscalSubmissionStatus(to)) {
        throw Object.assign(new Error('Stato di trasmissione fiscale non valido'), { statusCode: 400 });
    }
    if (!canTransitionFiscalStatus(from, to)) {
        throw Object.assign(new Error(`Transizione non consentita: ${from} → ${to}`), { statusCode: 409 });
    }
}

/** Esito normalizzato del gateway, indipendente dal provider. */
export type FiscalGatewayOutcome = 'ACCEPTED' | 'REJECTED' | 'RETRIABLE' | 'ACTION_REQUIRED';

/** Stato in cui portare la submission dopo la risposta del gateway (partendo da SUBMITTED). */
export function statusFromGatewayOutcome(outcome: FiscalGatewayOutcome): FiscalSubmissionStatus {
    switch (outcome) {
        case 'ACCEPTED': return 'ACCEPTED';
        case 'REJECTED': return 'REJECTED';
        case 'RETRIABLE': return 'RETRY_SCHEDULED';
        case 'ACTION_REQUIRED': return 'ACTION_REQUIRED';
    }
}

/** Una submission può essere ritentata solo da uno stato di fallimento non definitivo. */
export function canRetryFiscalStatus(status: FiscalSubmissionStatus): boolean {
    return status === 'REJECTED' || status === 'RETRY_SCHEDULED' || status === 'INVALID' || status === 'ACTION_REQUIRED';
}
