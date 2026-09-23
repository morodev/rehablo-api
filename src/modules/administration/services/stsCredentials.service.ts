/**
 * Credenziali Sistema TS PER-TENANT (impostazioni del singolo studio).
 *
 * Divisione delle responsabilità:
 *  - config UNICA di Rehablo (endpoint del web service, provider SDI, interruttore generale) →
 *    variabili d'ambiente / `env.fiscal`;
 *  - config del SINGOLO studio (username/password/PINCODE del portale Sistema TS, opt-in all'invio
 *    reale) → qui, salvata in `tenant.administrationSettings.fiscal.stsCredentials`.
 *
 * I segreti (password, PINCODE) sono cifrati con AES-256-GCM e NON vengono mai restituiti in chiaro
 * al frontend: le letture espongono solo la presenza del dato (`hasPassword`/`hasPincode`).
 */

import { decryptSecret, encryptSecret } from '../../measurements/utils/credentialCrypto.js';
import { StsCredentialOverride } from './fiscalGatewayFactory.js';

export interface StoredStsCredentials {
    username: string | null;
    passwordEnc: string | null;
    pincodeEnc: string | null;
    live: boolean;
    updatedAt?: string;
    updatedByUserId?: string | null;
}

export interface StsCredentialsInput {
    username?: unknown;
    password?: unknown;
    pincode?: unknown;
    live?: unknown;
}

export interface StsCredentialsView {
    username: string | null;
    hasPassword: boolean;
    hasPincode: boolean;
    live: boolean;
    updatedAt: string | null;
}

const asString = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;

function readStored(tenantData: Record<string, any> | null | undefined): StoredStsCredentials {
    const stored = tenantData?.administrationSettings?.fiscal?.stsCredentials ?? {};
    return {
        username: asString(stored.username),
        passwordEnc: asString(stored.passwordEnc),
        pincodeEnc: asString(stored.pincodeEnc),
        live: stored.live === true,
        updatedAt: stored.updatedAt,
        updatedByUserId: stored.updatedByUserId ?? null,
    };
}

/** Vista mascherata per il frontend: nessun segreto in chiaro. */
export function maskStsCredentials(tenantData: Record<string, any> | null | undefined): StsCredentialsView {
    const stored = readStored(tenantData);
    return {
        username: stored.username,
        hasPassword: Boolean(stored.passwordEnc),
        hasPincode: Boolean(stored.pincodeEnc),
        live: stored.live,
        updatedAt: stored.updatedAt ?? null,
    };
}

/**
 * Fonde l'input con le credenziali salvate. Un campo segreto omesso o vuoto NON cancella quello
 * esistente (evita perdite accidentali): per rimuoverlo va passato esplicitamente `null`.
 */
export function mergeStsCredentials(
    tenantData: Record<string, any> | null | undefined,
    input: StsCredentialsInput,
    userId?: string | null
): StoredStsCredentials {
    const current = readStored(tenantData);
    const nextSecret = (value: unknown, currentEnc: string | null): string | null => {
        if (value === null) return null;
        const plain = asString(value);
        return plain ? encryptSecret(plain) : currentEnc;
    };
    return {
        username: input.username === undefined ? current.username : asString(input.username),
        passwordEnc: nextSecret(input.password, current.passwordEnc),
        pincodeEnc: nextSecret(input.pincode, current.pincodeEnc),
        live: typeof input.live === 'boolean' ? input.live : current.live,
        updatedAt: new Date().toISOString(),
        updatedByUserId: userId ?? null,
    };
}

/**
 * Credenziali decifrate da passare al gateway. L'endpoint resta configurazione globale di Rehablo
 * (`env.fiscal.stsEndpoint`): qui si forniscono solo i dati del singolo studio.
 */
export function loadStsCredentialsForTenant(tenantData: Record<string, any> | null | undefined): StsCredentialOverride | null {
    const stored = readStored(tenantData);
    if (!stored.username && !stored.passwordEnc && !stored.pincodeEnc) return null;
    return {
        username: stored.username,
        password: stored.passwordEnc ? decryptSecret(stored.passwordEnc) : null,
        pincode: stored.pincodeEnc ? decryptSecret(stored.pincodeEnc) : null,
        live: stored.live,
    };
}
