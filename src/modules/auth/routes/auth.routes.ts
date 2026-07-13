import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import authController from '../controllers/auth.controller.js';
import tenantController from '../controllers/tenant.controller.js';
import userController from '../controllers/user.controller.js';
import structureController from '../controllers/structure.controller.js';

const router = Router();

// --- Authentication ---
router.post('/auth/login', authController.login);
router.post('/auth/login-premise/:premiseId', requireAuth, authController.loginPremise);
router.delete('/auth/logout', requireAuth, authController.logout);
router.post('/auth/login-token', authController.loginWithToken);

// --- Tenant (registration / subscription owner) ---
router.post('/tenant', tenantController.createTenant);
router.put('/tenant/:tenantId', requireAuth, tenantController.updateTenant);
router.get('/tenant/:tenantId', requireAuth, tenantController.findTenantById);

// --- Public account flows (no auth required: token-in-url based) ---
router.put('/user/verify/:verificationToken', userController.verificationAccount);
router.post('/send-verification', userController.sendVerificationEmail);
router.get('/user/forgot-password', userController.forgotPassword);
router.put('/user/reset-password/:resetPasswordToken', userController.resetPassword);

// --- Users (requires auth) ---
router.post('/user', requireAuth, userController.createUser);
router.get('/user', requireAuth, userController.findAllUsersTenantByTenantId);
router.patch('/user/:userId', requireAuth, userController.updateUser);
router.patch('/user/:userId/calendar-visibility', requireAuth, userController.updateUserCalendarVisibility);
router.patch('/user/:userId/calendar-color', requireAuth, userController.updateUserCalendarColor);
router.delete('/user/:userId', requireAuth, userController.deleteUser);

// --- Structures (premises) ---
router.post('/structure', requireAuth, structureController.saveStructureForTenant);
router.put('/structure/:structureId', requireAuth, structureController.updateStructureForTenant);
router.get('/structure', requireAuth, structureController.findAllStructuresForTenant);

export default router;

