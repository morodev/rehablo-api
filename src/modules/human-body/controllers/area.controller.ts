import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendSuccessResponse } from '../../../utils/response.js';
import HumanBodyArea from '../models/humanBodyArea.model.js';
import HumanBodySymptom from '../models/humanBodySymptom.model.js';

export const saveHumanBodyArea = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;

    const area = await HumanBodyArea.schema(schema).create(req.body);

    if (req.body.symptom) {
        await HumanBodySymptom.schema(schema).create({ ...req.body.symptom, humanBodyAreaId: area.get('id') });
    }

    return sendSuccessResponse(res, 201, area, 'Human body area created');
});

export const getAllHumanBodyAreas = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const areas = await HumanBodyArea.schema(schema).findAll({
        where: { patientId: req.query.patientId as string, userId: req.user!.id }
    });
    return sendSuccessResponse(res, 200, areas, 'Human body areas loaded');
});

export default {
    saveHumanBodyArea,
    getAllHumanBodyAreas
};


