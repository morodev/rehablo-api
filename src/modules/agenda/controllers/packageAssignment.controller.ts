import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendErrorResponse, sendSuccessResponse} from '../../../utils/response.js';
import {getSelectedStructureId, getUserId} from '../../../middleware/rbac.js';
import Patient from '../../patients/models/patient.model.js';
import {canAccessAppointmentFinance} from '../services/appointmentFinancialAccess.service.js';
import AgendaEvent from '../models/agendaEvent.model.js';
import {eligibleCarePackages} from '../services/packageAssignment.service.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const listEligibleCarePackages = asyncHandler(async (req, res) => {
    const patientId = String(req.query.patientId ?? ''), eventTypeId = String(req.query.eventTypeId ?? ''), start = String(req.query.start ?? '');
    const agendaEventId = req.query.agendaEventId ? String(req.query.agendaEventId) : undefined;
    const calendarId = String(req.query.calendarId ?? getUserId(req) ?? '');
    const structureId = getSelectedStructureId(req);
    if (!structureId || !uuid.test(patientId) || !uuid.test(eventTypeId) || !Number.isFinite(Date.parse(start))
        || !uuid.test(calendarId) || (agendaEventId && !uuid.test(agendaEventId))) return sendErrorResponse(res, 422, 'Paziente, prestazione, data e sede sono obbligatori.');
    const patient = await Patient.schema(req.tenantSchema!).findOne({where: {id: patientId, structureId}});
    if (!patient) return sendErrorResponse(res, 404, 'Paziente non disponibile nella sede.');
    if (agendaEventId) {
        const event = await AgendaEvent.schema(req.tenantSchema!).findOne({where: {id: agendaEventId, patientId, structureId}});
        if (!event) return sendErrorResponse(res, 404, 'Appuntamento non disponibile.');
        if (!canAccessAppointmentFinance(req, event.get({plain:true}), 'agenda', 'update')) return sendErrorResponse(res, 403, 'Non puoi modificare questo appuntamento.');
    } else if (!canAccessAppointmentFinance(req, {structureId, calendarId}, 'agenda', 'create')) {
        return sendErrorResponse(res, 403, 'Non puoi prenotare su questa agenda.');
    }
    const items = await eligibleCarePackages(req.tenantSchema!, {patientId, structureId, eventTypeId, start, agendaEventId});
    return sendSuccessResponse(res, 200, {items});
});
