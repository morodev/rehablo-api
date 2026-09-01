import { Request, Response } from 'express';
import multer from 'multer';
import { Op, fn, col, cast, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { scopeWhere } from '../../../middleware/rbac.js';
import { PatientPortalAccess, Structure, StructureUser } from '../../auth/models/index.js';
import { localStorageAdapter } from '../../measurements/storage/localStorageAdapter.js';
import Patient from '../models/patient.model.js';

const ALLOWED_PRIVACY_DOCUMENT_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

export const privacyDocumentUploadMiddleware = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
}).single('file');

function detectPrivacyDocumentMime(buffer: Buffer): string | null {
    if (buffer.length >= 5 && buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        return 'application/pdf';
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
    }
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'image/png';
    }
    return null;
}

function hasExpectedPrivacyDocumentExtension(fileName: string, mimeType: string): boolean {
    const normalized = fileName.trim().toLowerCase();
    if (mimeType === 'application/pdf') return normalized.endsWith('.pdf');
    if (mimeType === 'image/jpeg') return normalized.endsWith('.jpg') || normalized.endsWith('.jpeg');
    if (mimeType === 'image/png') return normalized.endsWith('.png');
    return false;
}

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
    if (payload.privacyConsent !== true) {
        return sendErrorResponse(res, 422, 'Il consenso privacy acquisito è obbligatorio per creare il paziente');
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

export const uploadPrivacyDocument = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const patient = await Patient.unscoped().schema(schema).findOne({
        where: { id: req.params.patientId, ...activePatientWhere(req) }
    });

    if (!patient) {
        return sendErrorResponse(res, 404, 'Paziente non trovato');
    }
    if (!patient.privacyConsent) {
        return sendErrorResponse(res, 409, 'Registra il consenso privacy prima di caricare il documento');
    }
    if (!req.file) {
        return sendErrorResponse(res, 400, 'Il campo "file" (multipart/form-data) è obbligatorio');
    }
    const detectedMimeType = detectPrivacyDocumentMime(req.file.buffer);
    if (
        !ALLOWED_PRIVACY_DOCUMENT_MIME_TYPES.has(req.file.mimetype)
        || !detectedMimeType
        || detectedMimeType !== req.file.mimetype
        || !hasExpectedPrivacyDocumentExtension(req.file.originalname, detectedMimeType)
    ) {
        return sendErrorResponse(res, 422, 'Il contenuto del file non corrisponde a un PDF, JPG o PNG valido.');
    }
    if (req.file.originalname.length > 255) {
        return sendErrorResponse(res, 422, 'Il nome del file è troppo lungo (massimo 255 caratteri).');
    }

    const tenantId = req.user!.tenants[0].id;
    const previousStoragePath = patient.privacyDocumentStoragePath;
    const saved = await localStorageAdapter.save(tenantId, req.file.buffer, req.file.originalname);

    try {
        await patient.update({
            privacyDocumentStoragePath: saved.storagePath,
            privacyDocumentOriginalName: req.file.originalname,
            privacyDocumentMimeType: detectedMimeType,
            privacyDocumentSizeBytes: saved.sizeBytes,
            privacyDocumentUploadedAt: new Date(),
            privacyDocumentUploadedBy: req.access!.userId
        });
    } catch (error) {
        await localStorageAdapter.remove(saved.storagePath).catch(() => undefined);
        throw error;
    }

    if (previousStoragePath && previousStoragePath !== saved.storagePath) {
        localStorageAdapter.remove(previousStoragePath).catch((error) => {
            console.error('[privacy-document] impossibile rimuovere il file sostituito', error);
        });
    }

    const updatedPatient = await Patient.schema(schema).findOne({
        where: { id: req.params.patientId, ...activePatientWhere(req) }
    });
    return sendSuccessResponse(res, 200, updatedPatient, 'Documento privacy caricato correttamente');
});

export const downloadPrivacyDocument = asyncHandler(async (req: Request, res: Response) => {
    const patient = await Patient.unscoped().schema(req.tenantSchema!).findOne({
        where: { id: req.params.patientId, ...activePatientWhere(req) }
    });

    if (!patient) {
        return sendErrorResponse(res, 404, 'Paziente non trovato');
    }
    if (!patient.privacyDocumentStoragePath) {
        return sendErrorResponse(res, 404, 'Documento privacy non presente');
    }

    const buffer = await localStorageAdapter.read(patient.privacyDocumentStoragePath);
    const originalName = patient.privacyDocumentOriginalName || 'consenso-privacy';
    const asciiName = originalName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');

    res.setHeader('Content-Type', patient.privacyDocumentMimeType || 'application/octet-stream');
    res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(originalName)}`
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(buffer);
});

export default {
    savePatient,
    findAndCountAll,
    findAll,
    findOne,
    searchPatients,
    update,
    deletePatient,
    privacyDocumentUploadMiddleware,
    uploadPrivacyDocument,
    downloadPrivacyDocument
};

