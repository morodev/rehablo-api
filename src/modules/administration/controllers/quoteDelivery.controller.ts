import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { QuoteDelivery } from '../models/quoteDelivery.model.js';
import { QuoteFlowError } from '../services/quoteAccess.js';
import {
    currentQuoteDocument, deliverQuote, hasUnsharedQuoteChanges, loadScopedQuote,
    publicQuoteDocument, quoteDeliveryView, updateQuoteDelivery
} from '../services/quoteDelivery.service.js';

const handler = (action: (req: Request, res: Response) => Promise<unknown>) => asyncHandler(async (req, res) => {
    try { return await action(req, res); }
    catch (error) {
        if (error instanceof QuoteFlowError) return sendErrorResponse(res, error.statusCode, error.message, error.details);
        throw error;
    }
});

export const getDocument = handler(async (req, res) => {
    const quote = await loadScopedQuote(req);
    const document = await currentQuoteDocument(req, quote);
    return sendSuccessResponse(res, 200, { document, hasUnsharedChanges: await hasUnsharedQuoteChanges(req, document) });
});

export const getDeliveries = handler(async (req, res) => {
    const quote = await loadScopedQuote(req);
    const document = await currentQuoteDocument(req, quote);
    const deliveries = await QuoteDelivery.schema(req.tenantSchema!).findAll({ where: { quoteId: quote.get('id') }, order: [['createdAt', 'DESC']] });
    return sendSuccessResponse(res, 200, { items: deliveries.map(quoteDeliveryView), hasUnsharedChanges: await hasUnsharedQuoteChanges(req, document) });
});

export const share = handler(async (req, res) => {
    if (req.body?.channel !== undefined && req.body.channel !== 'whatsapp') return sendErrorResponse(res, 422, 'Scegli il canale WhatsApp');
    return sendSuccessResponse(res, 200, await deliverQuote(req, 'whatsapp'), 'Messaggio pronto per WhatsApp');
});
export const sendEmail = handler(async (req, res) => sendSuccessResponse(res, 200, await deliverQuote(req, 'email'), 'Email inviata'));
export const confirmWhatsApp = handler(async (req, res) => sendSuccessResponse(res, 200, await updateQuoteDelivery(req, 'confirm'), 'Invio confermato dall’operatore'));
export const revoke = handler(async (req, res) => sendSuccessResponse(res, 200, await updateQuoteDelivery(req, 'revoke'), 'Link revocato'));
export const getPublicDocument = handler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return sendSuccessResponse(res, 200, await publicQuoteDocument(String(req.params.token ?? '')));
});
