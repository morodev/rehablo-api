import { Request, Response } from 'express';
import { fn, col, Op } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { Product, ProductStructure, Category } from '../models/index.js';
import { boundedInteger, textSearchWhere } from '../../../utils/search.js';
import { sequelize } from '../../../config/database.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import {
    availabilityWhere, decorateAvailability, mappedStructureIds, normalizeAvailabilityMode,
    normalizeStructureIds, syncMappedStructures, validateAvailability
} from '../services/structureAvailability.service.js';

function catalogPayload(body: any): Record<string, any> {
    const source = body?.product ?? body ?? {};
    const {structureIds: _structureIds, availableInCurrentStructure: _available, ...payload} = source;
    return payload;
}

async function decorate(req: Request, rows: any[]): Promise<any[]> {
    return decorateAvailability(
        rows, ProductStructure, req.tenantSchema!, 'productId', req.access?.structureId
    );
}

export const saveProduct = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const source = req.body?.product ?? req.body ?? {};
    const mode = normalizeAvailabilityMode(source.availabilityMode);
    const structureIds = normalizeStructureIds(source.structureIds);
    await validateAvailability(getCurrentTenantId(req), mode, structureIds);

    const created = await sequelize.transaction(async transaction => {
        const product = await Product.schema(schema).create(
            {...catalogPayload(req.body), availabilityMode: mode}, {transaction}
        );
        await syncMappedStructures(
            ProductStructure, schema, 'productId', product.id, mode, structureIds, transaction
        );
        return product;
    });
    const [product] = await decorate(req, [created]);
    return sendSuccessResponse(res, 201, product, 'Prodotto creato correttamente');
});

export const findAllProduct = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const page = boundedInteger(req.query.page, 0, 0, Number.MAX_SAFE_INTEGER);
    const size = boundedInteger(req.query.size, 10, 1, 100);
    const includeInactive = req.query.includeInactive === 'true';
    const management = req.query.view === 'management';
    const search = textSearchWhere(['product.name', 'product.description', 'product.code'], req.query.query);
    const scope = management ? {} : await availabilityWhere(
        ProductStructure, schema, 'productId', req.access?.structureId
    );

    const data = await Product.schema(schema).findAndCountAll({
        where: {
            [Op.and]: [includeInactive ? {} : {isActive: true}, scope, ...(search ? [search] : [])]
        },
        include: [{model: Category.schema(schema)}],
        distinct: true,
        limit: size,
        offset: page * size,
        order: [[fn('lower', col('product.name')), 'ASC'], ['id', 'ASC']]
    });
    const products = await decorate(req, data.rows);
    const pagination = {
        length: data.count, size, page,
        lastPage: Math.max(Math.ceil(data.count / size), 1),
        startIndex: page * size,
        endIndex: Math.min((page + 1) * size, data.count) - 1
    };
    return sendSuccessResponse(res, 200, {pagination, products}, 'Prodotti caricati correttamente');
});

export const searchProducts = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const search = textSearchWhere(['product.name', 'product.description', 'product.code'], req.query.query);
    const limit = boundedInteger(req.query.limit, 20, 1, 50);
    const scope = req.query.view === 'management' ? {} : await availabilityWhere(
        ProductStructure, schema, 'productId', req.access?.structureId
    );
    const rows = await Product.schema(schema).findAll({
        where: {[Op.and]: [{isActive: true}, scope, ...(search ? [search] : [])]},
        order: [[fn('lower', col('product.name')), 'ASC'], ['id', 'ASC']], limit
    });
    return sendSuccessResponse(res, 200, await decorate(req, rows), 'Ricerca completata');
});

export const findOneProduct = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const product = await Product.schema(schema).findByPk(req.params.productId, {
        include: [{model: Category.schema(schema)}]
    });
    if (!product) return sendErrorResponse(res, 404, 'Prodotto non trovato');
    const [decorated] = await decorate(req, [product]);
    return sendSuccessResponse(res, 200, {product: decorated}, 'Prodotto caricato correttamente');
});

export const updateProduct = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.productId;
    const current = await Product.schema(schema).findByPk(id);
    if (!current) return sendErrorResponse(res, 404, 'Impossibile aggiornare il prodotto');
    const currentIds = await mappedStructureIds(ProductStructure, schema, 'productId', id);
    const source = req.body?.product ?? req.body ?? {};
    const mode = normalizeAvailabilityMode(source.availabilityMode, current.availabilityMode);
    const structureIds = normalizeStructureIds(source.structureIds, currentIds);
    await validateAvailability(getCurrentTenantId(req), mode, structureIds);

    await sequelize.transaction(async transaction => {
        await current.update({...catalogPayload(req.body), availabilityMode: mode}, {transaction});
        await syncMappedStructures(ProductStructure, schema, 'productId', id, mode, structureIds, transaction);
    });
    const updated = await Product.schema(schema).findByPk(id);
    const [decorated] = await decorate(req, updated ? [updated] : []);
    return sendSuccessResponse(res, 200, decorated, 'Prodotto aggiornato correttamente');
});

export const deleteProduct = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.productId;
    const [rowsUpdated] = await Product.schema(req.tenantSchema!).update({isActive: false}, {where: {id}});
    if (rowsUpdated === 0) return sendErrorResponse(res, 404, 'Prodotto non trovato');
    const removedProduct = await Product.schema(req.tenantSchema!).findByPk(id);
    return sendSuccessResponse(res, 200, {removedProduct}, 'Prodotto eliminato correttamente');
});

export default {saveProduct, findAllProduct, searchProducts, findOneProduct, updateProduct, deleteProduct};
