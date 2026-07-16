import { Request, Response } from 'express';
import multer from 'multer';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { env } from '../../../config/env.js';
import { getRawFileById, readRawFileBuffer, saveRawFile } from '../services/rawFile.service.js';

/**
 * Middleware multer (F0.1): buffer in memoria (il file viene poi passato allo `StorageAdapter`),
 * limite dimensione configurabile via `MAX_UPLOAD_SIZE_MB` (default 20MB). In caso di superamento,
 * multer produce un `MulterError` gestito dal middleware globale (`errorHandler.ts`) → risposta 413.
 */
export const uploadMiddleware = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: env.maxUploadSizeMb * 1024 * 1024 }
}).single('file');

/** POST /raw-files (multipart/form-data, campo "file"): salva il file grezzo e ne ritorna i metadata. */
export const upload = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const tenantId = req.user!.tenants[0].id;
    const operatorId = req.user!.id;

    if (!req.file) {
        return sendErrorResponse(res, 400, 'Il campo "file" (multipart/form-data) è obbligatorio');
    }

    const rawFile = await saveRawFile(schema, {
        tenantId,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        buffer: req.file.buffer,
        uploadedBy: operatorId
    });

    return sendSuccessResponse(
        res,
        201,
        {
            id: rawFile.id,
            originalName: rawFile.originalName,
            mimeType: rawFile.mimeType,
            sizeBytes: rawFile.sizeBytes,
            checksumSha256: rawFile.checksumSha256
        },
        'File caricato'
    );
});

/** GET /raw-files/:id/download — stream del file grezzo originale (tenant-scoped). */
export const download = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { id } = req.params;

    const rawFile = await getRawFileById(schema, id);
    if (!rawFile) {
        return sendErrorResponse(res, 404, 'File non trovato');
    }

    const buffer = await readRawFileBuffer(rawFile);
    res.setHeader('Content-Type', rawFile.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${rawFile.originalName}"`);
    return res.status(200).send(buffer);
});

export default { uploadMiddleware, upload, download };

