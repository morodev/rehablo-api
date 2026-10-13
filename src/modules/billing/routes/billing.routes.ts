import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import * as billing from '../controllers/billing.controller.js';

const router = Router();
router.get('/billing/catalog', billing.catalog);
router.get('/billing', requireAuth, billing.summary);
router.post('/billing/preview', requireAuth, billing.preview);
router.post('/billing/change', requireAuth, billing.change);
router.post('/billing/checkout', requireAuth, billing.checkout);
router.post('/billing/portal', requireAuth, billing.portal);
router.post('/billing/cancel', requireAuth, billing.cancel);
router.delete('/billing/schedule', requireAuth, billing.releaseSchedule);
export default router;
