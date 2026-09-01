import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import agendaController from '../controllers/agenda.controller.js';
import eventTypeController from '../controllers/eventType.controller.js';
import timeOffController from '../controllers/timeOff.controller.js';

const router = Router();

router.use(requireAuth, resolveTenantSchema);

// Agenda events
router.get('/agenda-events', requirePermission('agenda', 'read'), agendaController.findAllAgendaEvents);
router.get('/agenda-dashboard', requirePermission('agenda', 'read'), agendaController.eventDashboardWithFilter);
router.get('/agenda-events-by-users', requirePermission('agenda', 'read'), agendaController.findAgendaEventsByUsers);
router.get('/agenda-events-patient', requirePermission('agenda', 'read'), agendaController.findAppointmentsForPatientById);
router.get('/agenda-events-holidays', requirePermission('agenda', 'read'), agendaController.findAllHolidays);
router.post('/agenda-event', requirePermission('agenda', 'create'), agendaController.saveAgendaEvent);
router.patch('/agenda-event', requirePermission('agenda', 'update'), agendaController.updateAgendaEvent);
router.patch('/agenda-events/reassign-operator', requirePermission('agenda', 'update', 'structure'), agendaController.reassignDeferredOperatorEvents);
router.patch('/agenda-event/:agendaEventId/payment', requirePermission('agenda', 'update'), agendaController.updateAppointmentPayment);
router.patch('/agenda-event/:agendaEventId/missed-arrival/report', requirePermission('agenda', 'update'), agendaController.reportMissedArrival);
router.patch('/agenda-event/:agendaEventId/missed-arrival/resolve', requirePermission('agenda', 'update'), agendaController.resolveMissedArrival);
router.patch('/agenda-event/:agendaEventId/no-show-billing', requirePermission('agenda', 'update'), agendaController.updateNoShowBillingDecision);
router.delete('/agenda-event', requirePermission('agenda', 'delete'), agendaController.deleteAgendaEvent);
router.get('/agenda-event-exceptions', requirePermission('agenda', 'read'), agendaController.getAllEventExceptions);
router.patch('/recurring-event', requirePermission('agenda', 'update'), agendaController.updateRecurringEvent);
router.delete('/recurring-event', requirePermission('agenda', 'delete'), agendaController.deleteRecurringEvent);

// Ferie e permessi: dominio separato dagli appuntamenti con paziente.
router.get('/time-off-requests', requirePermission('agenda', 'read'), timeOffController.getTimeOffRequests);
router.post('/time-off-requests', requirePermission('agenda', 'create'), timeOffController.createTimeOffRequest);
router.get('/time-off-requests/:timeOffRequestId', requirePermission('agenda', 'read'), timeOffController.getTimeOffRequestById);
router.get('/time-off-requests/:timeOffRequestId/history', requirePermission('agenda', 'read'), timeOffController.getTimeOffRequestHistory);
router.patch('/time-off-requests/:timeOffRequestId', requirePermission('agenda', 'update'), timeOffController.updateTimeOffRequest);
router.patch('/time-off-requests/:timeOffRequestId/approve', requirePermission('agenda', 'update', 'structure'), timeOffController.approveTimeOffRequest);
router.patch('/time-off-requests/:timeOffRequestId/reject', requirePermission('agenda', 'update', 'structure'), timeOffController.rejectTimeOffRequest);
router.patch('/time-off-requests/:timeOffRequestId/cancel', requirePermission('agenda', 'update'), timeOffController.cancelTimeOffRequest);
router.patch('/time-off-requests/:timeOffRequestId/revoke', requirePermission('agenda', 'update', 'structure'), timeOffController.revokeTimeOffRequest);

// Event types: sono configurazione condivisa della struttura, non dati del singolo
// professionista. Lo scope minimo `structure` esclude chi gestisce solo la propria agenda.
router.get('/event-type', requirePermission('agenda', 'read'), eventTypeController.findAllEventType);
router.get('/event-type/:eventTypeId', requirePermission('agenda', 'read'), eventTypeController.findEventById);
router.post('/event-type', requirePermission('agenda', 'create', 'structure'), eventTypeController.createEventType);
router.put('/event-type/:eventTypeId', requirePermission('agenda', 'update', 'structure'), eventTypeController.updateEventType);
router.patch('/event-type/:eventTypeId/default', requirePermission('agenda', 'update', 'structure'), eventTypeController.setDefaultEventType);
router.delete('/event-type/:eventTypeId', requirePermission('agenda', 'delete', 'structure'), eventTypeController.deleteEventType);
router.get('/event-type/search/event', requirePermission('agenda', 'read'), eventTypeController.searchEventType);

export default router;

