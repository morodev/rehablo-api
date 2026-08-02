import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import evaluationController from '../controllers/evaluation.controller.js';

const router = Router();

router.use(requireAuth, resolveTenantSchema);

router.post('/evaluation', requirePermission('evaluation', 'create'), evaluationController.createEvaluation);
router.get('/evaluation', requirePermission('evaluation', 'read'), evaluationController.getEvaluations);
router.get('/evaluation/:evaluationId', requirePermission('evaluation', 'read'), evaluationController.getEvaluationById);
router.put('/evaluation/:evaluationId', requirePermission('evaluation', 'update'), evaluationController.updateEvaluation);
router.post('/evaluation/:evaluationId/clone', requirePermission('evaluation', 'create'), evaluationController.cloneEvaluationHandler);
router.delete('/evaluation/:evaluationId', requirePermission('evaluation', 'delete'), evaluationController.deleteEvaluation);

export default router;

