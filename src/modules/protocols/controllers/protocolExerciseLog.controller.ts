import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendSuccessResponse } from '../../../utils/response.js';
import { ProtocolExerciseLog } from '../models/index.js';
import { ProtocolTemplateExercise, Exercise } from '../models/catalog/index.js';

/** Logs the patient's daily execution of a prescribed exercise (adherence tracking). */
export const logExerciseExecution = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const log = await ProtocolExerciseLog.schema(schema).create(req.body);
    return sendSuccessResponse(res, 201, log, 'Esecuzione registrata');
});

export const findExerciseLogs = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { protocolPhaseInstanceId } = req.query;

    const logs = await ProtocolExerciseLog.schema(schema).findAll({
        where: protocolPhaseInstanceId ? { protocolPhaseInstanceId: protocolPhaseInstanceId as string } : undefined,
        include: [{ model: ProtocolTemplateExercise, include: [Exercise], required: false }],
        order: [['date', 'DESC']]
    });

    return sendSuccessResponse(res, 200, logs, 'Log di esecuzione caricati correttamente');
});

export default {
    logExerciseExecution,
    findExerciseLogs
};

