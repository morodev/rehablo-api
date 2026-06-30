import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendSuccessResponse } from '../../../utils/response.js';
import { Test } from '../models/catalog/index.js';

function toBase64Image(plain: Record<string, any>) {
    if (plain.image) {
        plain.image = `data:image/jpeg;base64,${Buffer.from(plain.image).toString('base64')}`;
    }
    return plain;
}

/**
 * Read-only access to the global tests catalog (public schema, shared by every tenant).
 * The legacy controller used to call `createInitialTest()` (the seed routine) on every single
 * GET request here — that's now done once at boot via `seedCatalogData()` (see server.ts).
 */
export const getAllTests = asyncHandler(async (_req: Request, res: Response) => {
    const tests = await Test.findAll();
    const processed = tests.map((test) => toBase64Image(test.get({ plain: true })));
    return sendSuccessResponse(res, 200, processed, 'All tests loaded');
});

export const getAllOrthopedicTests = asyncHandler(async (_req: Request, res: Response) => {
    const tests = await Test.findAll({ where: { type: 'orthopedic' } });
    const processed = tests.map((test) => toBase64Image(test.get({ plain: true })));
    return sendSuccessResponse(res, 200, processed, 'All orthopedic tests loaded');
});

export const getAllClinicTests = asyncHandler(async (_req: Request, res: Response) => {
    const tests = await Test.findAll({ where: { type: 'clinic' } });
    const processed = tests.map((test) => toBase64Image(test.get({ plain: true })));
    return sendSuccessResponse(res, 200, processed, 'All clinic tests loaded');
});

export const searchTests = asyncHandler(async (req: Request, res: Response) => {
    const query = ((req.query.query as string) || '').toLowerCase();

    const tests = await Test.findAll({
        where: {
            [Op.or]: [
                sequelizeWhere(fn('LOWER', col('name')), 'LIKE', `%${query}%`),
                sequelizeWhere(fn('LOWER', col('description')), 'LIKE', `%${query}%`)
            ]
        },
        order: [[fn('lower', col('name')), 'ASC']]
    });

    const processed = tests.map((test) => toBase64Image(test.get({ plain: true })));
    return sendSuccessResponse(res, 200, processed, 'All tests loaded');
});

export default {
    getAllTests,
    getAllOrthopedicTests,
    getAllClinicTests,
    searchTests
};


