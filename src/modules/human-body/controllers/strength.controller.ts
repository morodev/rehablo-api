import {visibleClinicalRows,assertClinicalRowRead} from '../../evaluations/services/clinicalReadGuard.js';
import { assertClinicalWriteContext } from '../../evaluations/services/clinicalWriteGuard.js';
import { updateClinicalRecord, deleteClinicalRecord } from '../../evaluations/services/clinicalRecordMutations.js';
import { Request, Response } from 'express';
import { sequelize } from '../../../config/database.js';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { patientResourceScopeWhere } from '../../../middleware/rbac.js';
import { withScope } from '../../../utils/scopedWhere.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import HumanBodyStrength from '../models/humanBodyStrength.model.js';
import { resolveHumanBodyPointId } from './humanBodyPoint.helper.js';
import { assertEvaluationEditable } from '../../evaluations/services/evaluationGuard.js';

export const saveStrength = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const strength = await sequelize.transaction(async transaction => {
        await assertEvaluationEditable(schema, req.body?.evaluationId, req.access?.scope === 'own' ? req.access.userId : undefined, transaction);
        const humanBodyPointId = await resolveHumanBodyPointId(schema, req.body, req.access!.userId, transaction);
        if (!humanBodyPointId) return null;
        await assertClinicalWriteContext(req, {...req.body, humanBodyPointId}, transaction);
        return HumanBodyStrength.schema(schema).create({
            ...req.body,
            humanBodyPointId,
            userId: req.access!.userId
        }, { transaction });
    });
    if (!strength) {
        return sendErrorResponse(res, 400, 'humanBodyPointId or pointToCreate is required');
    }
    return sendSuccessResponse(res, 201, strength, 'Human body strength created');
});

export const getAllStrengthByPoint = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const strength = await HumanBodyStrength.schema(schema).findAll({
        where: { humanBodyPointId: req.query.humanBodyPointId as string, ...patientResourceScopeWhere(req, schema) }
    });
    return sendSuccessResponse(res, 200, Array.isArray(strength)?await visibleClinicalRows(req,strength):(strength), 'Human body strength loaded');
});

/** Was previously an empty stub. Completed here. */
export const getStrengthById = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const strength = await HumanBodyStrength.schema(schema).findOne({ where: { id: req.params.strengthId, ...patientResourceScopeWhere(req, schema) } });
    if (!strength) {
        return sendErrorResponse(res, 404, 'Human body strength not found');
    }
    await assertClinicalRowRead(req,strength);
    return sendSuccessResponse(res, 200, strength, 'Human body strength loaded');
});

/** Was previously an empty stub. Completed here as a real partial update. */
export const updateStrength = asyncHandler(async (req: Request, res: Response) => {
    const input=req.body.strength && typeof req.body.strength==='object' ? req.body.strength:req.body;
    const updated=await updateClinicalRecord(req,HumanBodyStrength,req.params.strengthId,input,["bodyPart","bodySubPart","valueStrength","strengthPain","valueStrengthPain","date"]);
    if(!updated) return sendErrorResponse(res,404,'Clinical record not found');
    return sendSuccessResponse(res,200,updated,'Clinical record updated');
});

/** Was previously an empty stub. Completed here as a real delete. */
export const deleteStrength = asyncHandler(async (req: Request, res: Response) => {
    const removed=await deleteClinicalRecord(req,HumanBodyStrength,req.params.strengthId);
    if(!removed) return sendErrorResponse(res,404,'Clinical record not found');
    return sendSuccessResponse(res,200,null,'Clinical record deleted');
});

/** Was previously an empty stub. Completed here. */
export const getStrengthByBodyPart = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { bodyPart, bodySubPart, patientId, evaluationId } = req.query;

    const where: Record<string, unknown> = {};
    if (bodyPart) where.bodyPart = sequelizeWhere(fn('LOWER', col('bodyPart')), 'LIKE', `%${String(bodyPart).toLowerCase()}%`);
    if (bodySubPart) where.bodySubPart = sequelizeWhere(fn('LOWER', col('bodySubPart')), 'LIKE', `%${String(bodySubPart).toLowerCase()}%`);
    if (patientId) where.patientId = patientId;
    if (evaluationId) where.evaluationId = evaluationId;

    const strength = await HumanBodyStrength.schema(schema).findAll({
        where: withScope(patientResourceScopeWhere(req, schema), where)
    });
    return sendSuccessResponse(res, 200, Array.isArray(strength)?await visibleClinicalRows(req,strength):(strength), 'Human body strength loaded');
});

export default {
    saveStrength,
    getAllStrengthByPoint,
    getStrengthById,
    updateStrength,
    deleteStrength,
    getStrengthByBodyPart
};


