import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import evaluationController from '../controllers/evaluation.controller.js';

const router = Router();

router.use(requireAuth, resolveTenantSchema);

router.post('/evaluation', evaluationController.createEvaluation);
router.get('/evaluation', evaluationController.getEvaluations);
router.get('/evaluation/:evaluationId', evaluationController.getEvaluationById);
router.put('/evaluation/:evaluationId', evaluationController.updateEvaluation);
router.post('/evaluation/:evaluationId/clone', evaluationController.cloneEvaluationHandler);
router.delete('/evaluation/:evaluationId', evaluationController.deleteEvaluation);

export default router;

