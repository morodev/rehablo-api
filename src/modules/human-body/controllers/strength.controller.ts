import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { patientScopeWhere } from '../../../middleware/rbac.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import HumanBodyStrength from '../models/humanBodyStrength.model.js';
import { resolveHumanBodyPointId } from './humanBodyPoint.helper.js';
import { assertEvaluationEditable } from '../../evaluations/services/evaluationGuard.js';

export const saveStrength = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    await assertEvaluationEditable(schema, req.body?.evaluationId);
    const humanBodyPointId = await resolveHumanBodyPointId(schema, req.body);

    if (!humanBodyPointId) {
        return sendErrorResponse(res, 400, 'humanBodyPointId or pointToCreate is required');
    }

    const strength = await HumanBodyStrength.schema(schema).create({ ...req.body, humanBodyPointId });
    return sendSuccessResponse(res, 201, strength, 'Human body strength created');
});

export const getAllStrengthByPoint = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const strength = await HumanBodyStrength.schema(schema).findAll({
        where: { humanBodyPointId: req.query.humanBodyPointId as string, ...patientScopeWhere(req, schema) }
    });
    return sendSuccessResponse(res, 200, strength, 'Human body strength loaded');
});

/** Was previously an empty stub. Completed here. */
export const getStrengthById = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const strength = await HumanBodyStrength.schema(schema).findOne({ where: { id: req.params.strengthId, ...patientScopeWhere(req, schema) } });
    if (!strength) {
        return sendErrorResponse(res, 404, 'Human body strength not found');
    }
    return sendSuccessResponse(res, 200, strength, 'Human body strength loaded');
});

/** Was previously an empty stub. Completed here as a real partial update. */
export const updateStrength = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.strengthId;

    const [rowsUpdated] = await HumanBodyStrength.schema(schema).update(req.body.strength ?? req.body, { where: { id, ...patientScopeWhere(req, schema) } });
    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Human body strength not found');
    }

    const updated = await HumanBodyStrength.schema(schema).findByPk(id);
    return sendSuccessResponse(res, 200, updated, 'Human body strength updated');
});

/** Was previously an empty stub. Completed here as a real delete. */
export const deleteStrength = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const removed = await HumanBodyStrength.schema(schema).destroy({ where: { id: req.params.strengthId, ...patientScopeWhere(req, schema) } });
    if (removed === 0) {
        return sendErrorResponse(res, 404, 'Human body strength not found');
    }
    return sendSuccessResponse(res, 200, null, 'Human body strength deleted');
});

/** Was previously an empty stub. Completed here. */
export const getStrengthByBodyPart = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { bodyPart, bodySubPart, patientId, evaluationId } = req.query;

    const where: Record<string, unknown> = { ...patientScopeWhere(req, schema) };
    if (bodyPart) where.bodyPart = sequelizeWhere(fn('LOWER', col('bodyPart')), 'LIKE', `%${String(bodyPart).toLowerCase()}%`);
    if (bodySubPart) where.bodySubPart = sequelizeWhere(fn('LOWER', col('bodySubPart')), 'LIKE', `%${String(bodySubPart).toLowerCase()}%`);
    if (patientId) where.patientId = patientId;
    if (evaluationId) where.evaluationId = evaluationId;

    const strength = await HumanBodyStrength.schema(schema).findAll({ where: { [Op.and]: where } });
    return sendSuccessResponse(res, 200, strength, 'Human body strength loaded');
});

export default {
    saveStrength,
    getAllStrengthByPoint,
    getStrengthById,
    updateStrength,
    deleteStrength,
    getStrengthByBodyPart
};


