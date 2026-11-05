import {visibleClinicalRows,assertClinicalRowRead} from '../../evaluations/services/clinicalReadGuard.js';
import { assertClinicalWriteContext, clinicalInputError } from '../../evaluations/services/clinicalWriteGuard.js';
import { updateClinicalRecord, deleteClinicalRecord } from '../../evaluations/services/clinicalRecordMutations.js';
import { Request, Response } from 'express';
import { sequelize } from '../../../config/database.js';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { patientResourceScopeWhere } from '../../../middleware/rbac.js';
import { withScope } from '../../../utils/scopedWhere.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import HumanBodyArticularity from '../models/humanBodyArticularity.model.js';
import { resolveHumanBodyPointId } from './humanBodyPoint.helper.js';
import { assertEvaluationEditable } from '../../evaluations/services/evaluationGuard.js';

export const saveArticularity = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    if(!Array.isArray(req.body.articularities)||!req.body.articularities.length)throw clinicalInputError('Inserisci almeno una rilevazione articolare');
    const created = await sequelize.transaction(async transaction => {
        await assertEvaluationEditable(schema, req.body?.evaluationId, req.access?.scope === 'own' ? req.access.userId : undefined, transaction);
        const humanBodyPointId = await resolveHumanBodyPointId(schema, req.body, req.access!.userId, transaction);
        if (!humanBodyPointId) return null;
        await assertClinicalWriteContext(req, {...req.body, humanBodyPointId}, transaction);
        const articularities = (req.body.articularities ?? []).map((art: Record<string, unknown>) => ({
            ...art,
            patientId: req.body.patientId,
            evaluationId: req.body.evaluationId ?? null,
            humanBodyPointId,
            userId: req.access!.userId
        }));
        return HumanBodyArticularity.schema(schema).bulkCreate(articularities, { transaction });
    });
    if (!created) {
        return sendErrorResponse(res, 400, 'humanBodyPointId or pointToCreate is required');
    }
    return sendSuccessResponse(res, 201, created, 'Human body articularity created');
});

export const getAllArticularityByPoint = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const articularity = await HumanBodyArticularity.schema(schema).findAll({
        where: { humanBodyPointId: req.query.humanBodyPointId as string, ...patientResourceScopeWhere(req, schema) }
    });
    return sendSuccessResponse(res, 200, { articularity:await visibleClinicalRows(req,articularity) }, 'Human body articularity loaded');
});

/** Was previously an empty stub. Completed here. */
export const getArticularityById = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const articularity = await HumanBodyArticularity.schema(schema).findOne({ where: { id: req.params.articularityId, ...patientResourceScopeWhere(req, schema) } });
    if (!articularity) {
        return sendErrorResponse(res, 404, 'Human body articularity not found');
    }
    await assertClinicalRowRead(req,articularity);
    return sendSuccessResponse(res, 200, articularity, 'Human body articularity loaded');
});

/** Was previously an empty stub. Completed here as a real partial update. */
export const updateArticularity = asyncHandler(async (req: Request, res: Response) => {
    const input=req.body.articularity && typeof req.body.articularity==='object' ? req.body.articularity:req.body;
    const updated=await updateClinicalRecord(req,HumanBodyArticularity,req.params.articularityId,input,["articularity","movement","bodyPart","bodySubPart","passiveValue","activeValue","passivePain","activePain","passiveValuePain","activeValuePain","valueStrength","strengthPain","valueStrengthPain","date"]);
    if(!updated) return sendErrorResponse(res,404,'Clinical record not found');
    return sendSuccessResponse(res,200,updated,'Clinical record updated');
});

/** Was previously an empty stub. Completed here as a real delete. */
export const deleteArticularity = asyncHandler(async (req: Request, res: Response) => {
    const removed=await deleteClinicalRecord(req,HumanBodyArticularity,req.params.articularityId);
    if(!removed) return sendErrorResponse(res,404,'Clinical record not found');
    return sendSuccessResponse(res,200,null,'Clinical record deleted');
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

    const articularity = await HumanBodyArticularity.schema(schema).findAll({
        where: withScope(patientResourceScopeWhere(req, schema), where)
    });
    return sendSuccessResponse(res, 200, Array.isArray(articularity)?await visibleClinicalRows(req,articularity):(articularity), 'Human body articularity loaded');
});

export default {
    saveArticularity,
    getAllArticularityByPoint,
    getArticularityById,
    updateArticularity,
    deleteArticularity,
    getArticularityByBodyPart
};


