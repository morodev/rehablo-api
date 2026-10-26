import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { requireAnyPermission, requirePermission } from '../../../middleware/rbac.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import noteController from '../controllers/workItemNote.controller.js';
import noteImageController from '../controllers/noteImage.controller.js';
import reminderController from '../controllers/workItemReminder.controller.js';
import * as reminderNotificationController from '../controllers/reminderNotification.controller.js';

const router = Router();

router.use(requireAuth);
router.get('/reminder-notification-preferences', reminderNotificationController.getPreferences);
router.patch('/reminder-notification-preferences', reminderNotificationController.updatePreferences);
router.post('/reminder-push/subscriptions', reminderNotificationController.registerPushSubscription);
router.delete('/reminder-push/subscriptions', reminderNotificationController.removePushSubscription);
router.use(resolveTenantSchema);

router.post(
    '/note-images',
    requirePermission('note', 'create'),
    noteImageController.noteImageUploadMiddleware,
    noteImageController.uploadNoteImage
);
router.get(
    '/note-images/:imageId/content',
    requirePermission('note', 'read'),
    noteImageController.getNoteImageContent
);

router.get('/notes', requirePermission('note', 'read'), noteController.getNotes);
router.get('/note-assignees', requireAnyPermission(['note', 'create'], ['note', 'update']), noteController.getAssignableNoteUsers);
router.post('/notes', requirePermission('note', 'create'), noteController.createNote);
router.get('/notes/:noteId', requirePermission('note', 'read'), noteController.getNoteById);
router.patch('/notes/:noteId', requirePermission('note', 'update'), noteController.updateNote);
router.delete('/notes/:noteId', requirePermission('note', 'delete'), noteController.deleteNote);

router.get('/reminders', requirePermission('reminder', 'read'), reminderController.getReminders);
router.get('/reminder-assignees', requireAnyPermission(['reminder', 'create'], ['reminder', 'update']), reminderController.getAssignableReminderUsers);
router.post('/reminder-alerts/claim', requirePermission('reminder', 'read'), reminderController.claimReminderAlerts);
router.post('/reminders', requirePermission('reminder', 'create'), reminderController.createReminder);
router.get('/reminders/:reminderId', requirePermission('reminder', 'read'), reminderController.getReminderById);
router.patch('/reminders/:reminderId', requirePermission('reminder', 'update'), reminderController.updateReminder);
router.patch('/reminders/:reminderId/complete', requirePermission('reminder', 'update'), reminderController.completeReminder);
router.patch('/reminders/:reminderId/snooze', requirePermission('reminder', 'update'), reminderController.snoozeReminderAlert);
router.delete('/reminders/:reminderId', requirePermission('reminder', 'delete'), reminderController.deleteReminder);

export default router;
