import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendSuccessResponse } from '../../../utils/response.js';
import MetricDefinition from '../models/catalog/metricDefinition.model.js';
import { boundedInteger, textSearchWhere } from '../../../utils/search.js';
import { Op } from 'sequelize';

/**
 * Elenco delle metriche del dizionario (Clinical Data Dictionary). È ciò che il mapping wizard usa
 * come "target": l'operatore mappa una colonna del CSV su una di queste metriche.
 * Query opzionali: ?category=STRENGTH  ?district=knee  ?search=knee
 */
export const list = asyncHandler(async (req: Request, res: Response) => {
    const { category, search } = req.query as { category?: string; search?: string; district?: string };

    const where: Record<string, unknown> = { isActive: true };
    if (category) where.category = category;
    const textSearch = textSearchWhere(['code', 'displayName'], search);
    const limit = boundedInteger(req.query.limit, 50, 1, 100);

    let metrics = await MetricDefinition.findAll({
        where: (textSearch ? { [Op.and]: [where, textSearch] } : where) as any,
        order: [['code', 'ASC']]
    });

    const district = (req.query.district as string) || '';
    if (district) {
        metrics = metrics.filter((m) => ((m.get('applicableDistricts') as string[]) ?? []).includes(district));
    }
    metrics = metrics.slice(0, limit);

    return sendSuccessResponse(res, 200, metrics, 'Dizionario metriche');
});

export default { list };

