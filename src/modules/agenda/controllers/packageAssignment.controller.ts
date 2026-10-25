import {Op} from 'sequelize';
import {packagePatient} from '../../administration/services/carePackage.service.js';
import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendErrorResponse, sendSuccessResponse} from '../../../utils/response.js';
import {getGrantedPermissions, getSelectedStructureId, getUserId} from '../../../middleware/rbac.js';
import {resolveGrantedScope} from '../../auth/rbac/permissions.js';
import Patient from '../../patients/models/patient.model.js';
import {canAccessAppointmentFinance} from '../services/appointmentFinancialAccess.service.js';
import AgendaEvent from '../models/agendaEvent.model.js';
import {eligibleCarePackages, appointmentCarePackageOptions} from '../services/packageAssignment.service.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
async function bookingOrigins(req: any, patientId: string, target: {structureId: string; calendarId: string}) {
    const includeCatalog = canAccessAppointmentFinance(req, target, 'care_package', 'read');
    let includeLegacy = false;
    if (req.user?.isSuperAdmin || resolveGrantedScope(getGrantedPermissions(req), 'quote', 'read')) {
        try {await packagePatient(req, patientId, 'quote', 'read'); includeLegacy = true;}
        catch (error) {if (![403, 404].includes((error as {statusCode?: number}).statusCode ?? 0)) throw error;}
    }
    return {includeCatalog, includeLegacy};
}
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
    if (!canAccessAppointmentFinance(req, {structureId, calendarId}, 'agenda', agendaEventId ? 'update' : 'create')) return sendErrorResponse(res, 403, 'Non puoi prenotare su questa agenda.');
    const origins = await bookingOrigins(req, patientId, {structureId, calendarId});
    if (!origins.includeCatalog && !origins.includeLegacy) return sendErrorResponse(res, 403, 'Non puoi consultare i pacchetti per questa agenda.');
    const items = await eligibleCarePackages(req.tenantSchema!, {patientId, structureId, eventTypeId, start, agendaEventId, ...origins});
    return sendSuccessResponse(res, 200, {items});
});

/** Unlike /eligible, this exposes unavailable choices as contextual explanations, without money data. */
export const listAppointmentCarePackageOptions = asyncHandler(async (req, res) => {
    const requiredUuid = (name: string): string => {
        const value = req.query[name];
        if (typeof value !== 'string' || !uuid.test(value)) throw Object.assign(new Error('Paziente e agenda devono essere validi.'), {statusCode: 422});
        return value;
    };
    const optionalUuid = (name: string): string | undefined => {
        if (req.query[name] === undefined) return undefined;
        const value = req.query[name];
        if (typeof value !== 'string' || !uuid.test(value)) throw Object.assign(new Error('Contesto dell’appuntamento non valido.'), {statusCode: 422});
        return value;
    };
    const patientId = requiredUuid('patientId'), calendarId = requiredUuid('calendarId');
    const eventTypeId = optionalUuid('eventTypeId'), agendaEventId = optionalUuid('agendaEventId');
    const rawStart = req.query.start;
    let start: string | undefined;
    if (rawStart !== undefined) {
        const day = typeof rawStart === 'string' ? rawStart.slice(0, 10) : '';
        const dayDate = new Date(day + 'T12:00:00Z');
        if (typeof rawStart !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(rawStart)
            || !Number.isFinite(Date.parse(rawStart)) || !Number.isFinite(dayDate.getTime())
            || dayDate.toISOString().slice(0, 10) !== day) return sendErrorResponse(res, 422, 'Data dell’appuntamento non valida.');
        start = rawStart;
    }
    if (req.query.recurring !== undefined && req.query.recurring !== 'true' && req.query.recurring !== 'false') {
        return sendErrorResponse(res, 422, 'Ricorrenza non valida.');
    }
    const structureId = getSelectedStructureId(req);
    if (!structureId || !uuid.test(structureId)) return sendErrorResponse(res, 422, 'Seleziona una sede valida.');
    const patient = await Patient.schema(req.tenantSchema!).findOne({where: {id: patientId, structureId}});
    if (!patient) return sendErrorResponse(res, 404, 'Paziente non disponibile nella sede.');
    let currentEvent: Record<string, any> | undefined;
    if (agendaEventId) {
        const event = await AgendaEvent.schema(req.tenantSchema!).findOne({where: {[Op.and]: [
            {id: agendaEventId, structureId}, {[Op.or]: [{patientId}, {patient: {id: patientId} as any}]}
        ]}});
        if (!event) return sendErrorResponse(res, 404, 'Appuntamento non disponibile.');
        currentEvent = event.get({plain: true});
        if (!canAccessAppointmentFinance(req, currentEvent!, 'agenda', 'update')) {
            return sendErrorResponse(res, 403, 'Non puoi modificare questo appuntamento.');
        }
    }
    const target = {structureId, calendarId};
    if (!canAccessAppointmentFinance(req, target, 'agenda', agendaEventId ? 'update' : 'create')) {
        return sendErrorResponse(res, 403, 'Non puoi consultare i pacchetti per questa agenda.');
    }
    const origins = await bookingOrigins(req, patientId, target);
    if (!origins.includeCatalog && !origins.includeLegacy) return sendErrorResponse(res, 403, 'Non puoi consultare i pacchetti per questa agenda.');
    const items = await appointmentCarePackageOptions(req.tenantSchema!, {
        patientId, calendarId, structureId, eventTypeId, start, agendaEventId,
        recurring: req.query.recurring === 'true', ...origins, currentEvent
    });
    return sendSuccessResponse(res, 200, {items});
});
