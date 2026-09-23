import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Request } from 'express';
import { Model, Op, Transaction } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { env } from '../../../config/env.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { getGrantedPermissions, getUserId, scopeWhere } from '../../../middleware/rbac.js';
import { frontendEmailLink, transporter } from '../../../services/email.service.js';
import { hasPermission, resolveGrantedScope } from '../../auth/rbac/permissions.js';
import Tenant from '../../auth/models/tenant.model.js';
import Patient from '../../patients/models/patient.model.js';
import { withPatientEmail } from '../../invoice/utils/invoiceShare.js';
import { Quote } from '../models/administration.model.js';
import { QuoteDelivery, QuoteShareLink } from '../models/quoteDelivery.model.js';
import { accessibleQuotePatient, QuoteFlowError, quoteScopeWhere, validQuoteUuid } from './quoteAccess.js';
import { quoteConsentAllows, QuoteDeliveryChannel, quotePhone, quoteRecipient } from './quoteContact.js';
import { documentHash, quoteDateError, quoteDocument, QuoteDocumentSnapshot } from './quoteDocument.js';

const plain = (record: Model): Record<string, any> => record.get({ plain: true }) as Record<string, any>;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const expiry = (): Date => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

/** Repeatable after a lost response, without persisting a bearer credential anywhere. */
export function quoteShareToken(tenantId: string, deliveryId: string): string {
    return createHmac('sha256', env.jwtSecret).update(`rehablo:quote-delivery:v1:${tenantId}:${deliveryId}`).digest('hex');
}

export function quoteShareUrl(tenantId: string, deliveryId: string): string {
    return frontendEmailLink(`preventivo/${quoteShareToken(tenantId, deliveryId)}`);
}

export function quoteDeliveryView(record: Model): Record<string, unknown> {
    const value = plain(record);
    return Object.fromEntries(['id', 'quoteId', 'channel', 'recipient', 'message', 'status', 'createdAt', 'sentAt',
        'confirmedAt', 'revokedAt', 'expiresAt', 'lastError'].map(key => [key, value[key] ?? null]));
}

export async function loadScopedQuote(req: Request, transaction?: Transaction): Promise<Model> {
    if (!validQuoteUuid(req.params.id)) throw new QuoteFlowError(404, 'Preventivo non trovato');
    const quote = await Quote.schema(req.tenantSchema!).findOne({
        where: { id: req.params.id, ...quoteScopeWhere(req) }, transaction,
        ...(transaction ? { lock: transaction.LOCK.UPDATE } : {})
    });
    if (!quote) throw new QuoteFlowError(404, 'Preventivo non trovato');
    return quote;
}

export async function currentQuoteDocument(req: Request, record: Model, transaction?: Transaction): Promise<QuoteDocumentSnapshot> {
    const patient = await accessibleQuotePatient(req, record.get('patientId'), transaction);
    const tenant = await Tenant.findByPk(getCurrentTenantId(req), { transaction });
    if (!tenant) throw new QuoteFlowError(404, 'Azienda non disponibile');
    return quoteDocument(plain(record), plain(patient), plain(tenant));
}

export async function hasUnsharedQuoteChanges(req: Request, document: QuoteDocumentSnapshot): Promise<boolean> {
    const last = await QuoteDelivery.schema(req.tenantSchema!).findOne({
        where: { quoteId: document.quoteId, status: 'SENT' }, order: [['sentAt', 'DESC'], ['createdAt', 'DESC']]
    });
    return !!last && last.get('snapshotHash') !== documentHash(document);
}

export async function revokeQuoteLinks(req: Request, quoteId: unknown, transaction?: Transaction): Promise<void> {
    const now = new Date();
    await QuoteShareLink.update({ revokedAt: now }, {
        where: { tenantId: getCurrentTenantId(req), quoteId, revokedAt: null }, transaction
    });
    await QuoteDelivery.schema(req.tenantSchema!).update({ revokedAt: now }, {
        where: { quoteId, revokedAt: null }, transaction
    });
}

export async function ensureNoPendingQuoteDelivery(req: Request, quoteId: unknown, transaction?: Transaction): Promise<void> {
    if (await QuoteDelivery.schema(req.tenantSchema!).count({ where: { quoteId, status: 'PREPARING', revokedAt: null }, transaction })) {
        throw new QuoteFlowError(409, 'È presente un invio in corso o con esito da verificare. Controlla lo storico prima di riprovare');
    }
}

function assertShareable(quote: Model): void {
    if (!['DRAFT', 'SENT'].includes(String(quote.get('status')))) throw new QuoteFlowError(409, 'Questo preventivo non è più condivisibile');
    const dateError = quoteDateError(quote.get('issuedAt'), quote.get('expiresAt'));
    if (dateError) throw new QuoteFlowError(422, dateError);
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
    if (String(quote.get('expiresAt')) < today) throw new QuoteFlowError(409, 'Il preventivo è scaduto: aggiorna la scadenza prima di condividerlo');
    if (!Array.isArray(quote.get('lines')) || !(quote.get('lines') as unknown[]).length) throw new QuoteFlowError(422, 'Aggiungi almeno una prestazione o un prodotto');
}

async function savePatientContact(req: Request, patient: Patient, channel: QuoteDeliveryChannel, recipient: string, transaction: Transaction): Promise<void> {
    const permissions = getGrantedPermissions(req);
    if (!hasPermission(permissions, 'patient', 'update')) throw new QuoteFlowError(403, 'Non hai il permesso di aggiornare i recapiti del paziente');
    const scope = resolveGrantedScope(permissions, 'patient', 'update');
    const access = { ...req.access!, scope: scope! };
    const eligible = await Patient.schema(req.tenantSchema!).findOne({
        where: { id: patient.id, ...scopeWhere({ ...req, access } as Request, { structureField: 'structureId', ownerField: 'userId' }) }, transaction
    });
    if (!eligible) throw new QuoteFlowError(403, 'Non hai il permesso di aggiornare questo paziente');
    if (channel === 'email') {
        const emails = withPatientEmail(patient.get('emails'), recipient, 'Preventivi');
        if (emails) await patient.update({ emails }, { transaction });
    } else {
        const numbers = Array.isArray(patient.get('phoneNumbers')) ? patient.get('phoneNumbers') : [];
        if (!numbers.some(entry => quotePhone(entry.phoneNumber, entry.country) === recipient)) {
            await patient.update({ phoneNumbers: [...numbers, { country: 'it', phoneNumber: recipient, label: 'Preventivi' }] }, { transaction });
        }
    }
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;').replace(new RegExp(String.fromCharCode(34), 'g'), '&quot;');

export interface QuoteMailInput { recipient: string; message: string; url: string; document: QuoteDocumentSnapshot; expiresAt: Date }

export async function sendQuoteMail(input: QuoteMailInput): Promise<void> {
    const center = input.document.issuer.businessName || 'Il tuo centro';
    const reference = `Preventivo ${input.document.displayNumber}`;
    const expires = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome' }).format(input.expiresAt);
    const text = `${input.message}\n\n${reference}\n${input.url}\n\nPuoi consultare e stampare il documento. Il link è valido fino al ${expires}.`;
    const result = await transporter.sendMail({
        from: { name: center, address: env.emailFrom }, to: input.recipient,
        subject: `${reference} - ${center}`, text,
        html: `<div lang='it'><p>${escapeHtml(input.message).replace(/\n/g, '<br>')}</p><p><a href='${escapeHtml(input.url)}'>Apri ${escapeHtml(reference)}</a></p><p>Il link è valido fino al ${expires}.</p></div>`
    });
    const accepted = Array.isArray(result.accepted) ? result.accepted : [];
    if (!accepted.some((entry: string | { address: string }) => String(typeof entry === 'string' ? entry : entry.address).toLowerCase() === input.recipient.toLowerCase())) {
        throw new QuoteFlowError(502, 'Il server email non ha accettato il destinatario. Controlla l’indirizzo e riprova');
    }
}

/** Small seam for deterministic transport tests; production always uses the SMTP implementation. */
export const quoteDeliveryTransport = { send: sendQuoteMail };

export function definitelyUnsent(error: unknown): boolean {
    const value = error as { statusCode?: number; code?: string; command?: string; responseCode?: number };
    return value?.statusCode === 502 || ['EAUTH', 'EENVELOPE', 'ECONNREFUSED', 'ENOTFOUND'].includes(value?.code ?? '')
        || (value?.command === 'CONN') || (typeof value?.responseCode === 'number' && value.responseCode >= 400);
}

function resultFor(req: Request, delivery: Model, quote: Model): Record<string, unknown> {
    return {
        delivery: quoteDeliveryView(delivery), url: quoteShareUrl(getCurrentTenantId(req), String(delivery.get('id'))),
        expiresAt: delivery.get('expiresAt'), quoteStatus: quote.get('status')
    };
}

export async function deliverQuote(req: Request, channel: QuoteDeliveryChannel): Promise<Record<string, unknown>> {
    const idempotencyKey = String(req.header('Idempotency-Key') ?? '').trim();
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(idempotencyKey)) throw new QuoteFlowError(400, 'Idempotency-Key obbligatoria e non valida');
    const source = req.body ?? {};
    const tenantId = getCurrentTenantId(req);
    const schema = req.tenantSchema!;
    const prepared = await sequelize.transaction(async transaction => {
        const quote = await loadScopedQuote(req, transaction);
        const patient = await accessibleQuotePatient(req, quote.get('patientId'), transaction);
        if (!quoteConsentAllows(channel, plain(patient))) throw new QuoteFlowError(422, `Il paziente ha rifiutato le comunicazioni ${channel === 'email' ? 'email' : 'WhatsApp'}`);
        const recipient = quoteRecipient(channel, source.recipient, plain(patient));
        if (!recipient) throw new QuoteFlowError(422, channel === 'email' ? 'Inserisci un indirizzo email valido' : 'Inserisci un numero WhatsApp valido con prefisso internazionale');
        const message = String(source.message ?? quote.get('notes') ?? '').trim();
        if (message.length > 10000) throw new QuoteFlowError(422, 'Il messaggio è troppo lungo (massimo 10000 caratteri)');
        const requestHash = hash(JSON.stringify({ channel, recipient, message, saveToPatient: source.saveToPatient === true }));
        const existing = await QuoteDelivery.schema(schema).findOne({ where: { quoteId: quote.get('id'), idempotencyKey }, transaction });
        if (existing) {
            if (existing.get('requestHash') !== requestHash) throw new QuoteFlowError(409, 'La richiesta di invio è cambiata: usa una nuova operazione');
            const details = { delivery: quoteDeliveryView(existing) };
            if (existing.get('status') === 'FAILED') throw new QuoteFlowError(502, String(existing.get('lastError') || 'Invio non riuscito'), details);
            if (existing.get('revokedAt') || new Date(existing.get('expiresAt') as string).getTime() <= Date.now()) throw new QuoteFlowError(409, 'Il link di questa operazione è revocato o scaduto', details);
            if (existing.get('status') === 'PREPARING') throw new QuoteFlowError(409, String(existing.get('lastError') || 'Invio già in corso: controlla lo storico'), details);
            return { quote, delivery: existing, reused: true };
        }
        assertShareable(quote);
        await ensureNoPendingQuoteDelivery(req, quote.get('id'), transaction);
        if (source.saveToPatient === true) await savePatientContact(req, patient, channel, recipient, transaction);
        const document = await currentQuoteDocument(req, quote, transaction);
        const deliveryId = randomUUID();
        const expiresAt = expiry();
        const delivery = await QuoteDelivery.schema(schema).create({
            id: deliveryId, quoteId: quote.get('id'), patientId: quote.get('patientId'), channel, recipient, message,
            snapshot: document, snapshotHash: documentHash(document), requestHash, idempotencyKey,
            status: channel === 'email' ? 'PREPARING' : 'READY', createdByUserId: getUserId(req), expiresAt
        }, { transaction });
        await QuoteShareLink.create({ tenantId, quoteId: quote.get('id'), deliveryId,
            tokenHash: hash(quoteShareToken(tenantId, deliveryId)), expiresAt }, { transaction });
        return { quote, delivery, reused: false };
    });
    if (prepared.reused || channel === 'whatsapp') return resultFor(req, prepared.delivery, prepared.quote);
    const delivery = prepared.delivery;
    try {
        await quoteDeliveryTransport.send({
            recipient: String(delivery.get('recipient')), message: String(delivery.get('message')),
            url: quoteShareUrl(tenantId, String(delivery.get('id'))),
            document: delivery.get('snapshot') as QuoteDocumentSnapshot, expiresAt: new Date(delivery.get('expiresAt') as string)
        });
    } catch (error) {
        const unsent = definitelyUnsent(error);
        const message = unsent ? 'Email non inviata. Controlla il destinatario e riprova.'
            : 'Esito dell’invio non verificabile. L’email potrebbe essere arrivata: verifica prima di revocare il link e riprovare.';
        await sequelize.transaction(async transaction => {
            await delivery.update({ status: unsent ? 'FAILED' : 'PREPARING', lastError: message,
                ...(unsent ? { revokedAt: new Date() } : {}) }, { transaction });
            if (unsent) await QuoteShareLink.update({ revokedAt: new Date() }, { where: { tenantId, deliveryId: delivery.get('id') }, transaction });
        });
        throw new QuoteFlowError(502, message, { delivery: quoteDeliveryView(delivery) });
    }
    // This transaction is deliberately outside the transport catch: a DB failure after SMTP
    // acceptance has an uncertain outcome and must never trigger a second automatic send.
    return sequelize.transaction(async transaction => {
        const quote = await loadScopedQuote(req, transaction);
        const current = await QuoteDelivery.schema(schema).findByPk(String(delivery.get('id')), { transaction, lock: transaction.LOCK.UPDATE });
        if (!current || current.get('revokedAt')) throw new QuoteFlowError(409, 'Il link è stato revocato. Verifica l’esito dell’email nello storico');
        await current.update({ status: 'SENT', sentAt: new Date(), lastError: null }, { transaction });
        if (quote.get('status') === 'DRAFT') await quote.update({ status: 'SENT' }, { transaction });
        return resultFor(req, current, quote);
    });
}

export async function updateQuoteDelivery(req: Request, action: 'confirm' | 'revoke'): Promise<Record<string, unknown>> {
    return sequelize.transaction(async transaction => {
        const quote = await loadScopedQuote(req, transaction);
        if (!validQuoteUuid(req.params.deliveryId)) throw new QuoteFlowError(404, 'Consegna non trovata');
        const delivery = await QuoteDelivery.schema(req.tenantSchema!).findOne({
            where: { id: req.params.deliveryId, quoteId: quote.get('id') }, transaction, lock: transaction.LOCK.UPDATE
        });
        if (!delivery) throw new QuoteFlowError(404, 'Consegna non trovata');
        if (action === 'revoke') {
            const stale = Date.now() - new Date(delivery.get('createdAt') as string).getTime() > 5 * 60 * 1000;
            if (delivery.get('status') === 'PREPARING' && !delivery.get('lastError') && !stale) throw new QuoteFlowError(409, 'Attendi la conclusione dell’invio prima di revocare il link');
            if (!delivery.get('revokedAt')) {
                const revokedAt = new Date();
                await delivery.update({ revokedAt }, { transaction });
                await QuoteShareLink.update({ revokedAt }, { where: { tenantId: getCurrentTenantId(req), deliveryId: delivery.get('id') }, transaction });
            }
        } else {
            if (delivery.get('channel') !== 'whatsapp') throw new QuoteFlowError(409, 'La conferma manuale è disponibile solo per WhatsApp');
            if (delivery.get('revokedAt') || new Date(delivery.get('expiresAt') as string).getTime() <= Date.now()) throw new QuoteFlowError(409, 'Il link è revocato o scaduto');
            if (delivery.get('status') !== 'SENT') {
                assertShareable(quote);
                if (delivery.get('status') !== 'READY') throw new QuoteFlowError(409, 'Il messaggio WhatsApp non è pronto');
                const sentAt = new Date();
                await delivery.update({ status: 'SENT', sentAt, confirmedAt: sentAt, confirmedByUserId: getUserId(req) }, { transaction });
                if (quote.get('status') === 'DRAFT') await quote.update({ status: 'SENT' }, { transaction });
            }
        }
        return { delivery: quoteDeliveryView(delivery), quoteStatus: quote.get('status') };
    });
}

export async function publicQuoteDocument(token: string): Promise<{ document: QuoteDocumentSnapshot; expiresAt: unknown }> {
    const unavailable = () => new QuoteFlowError(404, 'Link non valido o scaduto');
    if (!/^[a-f0-9]{64}$/i.test(token)) throw unavailable();
    const link = await QuoteShareLink.findOne({ where: { tokenHash: hash(token), revokedAt: null, expiresAt: { [Op.gt]: new Date() } } });
    if (!link) throw unavailable();
    const tenantId = String(link.get('tenantId'));
    if (!validQuoteUuid(tenantId)) throw unavailable();
    if (!await Tenant.findByPk(tenantId, { attributes: ['id'] })) throw unavailable();
    const schema = 'rehablo_' + tenantId.replace(/-/g, '');
    const delivery = await QuoteDelivery.schema(schema).findOne({ where: { id: link.get('deliveryId'), quoteId: link.get('quoteId'), revokedAt: null } });
    if (!delivery || delivery.get('status') === 'FAILED') throw unavailable();
    const quote = await Quote.schema(schema).findByPk(String(delivery.get('quoteId')));
    if (!quote || quote.get('patientId') !== delivery.get('patientId')) throw unavailable();
    return { document: delivery.get('snapshot') as QuoteDocumentSnapshot, expiresAt: link.get('expiresAt') };
}
