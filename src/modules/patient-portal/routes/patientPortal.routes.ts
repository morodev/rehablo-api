import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import { simpleRateLimit } from '../../../middleware/simpleRateLimit.js';
import { requirePatientPortalAccess } from '../middleware/patientPortalAuth.js';
import invitationController from '../controllers/patientPortalInvitation.controller.js';
import patientPortalController from '../controllers/patientPortal.controller.js';

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

export default router;
