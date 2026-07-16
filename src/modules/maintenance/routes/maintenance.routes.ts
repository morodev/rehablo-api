import { Router } from 'express';
import { requireAuth, requireSuperAdmin } from '../../../middleware/auth.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import maintenanceController from '../controllers/maintenance.controller.js';

const router = Router();

router.use(requireAuth, resolveTenantSchema);

// E4 — Pulizia dati clinici legacy (senza evaluationId). Operazione distruttiva: solo super-admin.
router.post('/maintenance/purge-legacy-clinical-data', requireSuperAdmin, maintenanceController.purgeLegacyClinicalData);

export default router;

