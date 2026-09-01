import { Request, Response } from 'express';
import { Op, fn, col, cast, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { scopeWhere } from '../../../middleware/rbac.js';
import { PatientPortalAccess, Structure, StructureUser } from '../../auth/models/index.js';
import Patient from '../models/patient.model.js';

/**
 * Campi usati per il filtro row-level RBAC.
 * `userId` resta esclusivamente l'autore dell'anagrafica; la visibilità è determinata
 * dalla sede. I record legacy senza sede non vengono esposti agli operatori.
 */
const PATIENT_SCOPE_FIELDS = {
    ownerField: 'userId',
    structureField: 'structureId',
    includeUnassigned: false
};

const MUTABLE_PATIENT_FIELDS = [
    'name',
    'surname',
    'placeBirth',
    'birthday',
    'fiscalCode',
    'gender',
    'work',
    'hobby',
    'sport',
    'title',
    'address',
    'emails',
    'tags',
    'phoneNumbers',
    'background',
    'notes',
    'privacyConsent',
    'privacyConsentDate',
    'privacyPolicyVersion',
    'stsOppositionToDataSending',
    'fseConsentFeeding',
    'fseConsentViewing',
    'fseConsentDate'
] as const;

function normalizeFiscalCode(value: unknown): string | null {
    if (typeof value !== 'string') return value == null ? null : `${value}`.trim().toUpperCase() || null;
    return value.trim().toUpperCase() || null;
}

function sanitizePatientPayload(raw: Record<string, unknown> | null | undefined): Record<string, unknown> {
    const source = raw ?? {};
    const payload: Record<string, unknown> = {};

    for (const field of MUTABLE_PATIENT_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(source, field)) {
            payload[field] = source[field];
        }
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'fiscalCode')) {
        payload.fiscalCode = normalizeFiscalCode(payload.fiscalCode);
    }
    return payload;
}

function activePatientWhere(req: Request): Record<string | symbol, unknown> {
    return {
        [Op.and]: [scopeWhere(req, PATIENT_SCOPE_FIELDS), { archivedAt: null }]
    };
}

async function resolveWritableStructureId(req: Request): Promise<string | null> {
    const structureId = req.access?.structureId ?? null;
    const tenantId = req.user!.tenants[0].id;
    const userId = req.access?.userId ?? req.user!.id;

    if (!structureId) return null;

    const [structure, assignment] = await Promise.all([
        Structure.findOne({ where: { id: structureId, tenantId } }),
        StructureUser.findOne({ where: { structureId, userId } })
    ]);

    return structure && assignment ? structureId : null;
}

async function fiscalCodeExists(schema: string, fiscalCode: string | null, excludeId?: string): Promise<boolean> {
    if (!fiscalCode) return false;
    const patient = await Patient.schema(schema).findOne({
        where: {
            fiscalCode: { [Op.iLike]: fiscalCode },
            ...(excludeId ? { id: { [Op.ne]: excludeId } } : {})
        },
        attributes: ['id']
    });
    return !!patient;
}

function getPagination(page?: string, size?: string) {
    const parsedPage = Number.isFinite(Number(page)) ? Math.max(Number(page), 0) : 0;
    const parsedSize = Number.isFinite(Number(size)) ? Number(size) : 25;
    const limit = Math.min(Math.max(parsedSize, 1), 100);
    const offset = parsedPage * limit;
    return { limit, offset };
}

function getPagingData(data: { count: number; rows: unknown[] }, page?: string, limit?: number) {
    const { count: totalItems, rows: contents } = data;
    const currentPage = Number.isFinite(Number(page)) ? Math.max(Number(page), 0) : 0;
    const totalPages = Math.ceil(totalItems / (limit || 10));
    return { totalItems, contents, totalPages, currentPage };
}

export const savePatient = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const structureId = await resolveWritableStructureId(req);
    if (!structureId) {
        return sendErrorResponse(res, 400, 'Seleziona una sede valida prima di creare il paziente');
    }

    const payload = sanitizePatientPayload(req.body);
    if (!payload.name || typeof payload.name !== 'string' || !payload.name.trim()) {
        return sendErrorResponse(res, 400, 'Il nome del paziente Ã¨ obbligatorio');
    }
    payload.name = payload.name.trim();
    if (typeof payload.surname === 'string') payload.surname = payload.surname.trim();
    if (payload.privacyConsent === true && !payload.privacyConsentDate) {
        payload.privacyConsentDate = new Date();
    }
    if ((typeof payload.fseConsentFeeding === 'boolean' || typeof payload.fseConsentViewing === 'boolean')
        && !payload.fseConsentDate) {
        payload.fseConsentDate = new Date();
    }
    const fiscalCode = normalizeFiscalCode(payload.fiscalCode);
    if (await fiscalCodeExists(schema, fiscalCode)) {
        return sendErrorResponse(res, 409, 'Esiste già un paziente con questo codice fiscale');
    }

    const patient = await Patient.schema(schema).create({
        ...payload,
        fiscalCode,
        tenantId: req.user!.tenants[0].id,
        userId: req.access!.userId,
        structureId
    });
    return sendSuccessResponse(res, 201, patient, 'Paziente creato correttamente');
});

export const findAndCountAll = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { page, size } = req.query as { page?: string; size?: string };
    const { limit, offset } = getPagination(page, size);

    const data = await Patient.schema(schema).findAndCountAll({
        where: activePatientWhere(req),
        limit,
        offset,
        order: [[fn('lower', col('name')), 'ASC']]
    });

    return sendSuccessResponse(res, 200, getPagingData(data, page, limit), 'Pazienti caricati correttamente');
});

export const findAll = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const patients = await Patient.schema(schema).findAll({
        where: activePatientWhere(req)
    });
    return sendSuccessResponse(res, 200, patients, 'Pazienti caricati correttamente');
});

export const findOne = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    // Lo scope entra nella query: un paziente fuori portata risulta inesistente,
    // così non si rivela nemmeno la sua esistenza.
    const patient = await Patient.schema(schema).findOne({
        where: { id: req.params.patientId, ...activePatientWhere(req) }
    });
    if (!patient) {
        return sendErrorResponse(res, 404, 'Paziente non trovato');
    }
    return sendSuccessResponse(res, 200, patient, 'Paziente caricato correttamente');
});

export const searchPatients = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const query = ((req.query.query as string) || '').trim().toLowerCase();
    const words = query.split(' ').filter(Boolean);

    const patients = await Patient.schema(schema).findAll({
        where: {
            [Op.and]: [
                activePatientWhere(req),
                {
                    [Op.or]: [
                        sequelizeWhere(fn('LOWER', col('name')), Op.like, `%${query}%`),
                        sequelizeWhere(fn('LOWER', col('surname')), Op.like, `%${query}%`),
                        sequelizeWhere(fn('LOWER', col('fiscalCode')), Op.like, `%${query}%`),
                        sequelizeWhere(fn('LOWER', cast(col('emails'), 'text')), Op.like, `%${query}%`),
                        sequelizeWhere(fn('LOWER', cast(col('phoneNumbers'), 'text')), Op.like, `%${query}%`),
                        {
                            [Op.and]: words.map((word) => ({
                                [Op.or]: [
                                    sequelizeWhere(fn('LOWER', col('name')), Op.like, `%${word}%`),
                                    sequelizeWhere(fn('LOWER', col('surname')), Op.like, `%${word}%`)
                                ]
                            }))
                        }
                    ]
                }
            ]
        },
        order: [[fn('lower', col('name')), 'ASC']],
        limit: 50
    });

    return sendSuccessResponse(res, 200, patients, 'Ricerca completata');
});

export const update = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.patientId;
    const currentPatient = await Patient.schema(schema).findOne({
        where: { id, ...activePatientWhere(req) }
    });
    if (!currentPatient) {
        return sendErrorResponse(res, 404, 'Paziente non trovato');
    }

    const payload = sanitizePatientPayload(req.body.contact ?? req.body);
    if (Object.keys(payload).length === 0) {
        return sendErrorResponse(res, 400, 'Nessun campo aggiornabile ricevuto');
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'name')) {
        if (typeof payload.name !== 'string' || !payload.name.trim()) {
            return sendErrorResponse(res, 400, 'Il nome del paziente Ã¨ obbligatorio');
        }
        payload.name = payload.name.trim();
    }
    if (typeof payload.surname === 'string') payload.surname = payload.surname.trim();

    if (payload.privacyConsent === true && currentPatient.privacyConsent !== true) {
        payload.privacyConsentDate = new Date();
    } else if (payload.privacyConsent === false && currentPatient.privacyConsent === true) {
        payload.privacyConsentDate = null;
    }

    const fseChanged = (typeof payload.fseConsentFeeding === 'boolean'
            && payload.fseConsentFeeding !== currentPatient.fseConsentFeeding)
        || (typeof payload.fseConsentViewing === 'boolean'
            && payload.fseConsentViewing !== currentPatient.fseConsentViewing);
    if (fseChanged) payload.fseConsentDate = new Date();
    const fiscalCode = Object.prototype.hasOwnProperty.call(payload, 'fiscalCode')
        ? normalizeFiscalCode(payload.fiscalCode)
        : null;

    if (fiscalCode && await fiscalCodeExists(schema, fiscalCode, id)) {
        return sendErrorResponse(res, 409, 'Esiste già un paziente con questo codice fiscale');
    }

    const [rowsUpdated] = await Patient.schema(schema).update(payload, {
        where: { id, ...activePatientWhere(req) }
    });
    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Paziente non trovato');
    }

    const updatedPatient = await Patient.schema(schema).findOne({ where: { id, ...activePatientWhere(req) } });
    return sendSuccessResponse(res, 200, updatedPatient, 'Paziente aggiornato correttamente');
});

export const deletePatient = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.patientId;
    const scope = activePatientWhere(req);

    const removedPatient = await Patient.schema(schema).findOne({ where: { id, ...scope } });
    if (!removedPatient) {
        return sendErrorResponse(res, 404, 'Paziente non trovato');
    }

    await Patient.schema(schema).update(
        { archivedAt: new Date() },
        { where: { id, ...scope } }
    );

    // L'archiviazione rimuove il paziente dalle liste operative ma conserva il suo accesso
    // storico in sola lettura. La revoca del portale resta un'azione esplicita e separata.
    await PatientPortalAccess.update(
        { status: 'HISTORICAL', historicalAt: new Date(), revokedAt: null, revokedByUserId: null },
        { where: { tenantId: req.user!.tid ?? req.user!.tenants[0].id, patientId: id, status: 'ACTIVE' } }
    );

    return sendSuccessResponse(res, 200, removedPatient, 'Paziente archiviato correttamente');
});

export default { savePatient, findAndCountAll, findAll, findOne, searchPatients, update, deletePatient };

