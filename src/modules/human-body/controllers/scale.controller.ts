import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere, Includeable } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendSuccessResponse } from '../../../utils/response.js';
import { Scale, SectionScale, QuestionScale, AnswerScale } from '../models/catalog/index.js';

/**
 * Read-only access to the global scales catalog (public schema, shared by every tenant).
 * The legacy controller used to call `createInitialScales()` (the seed routine) on every single
 * GET request here — that's now done once at boot via `seedCatalogData()` (see server.ts).
 */
const catalogInclude: Includeable[] = [
    {
        model: SectionScale,
        include: [{ model: QuestionScale, include: [AnswerScale] }]
    },
    {
        model: QuestionScale,
        where: { sectionId: null },
        required: false,
        include: [AnswerScale]
    }
];

export const getAllScales = asyncHandler(async (_req: Request, res: Response) => {
    const scales = await Scale.findAll({ include: catalogInclude });
    return sendSuccessResponse(res, 200, scales, 'All scales loaded');
});

export const searchScales = asyncHandler(async (req: Request, res: Response) => {
    const query = ((req.query.query as string) || '').toLowerCase();
    const words = query.split(' ').filter(Boolean);

    const scales = await Scale.findAll({
        where: {
            [Op.or]: [
                sequelizeWhere(fn('LOWER', col('name')), 'LIKE', `%${query}%`),
                sequelizeWhere(fn('LOWER', col('description')), 'LIKE', `%${query}%`),
                {
                    [Op.and]: words.map((word) => ({
                        [Op.or]: [
                            sequelizeWhere(fn('LOWER', col('name')), 'LIKE', `%${word}%`),
                            sequelizeWhere(fn('LOWER', col('description')), 'LIKE', `%${word}%`)
                        ]
                    }))
                }
            ]
        },
        include: catalogInclude
    });

    return sendSuccessResponse(res, 200, scales, 'All scales loaded');
});

export default {
    getAllScales,
    searchScales
};


