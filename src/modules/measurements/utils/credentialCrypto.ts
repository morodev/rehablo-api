import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../../../config/env.js';

/**
 * Cifratura simmetrica (AES-256-GCM) per le credenziali dei dispositivi (es. API key dei vendor).
 * La chiave a 32 byte è derivata dal segreto d'ambiente. Il formato salvato è: iv:tag:ciphertext (base64).
 *
 * NOTA: le credenziali NON devono MAI essere restituite in chiaro al frontend. Vengono cifrate qui e
 * decifrate solo lato server (dai connettori) al momento della chiamata all'API del vendor.
 */
const KEY = createHash('sha256').update(env.deviceCredentialsSecret).digest(); // 32 byte

export function encryptSecret(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', KEY, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

export function decryptSecret(payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split(':');
    if (!ivB64 || !tagB64 || !dataB64) {
        throw new Error('Formato credenziale cifrata non valido');
    }
    const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return decrypted.toString('utf8');
}

