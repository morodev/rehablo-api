/**
 * Contratto di trasmissione fiscale v2 (provider-neutral) e adapter.
 *
 * Diversamente dal gateway di sola simulazione (`fiscalGateway.service.ts`, usato dalla prova
 * MOCK dell'interfaccia), questo contratto è pensato per la trasmissione REALE su SDI/Sistema TS
 * e produce un esito normalizzato (`FiscalGatewayOutcome`) che alimenta la macchina a stati.
 *
 * IMPORTANTE: nessun adapter effettua realmente una trasmissione finché `live` non è true e le
 * credenziali non sono configurate. In questo ambiente non ci sono credenziali: `StsDirectGateway`
 * resta quindi in modalità non-live e restituisce `ACTION_REQUIRED`.
 */

import { FiscalGatewayOutcome } from './fiscalSubmissionState.js';

export interface FiscalTransmissionRequest {
    channel: 'SDI' | 'STS';
    documentId: string;
    format: string;
    xml: string;
    idempotencyKey: string;
    annoFiscale?: number;
    /** Solo per gli adapter di test: esito da simulare. */
    scenario?: 'ACCEPTED' | 'REJECTED';
}

export interface FiscalTransmissionResult {
    outcome: FiscalGatewayOutcome;
    externalId: string | null;
    protocolNumber: string | null;
    error: string | null;
    /** Risposta grezza del provider, da conservare per audit (mai esposta integralmente al client). */
    rawResponse: string | null;
}

export interface FiscalTransmissionGateway {
    readonly provider: string;
    readonly channel: 'SDI' | 'STS' | 'BOTH';
    /** false = nessuna trasmissione reale (sandbox/scaffold). */
    readonly live: boolean;
    transmit(request: FiscalTransmissionRequest): Promise<FiscalTransmissionResult>;
}

import crypto from 'node:crypto';

const digestOf = (request: FiscalTransmissionRequest): string =>
    crypto.createHash('sha256').update(`${request.channel}:${request.documentId}:${request.xml}`).digest('hex').slice(0, 16).toUpperCase();

/** Adapter deterministico per test e collaudo. Non comunica con alcun ente. */
export class MockTransmissionGateway implements FiscalTransmissionGateway {
    readonly provider = 'MOCK';
    readonly channel = 'BOTH' as const;
    readonly live = false;

    async transmit(request: FiscalTransmissionRequest): Promise<FiscalTransmissionResult> {
        const digest = digestOf(request);
        if (request.scenario === 'REJECTED') {
            return { outcome: 'REJECTED', externalId: `MOCK-${digest}`, protocolNumber: null, error: 'Rifiuto simulato. Nessun dato trasmesso.', rawResponse: null };
        }
        return { outcome: 'ACCEPTED', externalId: `MOCK-${digest}`, protocolNumber: `SANDBOX-${request.channel}-${digest}`, rawResponse: null, error: null };
    }
}

export interface StsDirectConfig {
    username?: string | null;
    password?: string | null;
    /** PIN Sistema TS usato per la firma/autenticazione del pacchetto. */
    pincode?: string | null;
    endpoint?: string | null;
    /** Deve essere esplicitamente true per abilitare la trasmissione reale. */
    live?: boolean;
}

/** Le credenziali sono complete e la trasmissione reale è stata abilitata. */
export function stsDirectConfigured(config: StsDirectConfig | null | undefined): boolean {
    return Boolean(config?.live && config.username?.trim() && config.password?.trim() && config.pincode?.trim() && config.endpoint?.trim());
}

/**
 * Descrittore della richiesta verso il Sistema TS, costruito senza inviare nulla. La firma reale
 * e il web service definitivo vanno completati con le specifiche ufficiali quando si collega
 * l'ambiente di collaudo.
 */
export function buildStsRequestDescriptor(config: StsDirectConfig, request: FiscalTransmissionRequest): {
    url: string; headers: Record<string, string>; body: string;
} {
    return {
        url: `${config.endpoint}`,
        headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'X-STS-User': config.username ?? '',
        },
        body: request.xml,
    };
}

/** Interpreta (in modo strutturale) una risposta del Sistema TS. Da adattare al tracciato di esito ufficiale. */
export function parseStsResponse(raw: string): { outcome: FiscalGatewayOutcome; protocolNumber: string | null; error: string | null } {
    const protocollo = /<protocollo>([^<]+)<\/protocollo>/i.exec(raw)?.[1]?.trim() ?? null;
    const esito = /<esito>([^<]+)<\/esito>/i.exec(raw)?.[1]?.trim().toUpperCase() ?? '';
    const descrizione = /<(?:descrizione|errore)>([^<]+)<\/(?:descrizione|errore)>/i.exec(raw)?.[1]?.trim() ?? null;
    if (esito === 'OK') return { outcome: 'ACCEPTED', protocolNumber: protocollo, error: null };
    if (esito === 'KO') return { outcome: 'REJECTED', protocolNumber: protocollo, error: descrizione ?? 'Documento rifiutato dal Sistema TS.' };
    return { outcome: 'ACTION_REQUIRED', protocolNumber: protocollo, error: descrizione ?? 'Risposta del Sistema TS non riconosciuta.' };
}

/**
 * Adapter Sistema TS diretto (credenziali dello studio). In assenza di credenziali/abilitazione
 * resta non-live: NON effettua chiamate di rete e richiede l'intervento amministrativo.
 */
export class StsDirectGateway implements FiscalTransmissionGateway {
    readonly provider = 'STS_DIRECT';
    readonly channel = 'STS' as const;
    readonly live: boolean;

    constructor(private readonly config: StsDirectConfig | null | undefined) {
        this.live = stsDirectConfigured(config);
    }

    async transmit(request: FiscalTransmissionRequest): Promise<FiscalTransmissionResult> {
        if (!this.live || !this.config) {
            return {
                outcome: 'ACTION_REQUIRED', externalId: null, protocolNumber: null, rawResponse: null,
                error: 'Credenziali Sistema TS non configurate o trasmissione reale non abilitata.',
            };
        }
        // Punto di innesto della trasmissione reale: costruito il descrittore, l'invio HTTP e la
        // firma vanno completati con le specifiche ufficiali e l'ambiente di collaudo.
        buildStsRequestDescriptor(this.config, request);
        return {
            outcome: 'ACTION_REQUIRED', externalId: null, protocolNumber: null, rawResponse: null,
            error: 'Trasmissione reale al Sistema TS non ancora attivata in questo ambiente.',
        };
    }
}

/**
 * Gateway segnaposto per un canale abilitato ma non ancora configurato (es. provider SDI scelto
 * ma senza endpoint/credenziali). Non trasmette: porta la submission in ACTION_REQUIRED con un
 * messaggio esplicito, senza mai fingere un invio.
 */
export class UnavailableGateway implements FiscalTransmissionGateway {
    readonly live = false;
    constructor(readonly provider: string, readonly channel: 'SDI' | 'STS' | 'BOTH', private readonly message: string) {}

    async transmit(): Promise<FiscalTransmissionResult> {
        return { outcome: 'ACTION_REQUIRED', externalId: null, protocolNumber: null, rawResponse: null, error: this.message };
    }
}
