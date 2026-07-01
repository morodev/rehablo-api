import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import invoiceController from '../controllers/invoice.controller.js';

const router = Router();

router.use(requireAuth, resolveTenantSchema);

router.post('/invoice', invoiceController.saveInvoice);
router.get('/invoice', invoiceController.findAllInvoices);
router.get('/invoice/search', invoiceController.searchInvoices);
router.get('/invoice/export/sistema-ts', invoiceController.exportSistemaTS);
router.get('/invoice/:invoiceId', invoiceController.findOneInvoice);
router.put('/invoice/:invoiceId', invoiceController.updateInvoice);
router.delete('/invoice/:invoiceId', invoiceController.deleteInvoice);

export default router;

