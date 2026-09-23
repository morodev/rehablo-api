import { Router } from 'express';
import { simpleRateLimit } from '../../../middleware/simpleRateLimit.js';
import { getPublicDocument } from '../controllers/quoteDelivery.controller.js';

const router = Router();
router.get('/public/quote/:token', simpleRateLimit({ namespace: 'public-quote', windowMs: 15 * 60 * 1000, max: 60 }), getPublicDocument);
export default router;
