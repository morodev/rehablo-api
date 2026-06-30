import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import patientController from '../controllers/patient.controller.js';

const router = Router();

router.use(requireAuth, resolveTenantSchema);

router.post('/patient', patientController.savePatient);
router.get('/patient/search', patientController.searchPatients);
router.get('/patient', patientController.findAndCountAll);
router.get('/patient/:patientId', patientController.findOne);
router.put('/patient/:patientId', patientController.update);
router.delete('/patient/:patientId', patientController.deletePatient);

export default router;

