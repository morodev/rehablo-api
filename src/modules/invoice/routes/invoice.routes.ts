import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import invoiceController from '../controllers/invoice.controller.js';

const router = Router();

router.use(requireAuth, resolveTenantSchema);

router.post('/invoice', requirePermission('invoice', 'create'), invoiceController.saveInvoice);
router.get('/invoice', requirePermission('invoice', 'read'), invoiceController.findAllInvoices);
router.get('/invoice/search', requirePermission('invoice', 'read'), invoiceController.searchInvoices);
router.get('/invoice/export/sistema-ts', requirePermission('invoice', 'export'), invoiceController.exportSistemaTS);
router.get('/invoice/:invoiceId', requirePermission('invoice', 'read'), invoiceController.findOneInvoice);
router.put('/invoice/:invoiceId', requirePermission('invoice', 'update'), invoiceController.updateInvoice);
router.delete('/invoice/:invoiceId', requirePermission('invoice', 'delete'), invoiceController.deleteInvoice);

export default router;

