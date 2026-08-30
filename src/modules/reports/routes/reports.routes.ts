import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import analyticsController from '../controllers/analytics.controller.js';

const router = Router();
router.use(requireAuth, resolveTenantSchema);

router.get('/reports/analytics/summary', requirePermission('dashboard', 'read'), analyticsController.getSummary);
router.get('/reports/analytics/activity', requirePermission('dashboard', 'read'), analyticsController.getActivity);
router.get('/reports/analytics/finance', requirePermission('invoice', 'read'), analyticsController.getFinance);
router.get('/reports/analytics/operators', requirePermission('invoice', 'read'), analyticsController.getOperators);
router.get('/reports/analytics/catalog', requirePermission('invoice', 'read'), analyticsController.getCatalog);
router.get('/reports/analytics/patients', requirePermission('dashboard', 'read'), analyticsController.getPatients);
router.get('/reports/receivables', requirePermission('invoice', 'read'), analyticsController.getReceivables);

export default router;
