import { Request, Response } from 'express';
import { Op } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { scopeWhere } from '../../../middleware/rbac.js';
import Patient from '../../patients/models/patient.model.js';
import Note, { NoteType } from '../models/note.model.js';

const NOTE_SCOPE_FIELDS = {
    ownerField: 'ownerUserId',
    structureField: 'structureId',
    includeUnassigned: true
};

const PATIENT_SCOPE_FIELDS = {
    ownerField: 'userId',
    structureField: 'structureId',
    includeUnassigned: true
};

const NOTE_TYPES: NoteType[] = ['CLINICAL', 'ADMIN', 'INTERNAL'];

function parseBool(value: unknown): boolean | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return undefined;
}

function resolveWritableStructureId(req: Request, requested?: string | null): string | null {
    if (req.access?.scope === 'tenant') {
        return requested ?? req.access.structureId ?? null;
    }
    return req.access?.structureId ?? requested ?? null;
}

async function assertPatientVisible(req: Request, res: Response, patientId?: string | null): Promise<boolean> {
    if (!patientId) return true;

    const patient = await Patient.schema(req.tenantSchema!).findOne({
        where: {
            id: patientId,
            ...scopeWhere(req, PATIENT_SCOPE_FIELDS)
        }
    });

    if (patient) return true;
    sendErrorResponse(res, 404, 'Paziente non trovato');
    return false;
}

export const createNote = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const body = req.body?.note ?? req.body ?? {};

    const title = `${body.title ?? ''}`.trim();
    if (!title) {
        return sendErrorResponse(res, 400, 'title is required');
    }

    const type = NOTE_TYPES.includes(body.type) ? body.type : 'CLINICAL';
    const patientId = body.patientId ?? null;

    if (!(await assertPatientVisible(req, res, patientId))) {
        return;
    }

    const ownerUserId = req.access?.scope === 'own'
        ? req.access.userId
        : body.ownerUserId ?? req.access?.userId ?? req.user!.id;

    const note = await Note.schema(schema).create({
        type,
        title,
        contentHtml: body.contentHtml ?? null,
        contentText: body.contentText ?? null,
        contentDelta: body.contentDelta ?? null,
        patientId,
        agendaEventId: body.agendaEventId ?? null,
        evaluationId: body.evaluationId ?? null,
        ownerUserId,
        structureId: resolveWritableStructureId(req, body.structureId),
        createdByUserId: req.user!.id,
        pinned: !!body.pinned,
        archived: !!body.archived
    });

    return sendSuccessResponse(res, 201, note, 'Nota creata correttamente');
});

export const getNotes = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { q, patientId, agendaEventId, evaluationId, type } = req.query as Record<string, string | undefined>;
    const archived = parseBool(req.query.archived);

    const where: Record<string, unknown> = {
        ...scopeWhere(req, NOTE_SCOPE_FIELDS),
        ...(patientId ? { patientId } : {}),
        ...(agendaEventId ? { agendaEventId } : {}),
        ...(evaluationId ? { evaluationId } : {}),
        ...(type && NOTE_TYPES.includes(type as NoteType) ? { type } : {}),
        ...(archived !== undefined ? { archived } : { archived: false })
    };

    if (q?.trim()) {
        where[Op.or as any] = [
            { title: { [Op.iLike]: `%${q.trim()}%` } },
            { contentText: { [Op.iLike]: `%${q.trim()}%` } }
        ];
    }

    const notes = await Note.schema(schema).findAll({
        where,
        order: [
            ['pinned', 'DESC'],
            ['updatedAt', 'DESC']
        ],
        limit: 500
    });

    return sendSuccessResponse(res, 200, notes, 'Note caricate correttamente');
});

export const getNoteById = asyncHandler(async (req: Request, res: Response) => {
    const note = await Note.schema(req.tenantSchema!).findOne({
        where: { id: req.params.noteId, ...scopeWhere(req, NOTE_SCOPE_FIELDS) }
    });

    if (!note) {
        return sendErrorResponse(res, 404, 'Nota non trovata');
    }

    return sendSuccessResponse(res, 200, note, 'Nota caricata correttamente');
});

export const updateNote = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const body = req.body?.note ?? req.body ?? {};

    if (body.patientId && !(await assertPatientVisible(req, res, body.patientId))) {
        return;
    }

    const update: Record<string, unknown> = {
        ...body,
        updatedByUserId: req.user!.id
    };

    if (update.type && !NOTE_TYPES.includes(update.type as NoteType)) {
        delete update.type;
    }
    if (req.access?.scope === 'own') {
        delete update.ownerUserId;
        delete update.structureId;
    } else if (req.access?.scope === 'structure') {
        update.structureId = req.access.structureId;
    }
    delete update.id;
    delete update.createdByUserId;

    const [rowsUpdated] = await Note.schema(schema).update(update, {
        where: { id: req.params.noteId, ...scopeWhere(req, NOTE_SCOPE_FIELDS) }
    });

    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Nota non trovata');
    }

    const updated = await Note.schema(schema).findOne({
        where: { id: req.params.noteId, ...scopeWhere(req, NOTE_SCOPE_FIELDS) }
    });
    return sendSuccessResponse(res, 200, updated, 'Nota aggiornata correttamente');
});

export const deleteNote = asyncHandler(async (req: Request, res: Response) => {
    const removed = await Note.schema(req.tenantSchema!).destroy({
        where: { id: req.params.noteId, ...scopeWhere(req, NOTE_SCOPE_FIELDS) }
    });

    if (removed === 0) {
        return sendErrorResponse(res, 404, 'Nota non trovata');
    }

    return sendSuccessResponse(res, 200, { removed }, 'Nota eliminata correttamente');
});

export default {
    createNote,
    getNotes,
    getNoteById,
    updateNote,
    deleteNote
};
