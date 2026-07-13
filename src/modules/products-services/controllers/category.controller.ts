import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { Category, Product, Service } from '../models/index.js';

export const saveCategory = asyncHandler(async (req: Request, res: Response) => {
    const category = await Category.schema(req.tenantSchema!).create(req.body);
    return sendSuccessResponse(res, 201, category, 'Categoria creata correttamente');
});

export const findAllCategories = asyncHandler(async (req: Request, res: Response) => {
    const includeInactive = req.query.includeInactive === 'true';
    const { appliesTo } = req.query as { appliesTo?: 'PRODUCT' | 'SERVICE' | 'BOTH' };

    const categories = await Category.schema(req.tenantSchema!).findAll({
        where: {
            ...(includeInactive ? {} : { isActive: true }),
            ...(appliesTo ? { [Op.or]: [{ appliesTo }, { appliesTo: 'BOTH' }] } : {})
        },
        order: [[fn('lower', col('name')), 'ASC']]
    });

    return sendSuccessResponse(res, 200, categories, 'Categorie caricate correttamente');
});

export const searchCategories = asyncHandler(async (req: Request, res: Response) => {
    const query = (req.query.query as string) || '';

    const categories = await Category.schema(req.tenantSchema!).findAll({
        where: { isActive: true, [Op.or]: [sequelizeWhere(fn('LOWER', col('name')), 'LIKE', `%${query.toLowerCase()}%`)] }
    });

    return sendSuccessResponse(res, 200, categories, 'Ricerca completata');
});

export const findOneCategory = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const category = await Category.schema(schema).findByPk(req.params.categoryId, {
        include: [{ model: Product.schema(schema) }, { model: Service.schema(schema) }]
    });
    if (!category) {
        return sendErrorResponse(res, 404, 'Categoria non trovata');
    }
    return sendSuccessResponse(res, 200, { category }, 'Categoria caricata correttamente');
});

export const updateCategory = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.categoryId;
    const [rowsUpdated] = await Category.schema(req.tenantSchema!).update(req.body.category ?? req.body, { where: { id } });

    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Impossibile aggiornare la categoria');
    }

    const updatedCategory = await Category.schema(req.tenantSchema!).findByPk(id);
    return sendSuccessResponse(res, 200, updatedCategory, 'Categoria aggiornata correttamente');
});

/**
 * "Elimina" una categoria = la disattiva (soft-delete), stesso principio di
 * `product.controller.ts`/`service.controller.ts`: prodotti/servizi che la referenziano
 * mantengono comunque il proprio `categoryId` per non rompere i riferimenti storici.
 */
export const deleteCategory = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.categoryId;
    const [rowsUpdated] = await Category.schema(req.tenantSchema!).update({ isActive: false }, { where: { id } });

    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Categoria non trovata');
    }

    const removedCategory = await Category.schema(req.tenantSchema!).findByPk(id);
    return sendSuccessResponse(res, 200, { removedCategory }, 'Categoria eliminata correttamente');
});

export default { saveCategory, findAllCategories, searchCategories, findOneCategory, updateCategory, deleteCategory };

