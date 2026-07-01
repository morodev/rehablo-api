import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';

import exerciseController from '../controllers/exercise.controller.js';
import protocolTemplateController from '../controllers/protocolTemplate.controller.js';
import protocolInstanceController from '../controllers/protocolInstance.controller.js';
import protocolPhaseInstanceController from '../controllers/protocolPhaseInstance.controller.js';
import protocolExerciseLogController from '../controllers/protocolExerciseLog.controller.js';

const router = Router();

router.use(requireAuth, resolveTenantSchema);

// Global exercises catalog (public schema, shared by every tenant)
router.post('/exercises', exerciseController.saveExercise);
router.get('/exercises', exerciseController.findAllExercises);
router.get('/exercises/search', exerciseController.searchExercises);
router.get('/exercises/:exerciseId', exerciseController.findOneExercise);
router.put('/exercises/:exerciseId', exerciseController.updateExercise);
router.delete('/exercises/:exerciseId', exerciseController.deleteExercise);

// Reusable protocol templates catalog (public schema): phases + prescribed exercises
router.post('/protocol-templates', protocolTemplateController.saveProtocolTemplate);
router.get('/protocol-templates', protocolTemplateController.findAllProtocolTemplates);
router.get('/protocol-templates/search', protocolTemplateController.searchProtocolTemplates);
router.get('/protocol-templates/:protocolTemplateId', protocolTemplateController.findOneProtocolTemplate);
router.put('/protocol-templates/:protocolTemplateId', protocolTemplateController.updateProtocolTemplate);
router.delete('/protocol-templates/:protocolTemplateId', protocolTemplateController.deleteProtocolTemplate);

// Protocols assigned to a patient (tenant-scoped)
router.post('/protocol-instances', protocolInstanceController.assignProtocol);
router.get('/protocol-instances', protocolInstanceController.findAllProtocolInstances);
router.get('/protocol-instances/:protocolInstanceId', protocolInstanceController.findOneProtocolInstance);
router.put('/protocol-instances/:protocolInstanceId', protocolInstanceController.updateProtocolInstance);
router.delete('/protocol-instances/:protocolInstanceId', protocolInstanceController.deleteProtocolInstance);

// Phase progression (tenant-scoped)
router.put('/protocol-phase-instances/:protocolPhaseInstanceId', protocolPhaseInstanceController.updateProtocolPhaseInstance);
router.put('/protocol-phase-instances/:protocolPhaseInstanceId/advance', protocolPhaseInstanceController.advanceProtocolPhase);

// Daily exercise adherence log (tenant-scoped)
router.post('/protocol-exercise-logs', protocolExerciseLogController.logExerciseExecution);
router.get('/protocol-exercise-logs', protocolExerciseLogController.findExerciseLogs);

export default router;

