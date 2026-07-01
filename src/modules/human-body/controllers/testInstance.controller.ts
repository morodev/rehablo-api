import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendSuccessResponse } from '../../../utils/response.js';
import { Test } from '../models/catalog/index.js';
import TestInstance from '../models/testInstance.model.js';

export const saveTest = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const testInstance = await TestInstance.schema(schema).create(req.body);
    return sendSuccessResponse(res, 201, testInstance, 'Test instance saved');
});

export const getUserTestInstances = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { patientId, evaluationId } = req.query as { patientId?: string; evaluationId?: string };

    const where: Record<string, unknown> = {};
    if (patientId) where.patientId = patientId;
    if (evaluationId) where.evaluationId = evaluationId;

    const instances = await TestInstance.schema(schema).findAll({
        where,
        include: [{ model: Test, required: false }]
    });

    const processed = instances.map((instance) => {
        const plain = instance.get({ plain: true }) as any;
        if (plain.test?.image) {
            plain.test.image = `data:image/jpeg;base64,${Buffer.from(plain.test.image).toString('base64')}`;
        }
        return plain;
    });

    return sendSuccessResponse(res, 200, processed, 'Test instances fetched');
});

export default {
    saveTest,
    getUserTestInstances
};


