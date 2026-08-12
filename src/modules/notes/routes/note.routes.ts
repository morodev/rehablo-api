import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import noteController from '../controllers/note.controller.js';
import reminderController from '../controllers/reminder.controller.js';

const router = Router();

router.use(requireAuth, resolveTenantSchema);

router.get('/notes', requirePermission('note', 'read'), noteController.getNotes);
router.post('/notes', requirePermission('note', 'create'), noteController.createNote);
router.get('/notes/:noteId', requirePermission('note', 'read'), noteController.getNoteById);
router.patch('/notes/:noteId', requirePermission('note', 'update'), noteController.updateNote);
router.delete('/notes/:noteId', requirePermission('note', 'delete'), noteController.deleteNote);

router.get('/reminders', requirePermission('reminder', 'read'), reminderController.getReminders);
router.post('/reminders', requirePermission('reminder', 'create'), reminderController.createReminder);
router.patch('/reminders/:reminderId', requirePermission('reminder', 'update'), reminderController.updateReminder);
router.patch('/reminders/:reminderId/complete', requirePermission('reminder', 'update'), reminderController.completeReminder);
router.patch('/reminders/:reminderId/snooze', requirePermission('reminder', 'update'), reminderController.snoozeReminder);
router.delete('/reminders/:reminderId', requirePermission('reminder', 'delete'), reminderController.deleteReminder);

export default router;
