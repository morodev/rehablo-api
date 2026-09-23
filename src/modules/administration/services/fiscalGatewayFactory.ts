/**
 * Factory del gateway di trasmissione fiscale, pilotata dalla configurazione d'ambiente.
 *
 * Regola di sicurezza: finché `env.fiscal.transmissionEnabled` è false (DEFAULT), qualunque canale
 * usa il gateway MOCK/sandbox — nessun dato reale lascia il gestionale. L'attivazione reale è una
 * scelta esplicita e per-canale, con provider/credenziali configurati.
 *
 * Vedi docs/fiscal-integration-setup.md.
 */

import { env } from '../../../config/env.js';
import {
    FiscalTransmissionGateway,
    MockTransmissionGateway,
    StsDirectConfig,
    StsDirectGateway,
    UnavailableGateway,
} from './fiscalTransmissionGateway.js';

export interface GatewaySelection {
    gateway: FiscalTransmissionGateway;
    /** Descrizione della scelta, utile per audit e per l'interfaccia. */
    reason: string;
    /** true = trasmissione reale; false = MOCK/sandbox o non configurato. */
    live: boolean;
}

export interface StsCredentialOverride {
    endpoint?: string | null;
    username?: string | null;
    password?: string | null;
    pincode?: string | null;
    live?: boolean;
}

/** Seleziona il gateway per il canale, applicando eventuali credenziali TS per-tenant. */
export function resolveTransmissionGateway(
    channel: 'SDI' | 'STS',
    stsOverride?: StsCredentialOverride | null
): GatewaySelection {
    if (!env.fiscal.transmissionEnabled) {
        return { gateway: new MockTransmissionGateway(), reason: 'Trasmissione reale disabilitata: gateway MOCK/sandbox.', live: false };
    }

    if (channel === 'SDI') {
        if (env.fiscal.sdiProvider === 'MOCK') {
            return { gateway: new MockTransmissionGateway(), reason: 'Provider SDI in modalità MOCK.', live: false };
        }
        if (!env.fiscal.sdiEndpoint || !env.fiscal.sdiApiKey) {
            return {
                gateway: new UnavailableGateway('SDI_PROVIDER', 'SDI', 'Provider SDI selezionato ma non configurato (endpoint/API key mancanti).'),
                reason: 'Provider SDI non configurato.', live: false,
            };
        }
        // Innesto per l'adapter provider SDI reale (da implementare col provider scelto).
        return {
            gateway: new UnavailableGateway('SDI_PROVIDER', 'SDI', 'Adapter del provider SDI non ancora implementato per questo provider.'),
            reason: 'Adapter provider SDI da implementare.', live: false,
        };
    }

    // Canale Sistema TS: credenziali per-tenant se presenti, altrimenti quelle globali (tenant pilota).
    const config: StsDirectConfig = {
        endpoint: stsOverride?.endpoint ?? env.fiscal.stsEndpoint,
        username: stsOverride?.username ?? env.fiscal.stsUsername,
        password: stsOverride?.password ?? env.fiscal.stsPassword,
        pincode: stsOverride?.pincode ?? env.fiscal.stsPincode,
        live: stsOverride?.live ?? env.fiscal.stsLive,
    };
    const gateway = new StsDirectGateway(config);
    return {
        gateway,
        reason: gateway.live ? 'Sistema TS diretto (credenziali configurate).' : 'Sistema TS: credenziali non complete o trasmissione non abilitata.',
        live: gateway.live,
    };
}
