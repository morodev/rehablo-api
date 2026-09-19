import { Request, Response } from 'express';
import { fn, col, Op } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendSuccessResponse } from '../../../utils/response.js';
import { Product, ProductStructure, Service, ServiceStructure } from '../models/index.js';
import { boundedInteger, textSearchWhere } from '../../../utils/search.js';
import { availabilityWhere, decorateAvailability } from '../services/structureAvailability.service.js';

export const searchServicesAndProducts = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const search = textSearchWhere(['name', 'description', 'code'], req.query.query);
    const requestedType = String(req.query.type ?? 'all').toLowerCase();
    const type = ['product', 'service'].includes(requestedType) ? requestedType : 'all';
    const limit = boundedInteger(req.query.limit, 20, 1, 50);
    const management = req.query.view === 'management';
    const [serviceScope, productScope] = management
        ? [{}, {}]
        : await Promise.all([
            availabilityWhere(ServiceStructure, schema, 'serviceId', req.access?.structureId),
            availabilityWhere(ProductStructure, schema, 'productId', req.access?.structureId)
        ]);
    const options = (scope: any) => ({
        where: {[Op.and]: [{isActive: true}, scope, ...(search ? [search] : [])]},
        order: [[fn('lower', col('name')), 'ASC'], ['id', 'ASC']] as any,
        limit
    });
    const [serviceRows, productRows] = await Promise.all([
        type === 'product' ? Promise.resolve([]) : Service.schema(schema).findAll(options(serviceScope)),
        type === 'service' ? Promise.resolve([]) : Product.schema(schema).findAll(options(productScope))
    ]);
    const [services, products] = await Promise.all([
        decorateAvailability(serviceRows, ServiceStructure, schema, 'serviceId', req.access?.structureId),
        decorateAvailability(productRows, ProductStructure, schema, 'productId', req.access?.structureId)
    ]);
    const results = [...services, ...products]
        .sort((left: any, right: any) => String(left.name ?? '').localeCompare(String(right.name ?? ''), 'it'))
        .slice(0, limit);
    return sendSuccessResponse(res, 200, results, 'Ricerca completata');
});

export default {searchServicesAndProducts};
