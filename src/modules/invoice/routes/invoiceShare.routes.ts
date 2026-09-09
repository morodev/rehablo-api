import { Router } from 'express';
import { simpleRateLimit } from '../../../middleware/simpleRateLimit.js';
import invoiceShareController from '../controllers/invoiceShare.controller.js';

/**
 * Rotta anonima: è il link che il paziente riceve via email o WhatsApp.
 *
 * Sta in un router separato perché `invoice.routes.ts` applica `requireAuth` a tutto il proprio
 * router. Il rate limit non è decorativo: il token è l'unica credenziale, quindi va reso
 * inutilizzabile provare a indovinarlo.
 */
const router = Router();

router.get(
    '/public/invoice/:token',
    simpleRateLimit({ namespace: 'public-invoice', windowMs: 15 * 60 * 1000, max: 60 }),
    invoiceShareController.getPublicInvoice
);

export default router;
