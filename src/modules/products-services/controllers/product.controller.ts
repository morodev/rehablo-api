import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import Product from '../models/product.model.js';

function paginate<T>(items: T[], page: number, size: number) {
    const length = items.length;
    const begin = page * size;
    const end = Math.min(size * (page + 1), length);
    const lastPage = Math.max(Math.ceil(length / size), 1);

    if (page > lastPage) {
        return { items: null, pagination: { lastPage } };
    }

    return {
        items: items.slice(begin, end),
        pagination: { length, size, page, lastPage, startIndex: begin, endIndex: end - 1 }
    };
}

export const saveProduct = asyncHandler(async (req: Request, res: Response) => {
    const product = await Product.schema(req.tenantSchema!).create(req.body);
    return sendSuccessResponse(res, 201, product, 'Prodotto creato correttamente');
});

export const findAllProduct = asyncHandler(async (req: Request, res: Response) => {
    const page = parseInt((req.query.page as string) ?? '0', 10);
    const size = parseInt((req.query.size as string) ?? '10', 10);

    const products = await Product.schema(req.tenantSchema!).findAll();
    const { items, pagination } = paginate(products, page, size);

    return sendSuccessResponse(res, 200, { pagination, products: items }, 'Prodotti caricati correttamente');
});

export const searchProducts = asyncHandler(async (req: Request, res: Response) => {
    const query = (req.query.query as string) || '';

    const products = await Product.schema(req.tenantSchema!).findAll({
        where: {
            [Op.or]: [
                sequelizeWhere(fn('LOWER', col('name')), 'LIKE', `%${query.toLowerCase()}%`),
                sequelizeWhere(fn('LOWER', col('description')), 'LIKE', `%${query.toLowerCase()}%`)
            ]
        }
    });

    return sendSuccessResponse(res, 200, products, 'Ricerca completata');
});

export const findOneProduct = asyncHandler(async (req: Request, res: Response) => {
    const product = await Product.schema(req.tenantSchema!).findByPk(req.params.productId);
    if (!product) {
        return sendErrorResponse(res, 404, 'Prodotto non trovato');
    }
    return sendSuccessResponse(res, 200, { product }, 'Prodotto caricato correttamente');
});

export const updateProduct = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.productId;
    const [rowsUpdated] = await Product.schema(req.tenantSchema!).update(req.body.product ?? req.body, { where: { id } });

    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Impossibile aggiornare il prodotto');
    }

    const updatedProduct = await Product.schema(req.tenantSchema!).findByPk(id);
    return sendSuccessResponse(res, 200, updatedProduct, 'Prodotto aggiornato correttamente');
});

export const deleteProduct = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.productId;
    const removedProduct = await Product.schema(req.tenantSchema!).findByPk(id);
    await Product.schema(req.tenantSchema!).destroy({ where: { id } });

    return sendSuccessResponse(res, 200, { removedProduct }, 'Prodotto eliminato correttamente');
});

export default { saveProduct, findAllProduct, searchProducts, findOneProduct, updateProduct, deleteProduct };

