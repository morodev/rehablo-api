import {Request, Response} from 'express';
import {Op, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {asyncHandler} from '../../../utils/asyncHandler.js';
import {boundedInteger, textSearchWhere} from '../../../utils/search.js';
import {sendErrorResponse, sendSuccessResponse} from '../../../utils/response.js';
import Patient from '../../patients/models/patient.model.js';
import Note, {NoteType} from '../models/note.model.js';
import NoteImage from '../models/noteImage.model.js';
import {
    assignedNoteIds,
    assignableUsers,
    normalizeAssignedUserIds,
    noteAssignmentIds,
    replaceNoteAssignments,
    serializeNotes,
    validateAssignedUsers,
    visibleNoteWhere
} from '../services/workItemAccess.service.js';

const NOTE_TYPES: NoteType[] = ['CLINICAL', 'ADMIN', 'INTERNAL'];
const NOTE_IMAGE_PATTERN = /\/note-images\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/content\/?/ig;

function parseBool(value: unknown): boolean | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return undefined;
}

async function assertPatientVisible(req: Request, res: Response, patientId?: string | null): Promise<boolean> {
    if (!patientId) return true;
    const patient = await Patient.schema(req.tenantSchema!).findOne({
        where: {id: patientId, structureId: req.access?.structureId ?? null, archivedAt: null}
    });
    if (patient) return true;
    sendErrorResponse(res, 404, 'Paziente non trovato');
    return false;
}

function noteImageIds(contentHtml: unknown): string[] {
    const html = typeof contentHtml === 'string' ? contentHtml : '';
    return [...new Set([...html.matchAll(NOTE_IMAGE_PATTERN)].map(match => match[1]))];
}

async function bindNoteImages(
    req: Request, noteId: string, contentHtml: unknown, transaction: Transaction
): Promise<void> {
    const ids = noteImageIds(contentHtml);
    if (!ids.length) return;
    await NoteImage.schema(req.tenantSchema!).update({noteId}, {
        where: {
            id: {[Op.in]: ids},
            structureId: req.access!.structureId!,
            [Op.or]: [{noteId}, {noteId: null, ownerUserId: req.access!.userId}]
        },
        transaction
    });
}

async function findVisibleNote(req: Request, noteId: string): Promise<Note | null> {
    const visibility = await visibleNoteWhere(req);
    return Note.schema(req.tenantSchema!).findOne({where: {[Op.and]: [{id: noteId}, visibility] as any[]}});
}

async function sendNote(res: Response, req: Request, status: number, note: Note, message: string) {
    const [serialized] = await serializeNotes(req, [note]);
    return sendSuccessResponse(res, status, serialized, message);
}

export const getAssignableNoteUsers = asyncHandler(async (req: Request, res: Response) => {
    const type = NOTE_TYPES.includes(req.query.type as NoteType) ? req.query.type as NoteType : 'INTERNAL';
    return sendSuccessResponse(res, 200, await assignableUsers(req, type), 'Operatori caricati correttamente');
});

export const createNote = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const body = req.body?.note ?? req.body ?? {};
    const title = `${body.title ?? ''}`.trim();
    if (!title) return sendErrorResponse(res, 400, 'Inserisci un titolo per la nota');
    if (!req.access?.structureId) return sendErrorResponse(res, 400, 'Seleziona una sede prima di creare la nota');

    const type: NoteType = NOTE_TYPES.includes(body.type) ? body.type : 'CLINICAL';
    const assignedUserIds = normalizeAssignedUserIds(body.assignedUserIds, body.ownerUserId, req.access.userId);
    const [validUsers, eligibleCreators] = await Promise.all([
        validateAssignedUsers(req, assignedUserIds, type),
        assignableUsers(req, type)
    ]);
    if (!validUsers) return sendErrorResponse(res, 422, 'Seleziona almeno un operatore valido della sede');
    if (!eligibleCreators.some(user => user.id === req.access!.userId)) {
        return sendErrorResponse(res, 403, 'Il tuo ruolo non può creare questo tipo di nota');
    }
    if (!(await assertPatientVisible(req, res, body.patientId ?? null))) return;

    const note = await sequelize.transaction(async transaction => {
        const created = await Note.schema(schema).create({
            type,
            title,
            contentHtml: body.contentHtml ?? null,
            contentText: body.contentText ?? null,
            contentDelta: body.contentDelta ?? null,
            patientId: body.patientId ?? null,
            agendaEventId: body.agendaEventId ?? null,
            evaluationId: body.evaluationId ?? null,
            ownerUserId: assignedUserIds[0],
            structureId: req.access!.structureId,
            createdByUserId: req.access!.userId,
            pinned: !!body.pinned,
            archived: !!body.archived
        }, {transaction});
        await replaceNoteAssignments(schema, created.id, assignedUserIds, req.access!.userId, transaction);
        await bindNoteImages(req, created.id, body.contentHtml, transaction);
        return created;
    });
    return sendNote(res, req, 201, note, 'Nota creata correttamente');
});

export const getNotes = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const {q, patientId, agendaEventId, evaluationId, type, assignedToMe, createdByMe} = req.query as Record<string, string | undefined>;
    const archived = parseBool(req.query.archived);
    const visibility = await visibleNoteWhere(req);
    const base: Record<string, unknown> = {
        structureId: req.access!.structureId,
        ...(patientId ? {patientId} : {}),
        ...(agendaEventId ? {agendaEventId} : {}),
        ...(evaluationId ? {evaluationId} : {}),
        ...(type && NOTE_TYPES.includes(type as NoteType) ? {type} : {}),
        ...(archived !== undefined ? {archived} : {archived: false}),
        ...(createdByMe === 'true' ? {createdByUserId: req.access!.userId} : {})
    };
    if (assignedToMe === 'true') base.id = {[Op.in]: await assignedNoteIds(schema, req.access!.userId)};
    const search = textSearchWhere(['title', 'contentText'], q);
    const whereParts: any[] = [visibility, base];
    if (search) whereParts.push(search);
    const notes = await Note.schema(schema).findAll({
        where: {[Op.and]: whereParts},
        order: [['pinned', 'DESC'], ['updatedAt', 'DESC']],
        limit: boundedInteger(req.query.limit, 500, 1, 500)
    });
    return sendSuccessResponse(res, 200, await serializeNotes(req, notes), 'Note caricate correttamente');
});

export const getNoteById = asyncHandler(async (req: Request, res: Response) => {
    const note = await findVisibleNote(req, req.params.noteId);
    if (!note) return sendErrorResponse(res, 404, 'Nota non trovata');
    return sendNote(res, req, 200, note, 'Nota caricata correttamente');
});

export const updateNote = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const body = req.body?.note ?? req.body ?? {};
    const note = await findVisibleNote(req, req.params.noteId);
    if (!note) return sendErrorResponse(res, 404, 'Nota non trovata');

    const currentUserId = req.access!.userId;
    const isCreator = note.createdByUserId === currentUserId;
    const assignedIds = await noteAssignmentIds(schema, note.id);
    const isAssigned = assignedIds.includes(currentUserId);
    if (!isCreator && (!isAssigned || note.type === 'CLINICAL')) {
        return sendErrorResponse(res, 403, 'Solo il creatore può modificare questa nota');
    }
    if (!isCreator && ('assignedUserIds' in body || 'ownerUserId' in body)) {
        return sendErrorResponse(res, 403, 'Solo il creatore può cambiare gli operatori assegnati');
    }
    if (body.patientId && !(await assertPatientVisible(req, res, body.patientId))) return;

    const nextType: NoteType = isCreator && NOTE_TYPES.includes(body.type) ? body.type : note.type;
    const nextAssignedIds = isCreator && ('assignedUserIds' in body || body.ownerUserId)
        ? normalizeAssignedUserIds(body.assignedUserIds, body.ownerUserId, currentUserId)
        : assignedIds;
    if (isCreator) {
        const [validUsers, eligibleCreators] = await Promise.all([
            validateAssignedUsers(req, nextAssignedIds, nextType),
            assignableUsers(req, nextType)
        ]);
        if (!validUsers) return sendErrorResponse(res, 422, 'Seleziona almeno un operatore valido della sede');
        if (!eligibleCreators.some(user => user.id === currentUserId)) {
            return sendErrorResponse(res, 403, 'Il tuo ruolo non può usare questo tipo di nota');
        }
    }

    const creatorFields = ['type', 'title', 'contentHtml', 'contentText', 'contentDelta', 'patientId',
        'agendaEventId', 'evaluationId', 'pinned', 'archived'] as const;
    const collaboratorFields = ['title', 'contentHtml', 'contentText', 'contentDelta', 'pinned'] as const;
    const update: Record<string, unknown> = {updatedByUserId: currentUserId};
    for (const field of isCreator ? creatorFields : collaboratorFields) {
        if (field in body) update[field] = body[field];
    }
    if (typeof update.title === 'string') {
        update.title = update.title.trim();
        if (!update.title) return sendErrorResponse(res, 400, 'Inserisci un titolo per la nota');
    }
    update.type = nextType;
    update.structureId = req.access!.structureId;
    update.ownerUserId = nextAssignedIds[0];

    const updated = await sequelize.transaction(async transaction => {
        await note.update(update, {transaction});
        if (isCreator) await replaceNoteAssignments(schema, note.id, nextAssignedIds, currentUserId, transaction);
        if ('contentHtml' in body) await bindNoteImages(req, note.id, body.contentHtml, transaction);
        return note;
    });
    return sendNote(res, req, 200, updated, 'Nota aggiornata correttamente');
});

export const deleteNote = asyncHandler(async (req: Request, res: Response) => {
    const note = await findVisibleNote(req, req.params.noteId);
    if (!note) return sendErrorResponse(res, 404, 'Nota non trovata');
    if (note.createdByUserId !== req.access!.userId) {
        return sendErrorResponse(res, 403, 'Solo il creatore può eliminare la nota');
    }
    await note.destroy();
    return sendSuccessResponse(res, 200, {removed: 1}, 'Nota eliminata correttamente');
});

export default {createNote, getNotes, getNoteById, updateNote, deleteNote, getAssignableNoteUsers};
