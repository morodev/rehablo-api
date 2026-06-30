import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendSuccessResponse } from '../../../utils/response.js';
import Service from '../models/service.model.js';
import Product from '../models/product.model.js';

export const searchServicesAndProducts = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const query = (req.query.query as string) || '';

    const likeClause = (field: string) => sequelizeWhere(fn('LOWER', col(field)), 'LIKE', `%${query.toLowerCase()}%`);

    const [services, products] = await Promise.all([
        Service.schema(schema).findAll({ where: { [Op.or]: [likeClause('name'), likeClause('description')] }, raw: true }),
        Product.schema(schema).findAll({ where: { [Op.or]: [likeClause('name'), likeClause('description')] }, raw: true })
    ]);

    return sendSuccessResponse(res, 200, [...services, ...products], 'Ricerca completata');
});

export default { searchServicesAndProducts };

