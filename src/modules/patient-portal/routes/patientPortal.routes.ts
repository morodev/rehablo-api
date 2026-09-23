import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import { simpleRateLimit } from '../../../middleware/simpleRateLimit.js';
import { requirePatientPortalAccess } from '../middleware/patientPortalAuth.js';
import invitationController from '../controllers/patientPortalInvitation.controller.js';
import patientPortalController from '../controllers/patientPortal.controller.js';
import * as commerce from '../controllers/patientPortalCommerce.controller.js';
import * as appointmentRequests from '../controllers/patientAppointmentRequest.controller.js';
import * as publication from '../controllers/patientPortalPublication.controller.js';

const router = Router();

// Token monouso: nessuna informazione su altri centri viene esposta.
router.get('/patient-portal/invitations/:token', invitationController.invitationInfo);
router.post(
    '/patient-portal/invitations/:token/register',
    simpleRateLimit({ namespace: 'patient-invite-register', windowMs: 15 * 60 * 1000, max: 10 }),
    invitationController.acceptWithNewAccount
);
router.post(
    '/patient-portal/invitations/:token/accept-existing',
    simpleRateLimit({ namespace: 'patient-invite-existing', windowMs: 15 * 60 * 1000, max: 10 }),
    invitationController.acceptWithExistingAccount
);

// Gestione staff sulla singola anagrafica del tenant corrente.
router.post(
    '/patient/:patientId/portal-invitation',
    requireAuth,
    requirePermission('patient', 'update'),
    resolveTenantSchema,
    invitationController.invitePatient
);
router.get(
    '/patient/:patientId/portal-access',
    requireAuth,
    requirePermission('patient', 'read'),
    resolveTenantSchema,
    invitationController.getPatientPortalAccess
);
router.patch(
    '/patient/:patientId/portal-access',
    requireAuth,
    requirePermission('patient', 'update'),
    resolveTenantSchema,
    invitationController.updatePatientPortalAccess
);

const patientGuards = [requireAuth, requirePatientPortalAccess, resolveTenantSchema];
router.get('/patient-portal/overview', ...patientGuards, patientPortalController.overview);
router.get('/patient-portal/evaluations', ...patientGuards, patientPortalController.evaluations);
router.get('/patient-portal/evaluations/:evaluationId', ...patientGuards, patientPortalController.evaluationDetail);
router.get('/patient-portal/protocols', ...patientGuards, patientPortalController.protocols);
router.get('/patient-portal/protocols/:protocolId', ...patientGuards, patientPortalController.protocolDetail);
router.get('/patient-portal/measurements', ...patientGuards, patientPortalController.measurements);
router.get('/patient-portal/appointments', ...patientGuards, patientPortalController.appointments);
router.get('/patient-portal/invoices', ...patientGuards, patientPortalController.invoices);
router.get('/patient-portal/invoices/:invoiceId', ...patientGuards, patientPortalController.invoiceDetail);
router.get('/patient-portal/quotes', ...patientGuards, commerce.quotes);
router.get('/patient-portal/quotes/deliveries/:deliveryId', ...patientGuards, commerce.quoteDetail);
router.post('/patient-portal/quotes/:quoteId/deliveries/:deliveryId/accept', ...patientGuards, commerce.decideQuote('ACCEPTED'));
router.post('/patient-portal/quotes/:quoteId/deliveries/:deliveryId/reject', ...patientGuards, commerce.decideQuote('REJECTED'));
router.get('/patient-portal/packages', ...patientGuards, commerce.packages);
router.get('/patient-portal/credits', ...patientGuards, commerce.credits);
router.get('/patient-portal/appointment-requests', ...patientGuards, appointmentRequests.listPatientRequests);
router.post('/patient-portal/appointment-requests', ...patientGuards,
    simpleRateLimit({ namespace: 'patient-appointment-request', windowMs: 60 * 60 * 1000, max: 8 }),
    appointmentRequests.createPatientRequest);
router.get('/staff/patient-appointment-requests', requireAuth, requirePermission('agenda', 'update', 'structure'),
    resolveTenantSchema, appointmentRequests.listStaffRequests);
router.patch('/staff/patient-appointment-requests/:id', requireAuth, requirePermission('agenda', 'update', 'structure'),
    resolveTenantSchema, appointmentRequests.resolveStaffRequest);
router.get('/staff/patient-appointment-requests/:id/candidates', requireAuth, requirePermission('agenda', 'update', 'structure'),
    resolveTenantSchema, appointmentRequests.candidateEvents);
router.patch('/staff/patients/:patientId/portal/evaluations/:id', requireAuth, requirePermission('evaluation', 'update'),
    resolveTenantSchema, publication.publishEvaluation);
router.get('/staff/patients/:patientId/portal/content', requireAuth, requirePermission('evaluation', 'update'),
    resolveTenantSchema, publication.staffContent);
router.patch('/staff/patients/:patientId/portal/protocols/:id', requireAuth, requirePermission('protocol', 'update'),
    resolveTenantSchema, publication.publishProtocol);
router.get('/staff/patients/:patientId/portal/documents', requireAuth, requirePermission('evaluation', 'update'),
    resolveTenantSchema, publication.staffDocuments);
router.post('/staff/patients/:patientId/portal/documents', requireAuth, requirePermission('evaluation', 'update'),
    resolveTenantSchema, publication.sharedDocumentUpload, publication.uploadDocument);
router.patch('/staff/patients/:patientId/portal/documents/:id', requireAuth, requirePermission('evaluation', 'update'),
    resolveTenantSchema, publication.updateDocument);
router.get('/patient-portal/documents', ...patientGuards, publication.patientDocuments);
router.get('/patient-portal/documents/:id/download', ...patientGuards, publication.downloadDocument);

export default router;
