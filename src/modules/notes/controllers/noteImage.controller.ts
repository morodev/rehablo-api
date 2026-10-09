import { Request, Response } from 'express';
import multer from 'multer';
import {Op} from 'sequelize';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { localStorageAdapter } from '../../measurements/storage/localStorageAdapter.js';
import NoteImage from '../models/noteImage.model.js';
import Note from '../models/note.model.js';
import { NOTE_IMAGE_MAX_BYTES, validateNoteImageFile } from '../utils/noteImageFile.js';
import {visibleNoteWhere} from '../services/workItemAccess.service.js';

export const noteImageUploadMiddleware = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: NOTE_IMAGE_MAX_BYTES, files: 1 }
}).single('file');

export const uploadNoteImage = asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
        return sendErrorResponse(res, 400, 'Il campo "file" (multipart/form-data) è obbligatorio');
    }
    if (req.file.originalname.length > 255) {
        return sendErrorResponse(res, 422, 'Il nome del file è troppo lungo (massimo 255 caratteri).');
    }

    const mimeType = validateNoteImageFile(req.file);
    if (!mimeType) {
        return sendErrorResponse(res, 422, 'Immagine non valida. Usa un file PNG, JPG, WebP o GIF.');
    }

    const structureId = req.access?.structureId ?? null;
    if (!structureId) {
        return sendErrorResponse(res, 400, 'Seleziona una sede prima di caricare un\'immagine');
    }

    const tenantId = getCurrentTenantId(req);
    const saved = await localStorageAdapter.save(tenantId, req.file.buffer, req.file.originalname);

    let image: NoteImage;
    try {
        image = await NoteImage.schema(req.tenantSchema!).create({
            originalName: req.file.originalname,
            mimeType,
            sizeBytes: saved.sizeBytes,
            checksumSha256: saved.checksumSha256,
            storagePath: saved.storagePath,
            ownerUserId: req.access!.userId,
            structureId,
            createdByUserId: req.access!.userId,
            noteId: null
        });
    } catch (error) {
        await localStorageAdapter.remove(saved.storagePath).catch(() => undefined);
        throw error;
    }

    return sendSuccessResponse(res, 201, {
        id: image.id,
        originalName: image.originalName,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        contentPath: `/note-images/${image.id}/content`
    }, 'Immagine caricata correttamente');
});

export const getNoteImageContent = asyncHandler(async (req: Request, res: Response) => {
    const image = await NoteImage.schema(req.tenantSchema!).findOne({
        where: {
            id: req.params.imageId,
            structureId: req.access!.structureId!
        }
    });

    let allowed = !!image && !image.noteId && image.ownerUserId === req.access!.userId;
    if (image?.noteId) {
        const visibility = await visibleNoteWhere(req);
        allowed = !!await Note.schema(req.tenantSchema!).findOne({
            where: {[Op.and]: [{id: image.noteId, structureId: req.access!.structureId!}, visibility] as any[]},
            attributes: ['id']
        });
    }

    if (!image || !allowed) {
        return sendErrorResponse(res, 404, 'Immagine della nota non trovata');
    }

    const buffer = await localStorageAdapter.read(image.storagePath);
    const asciiName = image.originalName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');

    res.setHeader('Content-Type', image.mimeType);
    res.setHeader(
        'Content-Disposition',
        `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(image.originalName)}`
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(buffer);
});

export default {
    noteImageUploadMiddleware,
    uploadNoteImage,
    getNoteImageContent
};
