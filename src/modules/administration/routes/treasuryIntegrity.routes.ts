import {Router} from 'express';
import {requireAuth} from '../../../middleware/auth.js';
import {requirePermission} from '../../../middleware/rbac.js';
import {resolveTenantSchema} from '../../../middleware/tenantSchema.js';
import {requireAdministrationFeature} from '../middleware/administrationFeature.js';
import {getTreasuryIntegrity, repairTreasuryIntegrity} from '../controllers/treasuryIntegrity.controller.js';

const router = Router();
router.use(requireAuth, resolveTenantSchema, requireAdministrationFeature);
router.get('/administration/treasury-integrity', requirePermission('treasury', 'read'), getTreasuryIntegrity);
router.post('/administration/treasury-integrity/repair', requirePermission('treasury', 'update', 'structure'), repairTreasuryIntegrity);
export default router;
