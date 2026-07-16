import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import HumanBodyArticularity from '../models/humanBodyArticularity.model.js';
import { resolveHumanBodyPointId } from './humanBodyPoint.helper.js';
import { assertEvaluationEditable } from '../../evaluations/services/evaluationGuard.js';

export const saveArticularity = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    await assertEvaluationEditable(schema, req.body?.evaluationId);
    const humanBodyPointId = await resolveHumanBodyPointId(schema, req.body);

    if (!humanBodyPointId) {
        return sendErrorResponse(res, 400, 'humanBodyPointId or pointToCreate is required');
    }

    const articularities = (req.body.articularities ?? []).map((art: Record<string, unknown>) => ({
        evaluationId: req.body.evaluationId ?? null,
        ...art,
        humanBodyPointId
    }));

    const created = await HumanBodyArticularity.schema(schema).bulkCreate(articularities);
    return sendSuccessResponse(res, 201, created, 'Human body articularity created');
});

export const getAllArticularityByPoint = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const articularity = await HumanBodyArticularity.schema(schema).findAll({
        where: { humanBodyPointId: req.query.humanBodyPointId as string }
    });
    return sendSuccessResponse(res, 200, { articularity }, 'Human body articularity loaded');
});

/** Was previously an empty stub. Completed here. */
export const getArticularityById = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const articularity = await HumanBodyArticularity.schema(schema).findByPk(req.params.articularityId);
    if (!articularity) {
        return sendErrorResponse(res, 404, 'Human body articularity not found');
    }
    return sendSuccessResponse(res, 200, articularity, 'Human body articularity loaded');
});

/** Was previously an empty stub. Completed here as a real partial update. */
export const updateArticularity = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.articularityId;

    const [rowsUpdated] = await HumanBodyArticularity.schema(schema).update(req.body.articularity ?? req.body, {
        where: { id }
    });
    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Human body articularity not found');
    }

    const updated = await HumanBodyArticularity.schema(schema).findByPk(id);
    return sendSuccessResponse(res, 200, updated, 'Human body articularity updated');
});

/** Was previously an empty stub. Completed here as a real delete. */
export const deleteArticularity = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const removed = await HumanBodyArticularity.schema(schema).destroy({ where: { id: req.params.articularityId } });
    if (removed === 0) {
        return sendErrorResponse(res, 404, 'Human body articularity not found');
    }
    return sendSuccessResponse(res, 200, null, 'Human body articularity deleted');
});

/** Was previously an empty stub. Completed here. */
export const getArticularityByBodyPart = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { bodyPart, bodySubPart, patientId, evaluationId } = req.query;

    const where: Record<string, unknown> = {};
    if (bodyPart) where.bodyPart = sequelizeWhere(fn('LOWER', col('bodyPart')), 'LIKE', `%${String(bodyPart).toLowerCase()}%`);
    if (bodySubPart) where.bodySubPart = sequelizeWhere(fn('LOWER', col('bodySubPart')), 'LIKE', `%${String(bodySubPart).toLowerCase()}%`);
    if (patientId) where.patientId = patientId;
    if (evaluationId) where.evaluationId = evaluationId;

    const articularity = await HumanBodyArticularity.schema(schema).findAll({ where: { [Op.and]: where } });
    return sendSuccessResponse(res, 200, articularity, 'Human body articularity loaded');
});

export default {
    saveArticularity,
    getAllArticularityByPoint,
    getArticularityById,
    updateArticularity,
    deleteArticularity,
    getArticularityByBodyPart
};


