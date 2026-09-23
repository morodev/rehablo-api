import { Request, Response } from 'express';
import multer from 'multer';
import { createHash } from 'node:crypto';
import { Op } from 'sequelize';
import { scopeWhere } from '../../../middleware/rbac.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { Evaluation } from '../../evaluations/models/index.js';
import { ProtocolInstance } from '../../protocols/models/index.js';
import { ProtocolTemplate } from '../../protocols/models/catalog/index.js';
import Patient from '../../patients/models/patient.model.js';
import { localStorageAdapter } from '../../measurements/storage/localStorageAdapter.js';
import PatientSharedDocument from '../models/patientSharedDocument.model.js';
import PatientPortalAudit from '../models/patientPortalAudit.model.js';

export const sharedDocumentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }).single('file');

function detectedMime(buffer: Buffer): string | null {
    if (buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) return 'application/pdf';
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    return null;
}

async function staffPatient(req: Request) {
    const where: Record<string, unknown> = { id: req.params.patientId };
    if (req.access?.scope !== 'tenant') {
        if (!req.access?.structureId) return null;
        where['structureId'] = req.access.structureId;
    }
    return Patient.schema(req.tenantSchema!).findOne({ where });
}

export const publishEvaluation = asyncHandler(async (req: Request, res: Response) => {
    if (typeof req.body?.published !== 'boolean') return sendErrorResponse(res, 422, 'Indica se condividere la valutazione');
    if (!await staffPatient(req)) return sendErrorResponse(res, 404, 'Paziente non disponibile');
    const row = await Evaluation.schema(req.tenantSchema!).findOne({ where: {
        id: req.params.id, patientId: req.params.patientId,
        ...scopeWhere(req, { ownerField: 'userId', structureField: 'structureId' })
    } });
    if (!row) return sendErrorResponse(res, 404, 'Valutazione non disponibile');
    if (req.body.published && row.get('status') !== 'COMPLETED') return sendErrorResponse(res, 409, 'Concludi prima la valutazione');
    await row.update({ publishedToPatient: req.body.published });
    return sendSuccessResponse(res, 200, { published: row.get('publishedToPatient') });
});

export const staffContent = asyncHandler(async (req: Request, res: Response) => {
    if (!await staffPatient(req)) return sendErrorResponse(res, 404, 'Paziente non disponibile');
    const [evaluations, protocols] = await Promise.all([
        Evaluation.schema(req.tenantSchema!).findAll({ where: {
            patientId: req.params.patientId, status: 'COMPLETED',
            ...scopeWhere(req, { ownerField: 'userId', structureField: 'structureId' })
        }, attributes: ['id', 'title', 'date', 'publishedToPatient'], order: [['date', 'DESC']] }),
        ProtocolInstance.schema(req.tenantSchema!).findAll({ where: {
            patientId: req.params.patientId, ...scopeWhere(req, { ownerField: 'userId' })
        }, attributes: ['id', 'startDate', 'publishedToPatient'],
        include: [{ model: ProtocolTemplate, attributes: ['name'], required: false }],
        order: [['startDate', 'DESC']] })
    ]);
    return sendSuccessResponse(res, 200, { evaluations, protocols });
});

export const publishProtocol = asyncHandler(async (req: Request, res: Response) => {
    if (typeof req.body?.published !== 'boolean') return sendErrorResponse(res, 422, 'Indica se condividere il protocollo');
    if (!await staffPatient(req)) return sendErrorResponse(res, 404, 'Paziente non disponibile');
    const row = await ProtocolInstance.schema(req.tenantSchema!).findOne({ where: {
        id: req.params.id, patientId: req.params.patientId,
        ...scopeWhere(req, { ownerField: 'userId' })
    } });
    if (!row) return sendErrorResponse(res, 404, 'Protocollo non disponibile');
    await row.update({ publishedToPatient: req.body.published });
    return sendSuccessResponse(res, 200, { published: row.get('publishedToPatient') });
});

export const staffDocuments = asyncHandler(async (req: Request, res: Response) => {
    if (!await staffPatient(req)) return sendErrorResponse(res, 404, 'Paziente non disponibile');
    const rows = await PatientSharedDocument.schema(req.tenantSchema!).findAll({
        where: { patientId: req.params.patientId }, order: [['createdAt', 'DESC']]
    });
    return sendSuccessResponse(res, 200, rows.map(row => ({ id: row.get('id'), title: row.get('title'),
        fileName: row.get('fileName'), mimeType: row.get('mimeType'), publishedAt: row.get('publishedAt'),
        unpublishedAt: row.get('unpublishedAt') })));
});

export const uploadDocument = asyncHandler(async (req: Request, res: Response) => {
    if (!await staffPatient(req)) return sendErrorResponse(res, 404, 'Paziente non disponibile');
    const file = req.file;
    const title = String(req.body?.title ?? '').trim();
    const mimeType = file ? detectedMime(file.buffer) : null;
    if (!file || !mimeType || !title || title.length > 200 || file.mimetype !== mimeType) {
        return sendErrorResponse(res, 422, 'Carica un PDF o un’immagine valida con titolo');
    }
    const ext = mimeType === 'application/pdf' ? '.pdf' : mimeType === 'image/png' ? '.png' : '.jpg';
    const saved = await localStorageAdapter.save(String(req.user!.tid), file.buffer, `document${ext}`);
    try {
        const row = await PatientSharedDocument.schema(req.tenantSchema!).create({
            patientId: req.params.patientId, title, fileName: file.originalname.slice(0, 255), mimeType,
            sizeBytes: saved.sizeBytes, storagePath: saved.storagePath, checksumSha256: saved.checksumSha256,
            publishedAt: new Date(), publishedByUserId: req.access!.userId
        });
        return sendSuccessResponse(res, 201, { id: row.get('id'), title, fileName: row.get('fileName') }, 'Documento condiviso');
    } catch (error) {
        await localStorageAdapter.remove(saved.storagePath);
        throw error;
    }
});

export const updateDocument = asyncHandler(async (req: Request, res: Response) => {
    if (typeof req.body?.published !== 'boolean') return sendErrorResponse(res, 422, 'Indica se condividere il documento');
    if (!await staffPatient(req)) return sendErrorResponse(res, 404, 'Paziente non disponibile');
    const row = await PatientSharedDocument.schema(req.tenantSchema!).findOne({ where: {
        id: req.params.id, patientId: req.params.patientId
    } });
    if (!row) return sendErrorResponse(res, 404, 'Documento non disponibile');
    await row.update({ unpublishedAt: req.body.published ? null : new Date(),
        ...(req.body.published ? { publishedAt: new Date(), publishedByUserId: req.access!.userId } : {}) });
    return sendSuccessResponse(res, 200, { id: row.get('id'), published: req.body.published });
});

export const patientDocuments = asyncHandler(async (req: Request, res: Response) => {
    const limit = 50;
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { rows, count } = await PatientSharedDocument.schema(req.tenantSchema!).findAndCountAll({ where: {
        patientId: String(req.user!.pid), unpublishedAt: null, publishedAt: { [Op.lte]: new Date() }
    }, order: [['publishedAt', 'DESC']], limit, offset });
    await PatientPortalAudit.schema(req.tenantSchema!).create({
        accessId: String(req.user!.patientAccessId), userId: String(req.user!.sub ?? req.user!.id),
        patientId: String(req.user!.pid), action: 'READ', resource: 'shared_documents', outcome: 'SUCCESS'
    });
    return sendSuccessResponse(res, 200, { items: rows.map(row => ({ id: row.get('id'), title: row.get('title'),
        fileName: row.get('fileName'), mimeType: row.get('mimeType'), publishedAt: row.get('publishedAt') })),
        total: count, limit, offset });
});

export const downloadDocument = asyncHandler(async (req: Request, res: Response) => {
    const row = await PatientSharedDocument.schema(req.tenantSchema!).findOne({ where: {
        id: req.params.id, patientId: String(req.user!.pid), unpublishedAt: null,
        publishedAt: { [Op.lte]: new Date() }
    } });
    if (!row) return sendErrorResponse(res, 404, 'Documento non disponibile');
    let content: Buffer;
    try {
        content = await localStorageAdapter.read(String(row.get('storagePath')));
    } catch (error: any) {
        if (error?.code === 'ENOENT') return sendErrorResponse(res, 404, 'File non disponibile: contatta il centro');
        throw error;
    }
    if (createHash('sha256').update(content).digest('hex') !== row.get('checksumSha256')) {
        return sendErrorResponse(res, 409, 'Il file non supera la verifica di integrità');
    }
    await PatientPortalAudit.schema(req.tenantSchema!).create({
        accessId: String(req.user!.patientAccessId), userId: String(req.user!.sub ?? req.user!.id),
        patientId: String(req.user!.pid), action: 'READ', resource: 'shared_document',
        resourceId: String(row.get('id')), outcome: 'SUCCESS'
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', String(row.get('mimeType')));
    res.setHeader('Content-Disposition', `attachment; filename="documento-${row.get('id')}.${row.get('mimeType') === 'application/pdf' ? 'pdf' : row.get('mimeType') === 'image/png' ? 'png' : 'jpg'}"`);
    return res.send(content);
});
