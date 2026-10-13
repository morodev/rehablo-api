import { NextFunction, Request, Response } from 'express';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { BillingError } from '../services/billing.policy.js';
import { stripeBilling } from '../services/billingConfig.service.js';
import { billingCatalog, billingSummary, cancelBilling, changeBilling, checkoutBilling, handleBillingWebhook, portalBilling, previewBilling, releaseBillingSchedule } from '../services/billing.service.js';

function principal(req: Request) {
    if (req.user?.actor === 'patient' || !(req.user?.sub || req.user?.id)) throw new BillingError(403, 'Accesso riservato al personale.');
    return { tenantId: getCurrentTenantId(req), userId: (req.user?.sub || req.user?.id)! };
}
function handle(action: (req: Request) => Promise<unknown> | unknown) {
    return (req: Request, res: Response, next: NextFunction) => Promise.resolve().then(() => {
        res.setHeader('Cache-Control', 'no-store');
        return action(req);
    })
        .then(data => sendSuccessResponse(res, 200, data)).catch(error => {
            if (error instanceof BillingError) return sendErrorResponse(res, error.statusCode, error.message, { code: error.code });
            return next(error);
        });
}
export const catalog = handle(() => billingCatalog());
export const summary = handle(req => billingSummary(principal(req)));
export const preview = handle(req => previewBilling(principal(req), { users: req.body?.users, structures: req.body?.structures }));
export const change = handle(req => changeBilling(principal(req), req.body?.quoteId, req.body?.operationId, req.body?.returnTo));
export const checkout = handle(req => checkoutBilling(principal(req), req.body?.operationId, req.body?.returnTo));
export const portal = handle(req => portalBilling(principal(req)));
export const cancel = handle(req => cancelBilling(principal(req), req.body?.cancelAtPeriodEnd, req.body?.operationId));
export const releaseSchedule = handle(req => releaseBillingSchedule(principal(req), req.body?.operationId));

/** MUST be mounted with express.raw({type:'application/json'}) before any JSON parser. */
export async function billingWebhook(req: Request, res: Response, next: NextFunction) {
    let event;
    try {
        const signature = req.header('stripe-signature');
        if (!signature || !Buffer.isBuffer(req.body)) return sendErrorResponse(res, 400, 'Firma webhook mancante.');
        event = stripeBilling().webhooks.constructEvent(req.body, signature, process.env.STRIPE_BILLING_WEBHOOK_SECRET!);
    } catch { return sendErrorResponse(res, 400, 'Firma webhook non valida.'); }
    try { await handleBillingWebhook(event); return res.status(200).json({ received: true }); }
    catch (error) { return next(error); } // 5xx makes Stripe retry transient failures.
}
