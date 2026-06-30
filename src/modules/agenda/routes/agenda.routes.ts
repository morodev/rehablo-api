import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import agendaController from '../controllers/agenda.controller.js';
import eventTypeController from '../controllers/eventType.controller.js';

const router = Router();

router.use(requireAuth, resolveTenantSchema);

// Agenda events
router.get('/agenda-events', agendaController.findAllAgendaEvents);
router.get('/agenda-dashboard', agendaController.eventDashboardWithFilter);
router.get('/agenda-events-by-users', agendaController.findAgendaEventsByUsers);
router.get('/agenda-events-patient', agendaController.findAppointmentsForPatientById);
router.get('/agenda-events-holidays', agendaController.findAllHolidays);
router.post('/agenda-event', agendaController.saveAgendaEvent);
router.patch('/agenda-event', agendaController.updateAgendaEvent);
router.delete('/agenda-event', agendaController.deleteAgendaEvent);
router.get('/agenda-event-exceptions', agendaController.getAllEventExceptions);
router.patch('/recurring-event', agendaController.updateRecurringEvent);
router.delete('/recurring-event', agendaController.deleteRecurringEvent);

// Event types
router.get('/event-type', eventTypeController.findAllEventType);
router.get('/event-type/:eventTypeId', eventTypeController.findEventById);
router.post('/event-type', eventTypeController.createEventType);
router.put('/event-type/:eventTypeId', eventTypeController.updateEventType);
router.delete('/event-type/:eventTypeId', eventTypeController.deleteEventType);
router.get('/event-type/search/event', eventTypeController.searchEventType);

export default router;

