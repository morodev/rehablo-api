import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';

import exerciseController from '../controllers/exercise.controller.js';
import protocolTemplateController from '../controllers/protocolTemplate.controller.js';
import protocolInstanceController from '../controllers/protocolInstance.controller.js';
import protocolPhaseInstanceController from '../controllers/protocolPhaseInstance.controller.js';
import protocolExerciseLogController from '../controllers/protocolExerciseLog.controller.js';

const router = Router();

router.use(requireAuth, resolveTenantSchema);

// Global exercises catalog (public schema, shared by every tenant)
// ATTENZIONE: la scrittura qui impatta TUTTI i tenant, quindi richiede scope `tenant`.
router.post('/exercises', requirePermission('protocol', 'create', 'tenant'), exerciseController.saveExercise);
router.get('/exercises', requirePermission('protocol', 'read'), exerciseController.findAllExercises);
router.get('/exercises/search', requirePermission('protocol', 'read'), exerciseController.searchExercises);
router.get('/exercises/:exerciseId', requirePermission('protocol', 'read'), exerciseController.findOneExercise);
router.put('/exercises/:exerciseId', requirePermission('protocol', 'update', 'tenant'), exerciseController.updateExercise);
router.delete('/exercises/:exerciseId', requirePermission('protocol', 'delete', 'tenant'), exerciseController.deleteExercise);

// Reusable protocol templates catalog (public schema): phases + prescribed exercises
router.post('/protocol-templates', requirePermission('protocol', 'create', 'tenant'), protocolTemplateController.saveProtocolTemplate);
router.get('/protocol-templates', requirePermission('protocol', 'read'), protocolTemplateController.findAllProtocolTemplates);
router.get('/protocol-templates/search', requirePermission('protocol', 'read'), protocolTemplateController.searchProtocolTemplates);
router.get('/protocol-templates/:protocolTemplateId', requirePermission('protocol', 'read'), protocolTemplateController.findOneProtocolTemplate);
router.put('/protocol-templates/:protocolTemplateId', requirePermission('protocol', 'update', 'tenant'), protocolTemplateController.updateProtocolTemplate);
router.delete('/protocol-templates/:protocolTemplateId', requirePermission('protocol', 'delete', 'tenant'), protocolTemplateController.deleteProtocolTemplate);

// Protocols assigned to a patient (tenant-scoped)
router.post('/protocol-instances', requirePermission('protocol', 'create'), protocolInstanceController.assignProtocol);
router.get('/protocol-instances', requirePermission('protocol', 'read'), protocolInstanceController.findAllProtocolInstances);
router.get('/protocol-instances/:protocolInstanceId', requirePermission('protocol', 'read'), protocolInstanceController.findOneProtocolInstance);
router.put('/protocol-instances/:protocolInstanceId', requirePermission('protocol', 'update'), protocolInstanceController.updateProtocolInstance);
router.delete('/protocol-instances/:protocolInstanceId', requirePermission('protocol', 'delete'), protocolInstanceController.deleteProtocolInstance);

// Phase progression (tenant-scoped)
router.put('/protocol-phase-instances/:protocolPhaseInstanceId', requirePermission('protocol', 'update'), protocolPhaseInstanceController.updateProtocolPhaseInstance);
router.put('/protocol-phase-instances/:protocolPhaseInstanceId/advance', requirePermission('protocol', 'update'), protocolPhaseInstanceController.advanceProtocolPhase);

// Daily exercise adherence log (tenant-scoped)
router.post('/protocol-exercise-logs', requirePermission('protocol', 'create'), protocolExerciseLogController.logExerciseExecution);
router.get('/protocol-exercise-logs', requirePermission('protocol', 'read'), protocolExerciseLogController.findExerciseLogs);

export default router;

