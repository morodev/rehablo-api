import { Request, Response } from 'express';
import { sequelize } from '../../../config/database.js';
import { Op } from 'sequelize';
import { scopeWhere } from '../../../middleware/rbac.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import Patient from '../../patients/models/patient.model.js';
import PatientPortalAudit from '../models/patientPortalAudit.model.js';
import PatientAppointmentRequest from '../models/patientAppointmentRequest.model.js';

const types = new Set(['NEW', 'MOVE', 'CANCEL']);
const patientId = (req: Request) => String(req.user!.pid);

export const listPatientRequests = asyncHandler(async (req: Request, res: Response) => {
    const limit = 50, offset = Math.max(Number(req.query.offset) || 0, 0);
    const { rows, count } = await PatientAppointmentRequest.schema(req.tenantSchema!).findAndCountAll({
        where: { patientId: patientId(req) }, order: [['createdAt', 'DESC']], limit, offset
    });
    return sendSuccessResponse(res, 200, { items: rows.map(row => ({ id: row.get('id'), type: row.get('type'),
        message: row.get('message'), agendaEventId: row.get('agendaEventId'), status: row.get('status'),
        staffNote: row.get('staffNote'), createdAt: row.get('createdAt'), resolvedAt: row.get('resolvedAt') })),
        total: count, limit, offset });
});

export const createPatientRequest = asyncHandler(async (req: Request, res: Response) => {
    if (req.patientPortalAccess?.get('status') !== 'ACTIVE') return sendErrorResponse(res, 403, 'La cartella storica è di sola lettura');
    const type = String(req.body?.type ?? '').toUpperCase();
    const message = String(req.body?.message ?? '').trim();
    if (!types.has(type) || !message || message.length > 2000) return sendErrorResponse(res, 422, 'Inserisci una richiesta valida (massimo 2000 caratteri)');
    let event: AgendaEvent | null = null;
    if (type !== 'NEW') {
        if (typeof req.body?.agendaEventId !== 'string') return sendErrorResponse(res, 422, 'Seleziona un tuo appuntamento');
        event = await AgendaEvent.schema(req.tenantSchema!).findOne({ where: {
            id: req.body.agendaEventId, patientId: patientId(req)
        } });
        if (!event || event.get('status') === 'CANCELLED') return sendErrorResponse(res, 404, 'Appuntamento non disponibile');
    }
    const row = await PatientAppointmentRequest.schema(req.tenantSchema!).create({
        patientId: patientId(req), type, message, agendaEventId: event?.get('id') ?? null,
        originalStart: event?.get('start') ?? null
    });
    await PatientPortalAudit.schema(req.tenantSchema!).create({
        accessId: String(req.user!.patientAccessId), userId: String(req.user!.sub ?? req.user!.id),
        patientId: patientId(req), action: 'CREATE', resource: 'appointment_request',
        resourceId: String(row.get('id')), outcome: 'SUCCESS'
    });
    return sendSuccessResponse(res, 201, { id: row.get('id'), status: 'PENDING' }, 'Richiesta inviata al centro');
});

export const listStaffRequests = asyncHandler(async (req: Request, res: Response) => {
    const scope = scopeWhere(req, { structureField: 'structureId' });
    const patients = await Patient.schema(req.tenantSchema!).findAll({ where: scope, attributes: ['id', 'name', 'surname'] });
    const patientMap = new Map(patients.map(patient => [String(patient.get('id')),
        `${patient.get('name')} ${patient.get('surname') ?? ''}`.trim()]));
    const rows = await PatientAppointmentRequest.schema(req.tenantSchema!).findAll({
        where: { patientId: [...patientMap.keys()], status: req.query.status ? String(req.query.status) : 'PENDING' },
        order: [['createdAt', 'DESC']], limit: 100
    });
    return sendSuccessResponse(res, 200, rows.map(row => ({ ...row.get({ plain: true }),
        patientName: patientMap.get(String(row.get('patientId'))) })));
});

export const resolveStaffRequest = asyncHandler(async (req: Request, res: Response) => {
    const decision = String(req.body?.decision ?? '').toUpperCase();
    const note = String(req.body?.note ?? '').trim();
    if (!['APPROVED', 'REJECTED'].includes(decision) || note.length > 2000) return sendErrorResponse(res, 422, 'Esito non valido');
    const result = await sequelize.transaction(async transaction => {
        const row = await PatientAppointmentRequest.schema(req.tenantSchema!).findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!row || row.get('status') !== 'PENDING') return { error: 404, message: 'Richiesta non in attesa' };
        const patient = await Patient.schema(req.tenantSchema!).findOne({ where: {
            id: String(row.get('patientId')), ...scopeWhere(req, { structureField: 'structureId' })
        }, transaction });
        if (!patient) return { error: 404, message: 'Paziente non disponibile' };
        let eventId: string | null = null;
        if (decision === 'APPROVED') {
            eventId = String(req.body?.resolvedAgendaEventId ?? row.get('agendaEventId') ?? '');
            const event = await AgendaEvent.schema(req.tenantSchema!).findOne({ where: {
                id: eventId, patientId: String(row.get('patientId'))
            }, transaction });
            if (!event) return { error: 422, message: 'Collega un appuntamento del paziente già aggiornato in agenda' };
            if (row.get('type') === 'CANCEL' && event.get('status') !== 'CANCELLED') {
                return { error: 409, message: 'Annulla prima la seduta in agenda' };
            }
            if (row.get('type') !== 'CANCEL' && event.get('status') === 'CANCELLED') {
                return { error: 409, message: 'La seduta collegata è annullata' };
            }
            if (row.get('type') === 'MOVE' && new Date(event.get('start') as string).getTime() === new Date(row.get('originalStart') as string).getTime()) {
                return { error: 409, message: 'Sposta prima la seduta in agenda' };
            }
            if (row.get('type') === 'NEW' && new Date(event.get('createdAt') as string).getTime() < new Date(row.get('createdAt') as string).getTime()) {
                return { error: 409, message: 'Collega una nuova seduta creata dopo la richiesta' };
            }
        }
        await row.update({ status: decision, staffNote: note || null, resolvedAt: new Date(),
            resolvedByUserId: req.access!.userId, resolvedAgendaEventId: eventId }, { transaction });
        return { id: row.get('id'), status: decision };
    });
    if ('error' in result) return sendErrorResponse(res, result.error ?? 409, result.message ?? 'Richiesta non disponibile');
    return sendSuccessResponse(res, 200, result, 'Richiesta aggiornata');
});

export const candidateEvents = asyncHandler(async (req: Request, res: Response) => {
    const row = await PatientAppointmentRequest.schema(req.tenantSchema!).findByPk(req.params.id);
    if (!row) return sendErrorResponse(res, 404, 'Richiesta non disponibile');
    const patient = await Patient.schema(req.tenantSchema!).findOne({ where: {
        id: String(row.get('patientId')), ...scopeWhere(req, { structureField: 'structureId' })
    } });
    if (!patient) return sendErrorResponse(res, 404, 'Richiesta non disponibile');
    const where = row.get('type') === 'NEW'
        ? { patientId: String(row.get('patientId')), createdAt: { [Op.gte]: row.get('createdAt') as Date } }
        : { patientId: String(row.get('patientId')), id: String(row.get('agendaEventId')) };
    const events = await AgendaEvent.schema(req.tenantSchema!).findAll({ where,
        attributes: ['id', 'title', 'start', 'status'], order: [['createdAt', 'DESC']], limit: 30 });
    return sendSuccessResponse(res, 200, events);
});
