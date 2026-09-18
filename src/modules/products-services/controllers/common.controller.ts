import { Request, Response } from 'express';
import { fn, col } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendSuccessResponse } from '../../../utils/response.js';
import Service from '../models/service.model.js';
import Product from '../models/product.model.js';
import { boundedInteger, textSearchWhere } from '../../../utils/search.js';

export const searchServicesAndProducts = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const search = textSearchWhere(['name', 'description', 'code'], req.query.query);
    const requestedType = String(req.query.type ?? 'all').toLowerCase();
    const type = ['product', 'service'].includes(requestedType) ? requestedType : 'all';
    const limit = boundedInteger(req.query.limit, 20, 1, 50);
    const options = {
        where: { isActive: true, ...(search ?? {}) },
        order: [[fn('lower', col('name')), 'ASC'], ['id', 'ASC']] as any,
        limit,
        raw: true
    };

    const [services, products] = await Promise.all([
        type === 'product' ? Promise.resolve([]) : Service.schema(schema).findAll(options),
        type === 'service' ? Promise.resolve([]) : Product.schema(schema).findAll(options)
    ]);

    const results = [...services, ...products]
        .sort((left: any, right: any) => String(left.name ?? '').localeCompare(String(right.name ?? ''), 'it'))
        .slice(0, limit);
    return sendSuccessResponse(res, 200, results, 'Ricerca completata');
});

export default { searchServicesAndProducts };

