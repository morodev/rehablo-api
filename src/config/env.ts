import * as dotenv from 'dotenv';

dotenv.config();

function required(name: string, fallback?: string): string {
    const value = process.env[name] ?? fallback;
    if (value === undefined) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

/**
 * La libreria `ms` (usata da jsonwebtoken per `expiresIn`) interpreta una stringa puramente
 * numerica SENZA unità (es. "7") come MILLISECONDI, non giorni: un errore di configurazione
 * facile da fare che produce token con vita utile ~0 (scaduti all'istante). Se in JWT_EXPIRES_IN
 * arriva un valore composto solo da cifre, assumiamo fosse inteso in giorni e aggiungiamo "d".
 */
function normalizeExpiresIn(value: string): string {
    if (/^\d+$/.test(value.trim())) {
        console.warn(
            `[env] JWT_EXPIRES_IN="${value}" non ha un'unità (d/h/m/s): verrebbe interpretato come ${value}ms da jsonwebtoken. Normalizzato in "${value}d".`
        );
        return `${value.trim()}d`;
    }
    return value;
}

/**
 * Legge un intero positivo da env. A differenza di JWT_EXPIRES_IN, questi valori NON sono
 * stringhe con unità (`ms`): sono numeri puri. Un valore malformato produrrebbe NaN e, in
 * casi come il TTL del refresh token, una `Invalid Date` con sessioni non rinnovabili.
 */
function positiveInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        console.warn(`[env] ${name}="${raw}" non è un intero positivo. Uso il default ${fallback}.`);
        return fallback;
    }
    return parsed;
}

export const env = {
    nodeEnv: process.env.NODE_ENV || 'development',
    isProduction: process.env.NODE_ENV === 'production',
    port: parseInt(process.env.PORT || '3000', 10),

    databaseUrl: required('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/rehablo'),
    dbSsl: process.env.DB_SSL === 'true',

    jwtSecret: required('JWT_SECRET', 'change-me-please-use-a-long-random-string'),
    /**
     * Durata dell'ACCESS token. Volutamente breve: i permessi RBAC viaggiano nei claim,
     * quindi un token longevo terrebbe in vita permessi già revocati (vedi docs/RBAC_DESIGN.md).
     * La sessione lunga è garantita dal refresh token.
     */
    jwtExpiresIn: normalizeExpiresIn(process.env.JWT_EXPIRES_IN || '15m'),

    /**
     * Durata del REFRESH token, in GIORNI (numero puro, senza unità: `30`, non `30d`).
     * A differenza di JWT_EXPIRES_IN non passa da `ms`. Ruotato a ogni utilizzo.
     */
    refreshTokenTtlDays: positiveInt('REFRESH_TOKEN_TTL_DAYS', 30),

    /**
     * Finestra di tolleranza (SECONDI) entro cui un refresh token appena ruotato può essere
     * ripresentato senza far scattare la reuse detection.
     *
     * La rotazione invalida il vecchio token PRIMA che il client abbia salvato il nuovo: se la
     * risposta si perde (F5 durante la chiamata, rete instabile, due tab che rinnovano insieme)
     * il client resta con un token già revocato e, senza questa finestra, il tentativo successivo
     * verrebbe scambiato per un furto e revocherebbe l'intera famiglia — cioè un logout definitivo
     * a fronte di un evento del tutto normale.
     *
     * Va tenuta corta: è il tempo in cui un token rubato resta spendibile.
     */
    refreshTokenGraceSeconds: positiveInt('REFRESH_TOKEN_GRACE_SECONDS', 60),

    // Segreto per cifrare le credenziali dei dispositivi (API key dei vendor salvate per tenant).
    // In produzione impostare DEVICE_CREDENTIALS_SECRET a una stringa lunga e casuale.
    deviceCredentialsSecret: required('DEVICE_CREDENTIALS_SECRET', 'change-me-device-credentials-secret'),

    // F0.1 — RawFile: directory locale dove vengono conservati i file grezzi (CSV/Excel/PDF) dei
    // dispositivi. In futuro sostituibile da un adapter S3/MinIO senza cambiare il resto del modulo
    // (vedi docs/REHABLO_OS_IMPLEMENTATION_PLAN.md, StorageAdapter).
    rawFileStorageDir: process.env.RAW_FILE_STORAGE_DIR || './storage/raw-files',
    maxUploadSizeMb: parseInt(process.env.MAX_UPLOAD_SIZE_MB || '20', 10),

    stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',

    emailHost: process.env.EMAIL_HOST || '',
    emailPort: parseInt(process.env.EMAIL_PORT || '465', 10),
    emailSecure: process.env.EMAIL_SECURE !== 'false',
    emailUser: process.env.EMAIL_AUTH_USER || '',
    emailPass: process.env.EMAIL_AUTH_PASS || '',

    // CORS_ORIGIN: uno o più origin (dominio, senza path) separati da virgola, es.
    // "https://rehablo.it,https://www.rehablo.it". Eventuali slash finali vengono rimossi
    // automaticamente perché l'header Origin del browser non lo include mai (confronto esatto).
    corsOrigin: (process.env.CORS_ORIGIN || '*')
        .split(',')
        .map((origin) => origin.trim().replace(/\/+$/, ''))
        .filter(Boolean)
};

