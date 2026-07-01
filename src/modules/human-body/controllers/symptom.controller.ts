import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import HumanBodySymptom from '../models/humanBodySymptom.model.js';
import { resolveHumanBodyPointId } from './humanBodyPoint.helper.js';

export const saveSymptom = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const humanBodyPointId = await resolveHumanBodyPointId(schema, req.body);

    if (!humanBodyPointId) {
        return sendErrorResponse(res, 400, 'humanBodyPointId or pointToCreate is required');
    }

    const symptom = await HumanBodySymptom.schema(schema).create({ ...req.body, humanBodyPointId });
    return sendSuccessResponse(res, 201, symptom, 'Human body symptom created');
});

export const getAllSymptomByPoint = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const symptoms = await HumanBodySymptom.schema(schema).findAll({
        where: { humanBodyPointId: req.query.humanBodyPointId as string }
    });
    return sendSuccessResponse(res, 200, symptoms, 'Human body symptoms loaded');
});

export const getSymptomById = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const symptom = await HumanBodySymptom.schema(schema).findByPk(req.params.symptomId);
    if (!symptom) {
        return sendErrorResponse(res, 404, 'Human body symptom not found');
    }
    return sendSuccessResponse(res, 200, symptom, 'Human body symptom loaded');
});

/**
 * Was previously an empty stub (`if (...) {} else { unauthorized(res); }`) — never actually updated
 * anything. Completed here as a real partial update.
 */
export const updateSymptom = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.symptomId;

    const [rowsUpdated] = await HumanBodySymptom.schema(schema).update(req.body.symptom ?? req.body, { where: { id } });
    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Human body symptom not found');
    }

    const updated = await HumanBodySymptom.schema(schema).findByPk(id);
    return sendSuccessResponse(res, 200, updated, 'Human body symptom updated');
});

/** Was previously an empty stub. Completed here as a real delete. */
export const deleteSymptom = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const removed = await HumanBodySymptom.schema(schema).destroy({ where: { id: req.params.symptomId } });
    if (removed === 0) {
        return sendErrorResponse(res, 404, 'Human body symptom not found');
    }
    return sendSuccessResponse(res, 200, null, 'Human body symptom deleted');
});

/** Was previously an empty stub. Completed here as a real search by body part / sub part. */
export const getSymptomsByBodyPart = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { bodyPart, bodySubPart, patientId, evaluationId } = req.query;

    const where: Record<string, unknown> = {};
    if (bodyPart) where.bodyPart = sequelizeWhere(fn('LOWER', col('bodyPart')), 'LIKE', `%${String(bodyPart).toLowerCase()}%`);
    if (bodySubPart) where.bodySubPart = sequelizeWhere(fn('LOWER', col('bodySubPart')), 'LIKE', `%${String(bodySubPart).toLowerCase()}%`);
    if (patientId) where.patientId = patientId;
    if (evaluationId) where.evaluationId = evaluationId;

    const symptoms = await HumanBodySymptom.schema(schema).findAll({ where: { [Op.and]: where } });
    return sendSuccessResponse(res, 200, symptoms, 'Human body symptoms loaded');
});

export default {
    saveSymptom,
    getAllSymptomByPoint,
    getSymptomById,
    updateSymptom,
    deleteSymptom,
    getSymptomsByBodyPart
};


