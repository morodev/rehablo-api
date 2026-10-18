import {Router} from 'express';
import {requireAuth} from '../../../middleware/auth.js';
import {requirePermission} from '../../../middleware/rbac.js';
import {resolveTenantSchema} from '../../../middleware/tenantSchema.js';
import analyticsController from '../controllers/analytics.controller.js';
import {getAccess, getDataset, exportDataset, getPersonal, reportReadScope} from '../controllers/reporting.controller.js';

const router = Router();
router.use(requireAuth, resolveTenantSchema);
router.get('/reports/access', requirePermission('analytics', 'read'), getAccess);
router.get('/reports/personal', requirePermission('dashboard', 'read'), getPersonal);
router.get('/reports/datasets/:dataset/export', requirePermission('analytics', 'export'), exportDataset);
router.get('/reports/datasets/:dataset', requirePermission('analytics', 'read'), reportReadScope, getDataset);

// Compatibility endpoints use the same report authorization and database-derived site boundary.
router.get('/reports/analytics/summary', requirePermission('analytics', 'read'), reportReadScope, analyticsController.getSummary);
router.get('/reports/analytics/activity', requirePermission('analytics', 'read'), reportReadScope, analyticsController.getActivity);
router.get('/reports/analytics/therapy-payments', requirePermission('analytics', 'read'), reportReadScope, analyticsController.getTherapyPayments);
router.get('/reports/analytics/finance', requirePermission('analytics', 'read'), reportReadScope, analyticsController.getFinance);
router.get('/reports/analytics/operators', requirePermission('analytics', 'read'), reportReadScope, analyticsController.getOperators);
router.get('/reports/analytics/catalog', requirePermission('analytics', 'read'), reportReadScope, analyticsController.getCatalog);
router.get('/reports/analytics/patients', requirePermission('analytics', 'read'), reportReadScope, analyticsController.getPatients);
router.get('/reports/receivables', requirePermission('analytics', 'read'), reportReadScope, analyticsController.getReceivables);
export default router;
