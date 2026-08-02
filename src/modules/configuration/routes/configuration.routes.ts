import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import dashboardController from '../controllers/dashboard.controller.js';
import widgetController from '../controllers/widget.controller.js';

const router = Router();

router.use(requireAuth, resolveTenantSchema);

router.post('/dashboard', requirePermission('dashboard', 'create'), dashboardController.createDashboard);
router.get('/dashboard', requirePermission('dashboard', 'read'), dashboardController.getDashboardByPatientIdAndUserId);
router.put('/dashboard/:dashboardId', requirePermission('dashboard', 'update'), dashboardController.updateDashboard);
router.delete('/dashboard/:dashboardId', requirePermission('dashboard', 'delete'), dashboardController.deleteDashboard);

router.post('/widget', requirePermission('dashboard', 'update'), widgetController.addWidgetInDashboard);
router.put('/widget/:widgetId', requirePermission('dashboard', 'update'), widgetController.updateWidget);
router.delete('/widget/:widgetId', requirePermission('dashboard', 'update'), widgetController.deleteWidget);

export default router;

