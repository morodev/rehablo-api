import { Request, Response } from 'express';
import { fn, col, Op } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { Product, Category } from '../models/index.js';
import { boundedInteger, textSearchWhere } from '../../../utils/search.js';

export const saveProduct = asyncHandler(async (req: Request, res: Response) => {
    const product = await Product.schema(req.tenantSchema!).create(req.body);
    return sendSuccessResponse(res, 201, product, 'Prodotto creato correttamente');
});

export const findAllProduct = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const page = boundedInteger(req.query.page, 0, 0, Number.MAX_SAFE_INTEGER);
    const size = boundedInteger(req.query.size, 10, 1, 100);
    const includeInactive = req.query.includeInactive === 'true';
    const search = textSearchWhere(['product.name', 'product.description', 'product.code'], req.query.query);

    const data = await Product.schema(schema).findAndCountAll({
        where: {
            [Op.and]: [includeInactive ? {} : { isActive: true }, ...(search ? [search] : [])]
        },
        include: [{ model: Category.schema(schema) }],
        distinct: true,
        limit: size,
        offset: page * size,
        order: [[fn('lower', col('product.name')), 'ASC'], ['id', 'ASC']]
    });
    const pagination = {
        length: data.count,
        size,
        page,
        lastPage: Math.max(Math.ceil(data.count / size), 1),
        startIndex: page * size,
        endIndex: Math.min((page + 1) * size, data.count) - 1
    };

    return sendSuccessResponse(res, 200, { pagination, products: data.rows }, 'Prodotti caricati correttamente');
});

export const searchProducts = asyncHandler(async (req: Request, res: Response) => {
    const search = textSearchWhere(['product.name', 'product.description', 'product.code'], req.query.query);
    const limit = boundedInteger(req.query.limit, 20, 1, 50);

    const products = await Product.schema(req.tenantSchema!).findAll({
        where: {
            isActive: true,
            ...(search ?? {})
        },
        order: [[fn('lower', col('product.name')), 'ASC'], ['id', 'ASC']],
        limit
    });

    return sendSuccessResponse(res, 200, products, 'Ricerca completata');
});

export const findOneProduct = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const product = await Product.schema(schema).findByPk(req.params.productId, {
        include: [{ model: Category.schema(schema) }]
    });
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

/**
 * "Elimina" un prodotto = lo disattiva (soft-delete). Un prodotto già usato in fatture emesse
 * non può essere cancellato fisicamente: le righe storiche (`invoice_products`) mantengono
 * comunque un proprio snapshot di nome/prezzo/IVA, ma il riferimento ProductId deve continuare
 * a esistere per non rompere l'integrità del documento fiscale.
 */
export const deleteProduct = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.productId;
    const [rowsUpdated] = await Product.schema(req.tenantSchema!).update({ isActive: false }, { where: { id } });

    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Prodotto non trovato');
    }

    const removedProduct = await Product.schema(req.tenantSchema!).findByPk(id);

    return sendSuccessResponse(res, 200, { removedProduct }, 'Prodotto eliminato correttamente');
});

export default { saveProduct, findAllProduct, searchProducts, findOneProduct, updateProduct, deleteProduct };

