import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import patientController from '../controllers/patient.controller.js';

const router = Router();

router.use(requireAuth, resolveTenantSchema);

// Ogni rotta dichiara il permesso richiesto: `requirePermission` popola `req.access.scope`,
// che il controller usa con `scopeWhere()` per filtrare i dati (own / structure / tenant).
router.post('/patient', requirePermission('patient', 'create'), patientController.savePatient);
router.get('/patient/search', requirePermission('patient', 'read'), patientController.searchPatients);
router.get('/patient', requirePermission('patient', 'read'), patientController.findAndCountAll);
router.get('/patient/:patientId/consents', requirePermission('patient', 'read'), patientController.getConsentHistory);
router.get('/patient/:patientId', requirePermission('patient', 'read'), patientController.findOne);
router.put('/patient/:patientId', requirePermission('patient', 'update'), patientController.update);
router.delete('/patient/:patientId', requirePermission('patient', 'delete'), patientController.deletePatient);

export default router;

