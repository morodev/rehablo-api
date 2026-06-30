import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import dashboardController from '../controllers/dashboard.controller.js';
import widgetController from '../controllers/widget.controller.js';

const router = Router();

router.use(requireAuth, resolveTenantSchema);

router.post('/dashboard', dashboardController.createDashboard);
router.get('/dashboard', dashboardController.getDashboardByPatientIdAndUserId);
router.put('/dashboard/:dashboardId', dashboardController.updateDashboard);
router.delete('/dashboard/:dashboardId', dashboardController.deleteDashboard);

router.post('/widget', widgetController.addWidgetInDashboard);
router.put('/widget/:widgetId', widgetController.updateWidget);
router.delete('/widget/:widgetId', widgetController.deleteWidget);

export default router;

