import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { requireAnyPermission, requirePermission } from '../../../middleware/rbac.js';
import authController from '../controllers/auth.controller.js';
import rbacController from '../controllers/rbac.controller.js';
import tenantController from '../controllers/tenant.controller.js';
import userController from '../controllers/user.controller.js';
import structureController from '../controllers/structure.controller.js';
import sessionController from '../controllers/session.controller.js';
import { simpleRateLimit } from '../../../middleware/simpleRateLimit.js';

const router = Router();

// --- Authentication ---
router.post('/auth/login', authController.login);
router.post(
    '/auth/session',
    simpleRateLimit({ namespace: 'auth-session', windowMs: 15 * 60 * 1000, max: 20 }),
    sessionController.createSession
);
router.post('/auth/session/context', sessionController.selectSessionContext);
router.get('/auth/session/contexts', requireAuth, sessionController.listSessionContexts);
// Refresh e logout si autenticano con il refresh token nel body, non con l'access token:
// devono funzionare anche quando quest'ultimo è già scaduto (dura pochi minuti).
router.post('/auth/refresh', authController.refresh);
router.delete('/auth/logout', authController.logout);
router.post('/auth/login-premise/:premiseId', requireAuth, authController.loginPremise);
router.post('/auth/login-token', authController.loginWithToken);

// --- RBAC ---
router.get('/auth/me', requireAuth, rbacController.me);
router.get('/auth/me/permissions', requireAuth, rbacController.myPermissions);
router.get('/auth/roles', requireAuth, requirePermission('user', 'read'), rbacController.listRoles);
// Assegnazione ruoli: il ruolo base vive sulla membership del tenant, l'override sulla struttura.
router.patch('/user/:userId/role', requireAuth, requirePermission('user', 'update', 'tenant'), rbacController.updateUserRole);
router.patch('/user/:userId/structure-role', requireAuth, requirePermission('user', 'update', 'tenant'), rbacController.updateUserStructureRole);
router.put('/user/:userId/structures', requireAuth, requirePermission('user', 'update', 'tenant'), rbacController.updateUserStructures);

// --- Tenant (registration / subscription owner) ---
router.post('/tenant', tenantController.createTenant);
router.put('/tenant/:tenantId', requireAuth, requirePermission('tenant', 'update'), tenantController.updateTenant);
router.post('/tenant/:tenantId/logo', requireAuth, requirePermission('tenant', 'update'), tenantController.logoUploadMiddleware, tenantController.uploadTenantLogo);
router.get('/tenant/:tenantId/logo', requireAuth, requireAnyPermission(['tenant', 'read'], ['structure', 'read']), tenantController.getTenantLogo);
router.delete('/tenant/:tenantId/logo', requireAuth, requirePermission('tenant', 'update'), tenantController.removeTenantLogo);
// I dati dell'azienda servono anche in intestazione documenti/UI: basta poter leggere le strutture.
router.get('/tenant/:tenantId', requireAuth, requireAnyPermission(['tenant', 'read'], ['structure', 'read']), tenantController.findTenantById);

// --- Public account flows (no auth required: token-in-url based) ---
router.put('/user/verify/:verificationToken', userController.verificationAccount);
router.post('/send-verification', userController.sendVerificationEmail);
router.get('/user/forgot-password', userController.forgotPassword);
router.put('/user/reset-password/:resetPasswordToken', userController.resetPassword);

// --- Users (requires auth) ---
router.post('/user', requireAuth, requirePermission('user', 'create'), userController.createUser);
router.get('/user', requireAuth, requirePermission('user', 'read'), userController.findAllUsersTenantByTenantId);
router.patch('/user/:userId', requireAuth, requirePermission('user', 'update'), userController.updateUser);
// SELF-SERVICE: preferenze personali di calendario, modificabili da qualunque utente autenticato.
// TODO(RBAC): il controller deve verificare che `userId` coincida con `req.user.sub`,
// oppure che il chiamante abbia `user:update`.
router.patch('/user/:userId/calendar-visibility', requireAuth, userController.updateUserCalendarVisibility);
router.patch('/user/:userId/calendar-color', requireAuth, userController.updateUserCalendarColor);
// Attivazione/sospensione dell'account: è l'alternativa alla cancellazione per il titolare
// dello studio, che non è eliminabile. Riservata a chi amministra l'intero tenant.
router.patch('/user/:userId/status', requireAuth, requirePermission('user', 'update', 'tenant'), userController.setUserActive);
router.delete('/user/:userId', requireAuth, requirePermission('user', 'delete'), userController.deleteUser);

// --- Structures (premises) ---
router.post('/structure', requireAuth, requirePermission('structure', 'create'), structureController.saveStructureForTenant);
router.put('/structure/:structureId', requireAuth, requirePermission('structure', 'update'), structureController.updateStructureForTenant);
router.get('/structure/accessible', requireAuth, requirePermission('structure', 'read'), structureController.findAccessibleStructures);
router.get('/structure', requireAuth, requirePermission('structure', 'manage', 'tenant'), structureController.findAllStructuresForTenant);

export default router;

