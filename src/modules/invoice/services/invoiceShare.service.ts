import { createHash, randomBytes } from 'node:crypto';
import { Op } from 'sequelize';
import { env } from '../../../config/env.js';
import { frontendEmailLink } from '../../../services/email.service.js';
import { InvoiceShareLink, InvoiceShareChannel } from '../models/invoiceShareLink.model.js';

/** Durata di default del link consegnato al paziente. */
const DEFAULT_TTL_HOURS = 24 * 30;

export function shareLinkTtlHours(): number {
    const configured = Number(process.env.INVOICE_SHARE_TTL_HOURS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TTL_HOURS;
}

export function hashShareToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

export function buildShareUrl(token: string): string {
    return frontendEmailLink(`fattura/${token}`);
}

/**
 * Emette un nuovo link per la fattura e invalida quelli ancora attivi.
 *
 * La rotazione è la forma di revoca disponibile all'operatore: se il documento finisce alla
 * persona sbagliata, basta rigenerare il link perché il precedente smetta di funzionare.
 */
export async function createShareLink(input: {
    tenantId: string;
    invoiceId: string;
    patientId: string | null;
    createdByUserId: string;
    channel: InvoiceShareChannel;
}): Promise<{ token: string; url: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + shareLinkTtlHours() * 60 * 60 * 1000);

    await InvoiceShareLink.update(
        { revokedAt: new Date() },
        {
            where: {
                tenantId: input.tenantId,
                invoiceId: input.invoiceId,
                revokedAt: { [Op.is]: null }
            }
        }
    );

    await InvoiceShareLink.create({
        tenantId: input.tenantId,
        invoiceId: input.invoiceId,
        patientId: input.patientId,
        createdByUserId: input.createdByUserId,
        channel: input.channel,
        tokenHash: hashShareToken(token),
        expiresAt
    });

    return { token, url: buildShareUrl(token), expiresAt };
}

/** Link ancora spendibile: non revocato e non scaduto. */
export async function loadUsableShareLink(token: string): Promise<InvoiceShareLink | null> {
    if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
        return null;
    }
    return InvoiceShareLink.findOne({
        where: {
            tokenHash: hashShareToken(token),
            revokedAt: { [Op.is]: null },
            expiresAt: { [Op.gt]: new Date() }
        }
    });
}

/**
 * Traccia l'apertura del link. È volutamente best-effort: se la scrittura fallisce il paziente
 * deve comunque vedere la sua fattura.
 */
export async function recordShareView(link: InvoiceShareLink): Promise<void> {
    try {
        await link.update({
            lastViewedAt: new Date(),
            viewCount: (link.get('viewCount') as number) + 1
        });
    } catch (err) {
        if (!env.isProduction) {
            console.warn('[invoiceShare] impossibile registrare la visualizzazione', err);
        }
    }
}
