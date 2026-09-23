import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { requireAnyPermission, requirePermission } from '../../../middleware/rbac.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import controller from '../controllers/administration.controller.js';
import * as views from '../controllers/administration.view.controller.js';
import { requireAdministrationFeature } from '../middleware/administrationFeature.js';
import * as quoteDelivery from '../controllers/quoteDelivery.controller.js';
import { getTreasuryExpense } from '../controllers/treasuryView.controller.js';
import { getDailyClosing, listDailyClosings, previewDailyClosing } from '../controllers/dailyClosing.controller.js';
import { previewFiscalSubmission } from '../controllers/fiscalSimulation.controller.js';

import { getFiscalSettings, updateFiscalSettings } from '../controllers/fiscalSettings.controller.js';

const router = Router();
router.use(requireAuth, resolveTenantSchema);

router.get('/administration/capabilities', requireAnyPermission(['tenant', 'read'], ['invoice', 'read'], ['price_list', 'read'], ['quote', 'read'], ['treasury', 'read'], ['expense', 'read'], ['supplier', 'read'], ['fiscal_submission', 'read'], ['accountant_export', 'read']), controller.getCapabilities);
router.patch('/administration/capabilities', requirePermission('tenant', 'update', 'tenant'), controller.updateCapabilities);
router.get('/administration/fiscal-settings', requireAnyPermission(['invoice', 'read'], ['invoice', 'create'], ['invoice', 'update'], ['fiscal_submission', 'create'], ['fiscal_submission', 'read'], ['tenant', 'read']), getFiscalSettings);
router.patch('/administration/fiscal-settings', requirePermission('tenant', 'update', 'tenant'), updateFiscalSettings);
router.use('/administration', requireAdministrationFeature);

const crud = (
    path: string,
    name: Parameters<typeof controller.list>[0],
    resource: Parameters<typeof requirePermission>[0],
    listHandler: ReturnType<typeof controller.list> = controller.list(name)
) => {
    router.get(path, requirePermission(resource, 'read'), listHandler);
    router.post(path, requirePermission(resource, 'create'), controller.create(name));
    router.patch(`${path}/:id`, requirePermission(resource, 'update'), controller.update(name));
    router.delete(`${path}/:id`, requirePermission(resource, 'delete'), controller.remove(name));
};

router.get('/administration/overview', requireAnyPermission(['treasury', 'read'], ['quote', 'read'], ['invoice', 'read']), views.overview);
router.get('/administration/reports', requirePermission('accountant_export', 'read'), views.reports);
router.get('/administration/documents', requirePermission('invoice', 'read'), views.listDocuments);
router.get('/administration/settings/documents', requirePermission('tenant', 'read'), views.getDocumentSettings);
router.patch('/administration/settings/documents', requirePermission('tenant', 'update', 'tenant'), views.updateDocumentSettings);
router.get('/administration/accountant-exports', requirePermission('accountant_export', 'export'), controller.accountantExport);

crud('/administration/billing-parties', 'billingParties', 'invoice');
crud('/administration/price-lists', 'priceLists', 'price_list', views.listPriceLists);
crud('/administration/price-list-versions', 'priceListVersions', 'price_list');
crud('/administration/price-list-items', 'priceListItems', 'price_list', views.listPriceListItems);
router.post('/administration/price-lists/:id/assign', requirePermission('price_list', 'update'), controller.assignPriceList);
router.get('/administration/pricing/resolve', requirePermission('price_list', 'read'), controller.pricingResolve);
router.post('/administration/price-list-versions/:id/publish', requirePermission('price_list', 'update'), controller.publishPriceListVersion);

crud('/administration/quotes', 'quotes', 'quote', views.listQuotes);
router.get('/administration/quotes/:id', requirePermission('quote', 'read'), views.getQuote);
router.get('/administration/quotes/:id/document', requirePermission('quote', 'read'), quoteDelivery.getDocument);
router.get('/administration/quotes/:id/deliveries', requirePermission('quote', 'read'), quoteDelivery.getDeliveries);
router.post('/administration/quotes/:id/share', requirePermission('quote', 'export'), quoteDelivery.share);
router.post('/administration/quotes/:id/send-email', requirePermission('quote', 'export'), quoteDelivery.sendEmail);
router.post('/administration/quotes/:id/deliveries/:deliveryId/confirm-whatsapp', requirePermission('quote', 'export'), quoteDelivery.confirmWhatsApp);
router.post('/administration/quotes/:id/deliveries/:deliveryId/revoke', requirePermission('quote', 'export'), quoteDelivery.revoke);
router.post('/administration/quotes/:id/accept', requirePermission('quote', 'update'), controller.acceptQuote);
router.post('/administration/quotes/:id/reject', requirePermission('quote', 'update'), controller.rejectQuote);
router.post('/administration/quotes/:id/create-package', requirePermission('quote', 'update'), controller.createPackageFromQuote);
crud('/administration/care-packages', 'carePackages', 'quote', views.listCarePackages);
crud('/administration/package-consumptions', 'packageConsumptions', 'quote');
router.post('/administration/care-packages/:id/consume', requirePermission('quote', 'update'), controller.consumePackage);
crud('/administration/patient-credits', 'patientCredits', 'quote', views.listPatientCredits);

crud('/administration/payment-methods', 'paymentMethods', 'treasury');
crud('/administration/financial-accounts', 'financialAccounts', 'treasury', views.listFinancialAccounts);
crud('/administration/treasury-movements', 'treasuryMovements', 'treasury', views.listTreasuryMovements);
router.post('/administration/treasury-movements/:id/void', requirePermission('treasury', 'update'), controller.voidMovement);
crud('/administration/payment-allocations', 'paymentAllocations', 'treasury');
crud('/administration/daily-closings', 'dailyClosings', 'treasury', listDailyClosings);
router.get('/administration/daily-closings/preview', requirePermission('treasury', 'read'), previewDailyClosing);
router.get('/administration/daily-closings/:id', requirePermission('treasury', 'read'), getDailyClosing);
crud('/administration/reconciliations', 'reconciliations', 'treasury');

crud('/administration/suppliers', 'suppliers', 'supplier');
crud('/administration/purchase-documents', 'purchaseDocuments', 'expense', views.listPurchaseDocuments);
crud('/administration/expenses', 'expenses', 'expense', views.listExpenses);
router.get('/administration/expenses/:id', requirePermission('expense', 'read'), getTreasuryExpense);

router.get('/administration/fiscal-submissions', requirePermission('fiscal_submission', 'read'), views.listFiscalSubmissions);
router.post('/administration/fiscal-submissions/preview', requirePermission('fiscal_submission', 'create'), previewFiscalSubmission);
router.post('/administration/fiscal-submissions', requirePermission('fiscal_submission', 'create'), controller.submitFiscal);
router.post('/administration/fiscal-submissions/:id/retry', requirePermission('fiscal_submission', 'create'), views.retryFiscalSubmission);

export default router;
