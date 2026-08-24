import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { scopeWhere } from '../../../middleware/rbac.js';
import Patient from '../models/patient.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import { Evaluation } from '../../evaluations/models/index.js';
import Observation from '../../measurements/models/observation.model.js';
import ConsentEvent, { ConsentType } from '../../compliance/consent/consentEvent.model.js';
import { recordAuditEvent } from '../../compliance/audit/audit.service.js';

/**
 * Campi usati per il filtro row-level RBAC.
 * `userId` = professionista che ha in carico il paziente, `structureId` = sede di riferimento.
 * `structureId` è nullable: finché non viene fatto il backfill, i pazienti senza sede
 * restano visibili a chi ha scope `structure` (vedi ScopeFields.includeUnassigned).
 */
const PATIENT_SCOPE_FIELDS = {
    ownerField: 'userId',
    structureField: 'structureId',
    includeUnassigned: true
};

const CONSENT_FIELDS: Array<{ field: string; type: ConsentType; dateField?: string }> = [
    { field: 'privacyConsent', type: 'privacy', dateField: 'privacyConsentDate' },
    { field: 'stsOppositionToDataSending', type: 'sts_opposition' },
    { field: 'fseConsentFeeding', type: 'fse_feeding', dateField: 'fseConsentDate' },
    { field: 'fseConsentViewing', type: 'fse_viewing', dateField: 'fseConsentDate' }
];

function hasOwn(payload: Record<string, unknown>, field: string): boolean {
    return Object.prototype.hasOwnProperty.call(payload, field);
}

function readField(source: Patient | Record<string, unknown> | null | undefined, field: string): unknown {
    if (!source) return null;
    return typeof (source as any).get === 'function' ? (source as any).get(field) : source[field];
}

async function recordPatientAudit(
    req: Request,
    schema: string,
    action: string,
    patientId: string,
    metadata?: Record<string, unknown>
): Promise<void> {
    await recordAuditEvent({
        schema,
        tenantId: req.user!.tenants[0].id,
        actorId: req.user!.id,
        action,
        resource: 'patient',
        resourceId: patientId,
        patientId,
        metadata,
        req
    });
}

async function recordConsentChanges(params: {
    req: Request;
    schema: string;
    patientId: string;
    before?: Patient | Record<string, unknown> | null;
    after: Patient;
    payload: Record<string, unknown>;
}): Promise<void> {
    const { req, schema, patientId, before, after, payload } = params;
    const events: Array<{
        tenantId: string;
        patientId: string;
        operatorId: string;
        type: ConsentType;
        value: boolean;
        previousValue: boolean | null;
        policyVersion: string | null;
        source: string;
        occurredAt: Date;
        metadata: Record<string, unknown>;
    }> = [];

    for (const item of CONSENT_FIELDS) {
        if (!hasOwn(payload, item.field)) continue;

        const value = Boolean(readField(after, item.field));
        const previousRaw = readField(before, item.field);
        const previousValue = previousRaw === null || previousRaw === undefined ? null : Boolean(previousRaw);

        if (before && previousValue === value) continue;

        events.push({
            tenantId: req.user!.tenants[0].id,
            patientId,
            operatorId: req.user!.id,
            type: item.type,
            value,
            previousValue,
            policyVersion: (readField(after, 'privacyPolicyVersion') as string | null) ?? null,
            source: 'operator',
            occurredAt: item.dateField && readField(after, item.dateField)
                ? new Date(readField(after, item.dateField) as Date)
                : new Date(),
            metadata: { field: item.field }
        });
    }

    if (events.length > 0) {
        await ConsentEvent.schema(schema).bulkCreate(events);
        await recordPatientAudit(req, schema, 'patient.consent_changed', patientId, {
            changed: events.map((event) => event.type)
        });
    }
}

function getPagination(page?: string, size?: string) {
    const limit = size ? +size : 10;
    const offset = page ? +page * limit : 0;
    return { limit, offset };
}

function getPagingData(data: { count: number; rows: unknown[] }, page?: string, limit?: number) {
    const { count: totalItems, rows: contents } = data;
    const currentPage = page ? +page : 0;
    const totalPages = Math.ceil(totalItems / (limit || 10));
    return { totalItems, contents, totalPages, currentPage };
}

export const savePatient = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    req.body.tenantId = req.user!.tenants[0].id;
    req.body.userId = req.user!.id;

    const patient = await Patient.schema(schema).create(req.body);
    await recordConsentChanges({ req, schema, patientId: patient.get('id') as string, after: patient, payload: req.body });
    await recordPatientAudit(req, schema, 'patient.created', patient.get('id') as string);
    return sendSuccessResponse(res, 201, patient, 'Paziente creato correttamente');
});

export const findAndCountAll = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { page, size } = req.query as { page?: string; size?: string };
    const { limit, offset } = getPagination(page, size);

    const data = await Patient.schema(schema).findAndCountAll({
        where: scopeWhere(req, PATIENT_SCOPE_FIELDS),
        limit,
        offset,
        order: [[fn('lower', col('name')), 'ASC']]
    });

    return sendSuccessResponse(res, 200, getPagingData(data, page, limit), 'Pazienti caricati correttamente');
});

export const findAll = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const patients = await Patient.schema(schema).findAll({
        where: scopeWhere(req, PATIENT_SCOPE_FIELDS)
    });
    return sendSuccessResponse(res, 200, patients, 'Pazienti caricati correttamente');
});

export const findOne = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    // Lo scope entra nella query: un paziente fuori portata risulta inesistente,
    // così non si rivela nemmeno la sua esistenza.
    const patient = await Patient.schema(schema).findOne({
        where: { id: req.params.patientId, ...scopeWhere(req, PATIENT_SCOPE_FIELDS) }
    });
    if (!patient) {
        return sendErrorResponse(res, 404, 'Paziente non trovato');
    }
    await recordPatientAudit(req, schema, 'patient.read', patient.get('id') as string);
    return sendSuccessResponse(res, 200, patient, 'Paziente caricato correttamente');
});

export const searchPatients = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const query = ((req.query.query as string) || '').toLowerCase();
    const words = query.split(' ').filter(Boolean);

    const patients = await Patient.schema(schema).findAll({
        where: {
            [Op.and]: [
                scopeWhere(req, PATIENT_SCOPE_FIELDS),
                {
                    [Op.or]: [
                        sequelizeWhere(fn('LOWER', col('name')), 'LIKE', `%${query}%`),
                        sequelizeWhere(fn('LOWER', col('surname')), 'LIKE', `%${query}%`),
                        {
                            [Op.and]: words.map((word) => ({
                                [Op.or]: [
                                    sequelizeWhere(fn('LOWER', col('name')), 'LIKE', `%${word}%`),
                                    sequelizeWhere(fn('LOWER', col('surname')), 'LIKE', `%${word}%`)
                                ]
                            }))
                        }
                    ]
                }
            ]
        },
        order: [[fn('lower', col('name')), 'ASC']]
    });

    return sendSuccessResponse(res, 200, patients, 'Ricerca completata');
});

export const update = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.patientId;
    const payload = req.body.contact ?? req.body;

    const patient = await Patient.schema(schema).findOne({
        where: { id, ...scopeWhere(req, PATIENT_SCOPE_FIELDS) }
    });
    if (!patient) {
        return sendErrorResponse(res, 404, 'Paziente non trovato');
    }

    const before = patient.get({ plain: true }) as unknown as Record<string, unknown>;
    await patient.update(payload);
    const updatedPatient = await Patient.schema(schema).findByPk(id);
    if (updatedPatient) {
        await recordConsentChanges({ req, schema, patientId: id, before, after: updatedPatient, payload });
        await recordPatientAudit(req, schema, 'patient.updated', id, { fields: Object.keys(payload) });
    }
    return sendSuccessResponse(res, 200, updatedPatient, 'Paziente aggiornato correttamente');
});

export const getConsentHistory = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.patientId;

    const patient = await Patient.schema(schema).findOne({
        where: { id, ...scopeWhere(req, PATIENT_SCOPE_FIELDS) }
    });
    if (!patient) {
        return sendErrorResponse(res, 404, 'Paziente non trovato');
    }

    const events = await ConsentEvent.schema(schema).findAll({
        where: { patientId: id },
        order: [['occurredAt', 'DESC']]
    });
    await recordPatientAudit(req, schema, 'patient.consent_history_read', id);

    return sendSuccessResponse(res, 200, events, 'Storico consensi caricato');
});

export const deletePatient = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.patientId;
    const scope = scopeWhere(req, PATIENT_SCOPE_FIELDS);

    const removedPatient = await Patient.schema(schema).findOne({ where: { id, ...scope } });
    if (!removedPatient) {
        return sendErrorResponse(res, 404, 'Paziente non trovato');
    }

    const [invoiceCount, evaluationCount, observationCount] = await Promise.all([
        Invoice.schema(schema).count({ where: { patientID: id } }),
        Evaluation.schema(schema).count({ where: { patientId: id } }),
        Observation.schema(schema).count({ where: { patientId: id } })
    ]);
    const protectedRecords = invoiceCount + evaluationCount + observationCount;

    if (protectedRecords > 0) {
        await removedPatient.update({ deactivatedAt: new Date() });
        await recordPatientAudit(req, schema, 'patient.deactivated_for_retention', id, {
            invoiceCount,
            evaluationCount,
            observationCount
        });
        return sendSuccessResponse(
            res,
            200,
            { patient: removedPatient, retained: true },
            'Paziente disattivato: esistono documenti clinici/fiscali da conservare'
        );
    }

    await Patient.schema(schema).destroy({ where: { id, ...scope } });
    await recordPatientAudit(req, schema, 'patient.deleted', id);

    return sendSuccessResponse(res, 200, removedPatient, 'Paziente eliminato correttamente');
});

export default {
    savePatient,
    findAndCountAll,
    findAll,
    findOne,
    searchPatients,
    update,
    getConsentHistory,
    deletePatient
};

