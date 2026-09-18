import { Request, Response } from 'express';
import { fn, col, Op } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { Service, Category } from '../models/index.js';
import { boundedInteger, textSearchWhere } from '../../../utils/search.js';

export const saveService = asyncHandler(async (req: Request, res: Response) => {
    const service = await Service.schema(req.tenantSchema!).create(req.body);
    return sendSuccessResponse(res, 201, service, 'Servizio creato correttamente');
});

export const findAllServices = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const page = boundedInteger(req.query.page, 0, 0, Number.MAX_SAFE_INTEGER);
    const size = boundedInteger(req.query.size, 10, 1, 100);
    const includeInactive = req.query.includeInactive === 'true';
    const search = textSearchWhere(['service.name', 'service.description', 'service.code'], req.query.query);

    const data = await Service.schema(schema).findAndCountAll({
        where: {
            [Op.and]: [includeInactive ? {} : { isActive: true }, ...(search ? [search] : [])]
        },
        include: [{ model: Category.schema(schema) }],
        distinct: true,
        limit: size,
        offset: page * size,
        order: [[fn('lower', col('service.name')), 'ASC'], ['id', 'ASC']]
    });
    const pagination = {
        length: data.count,
        size,
        page,
        lastPage: Math.max(Math.ceil(data.count / size), 1),
        startIndex: page * size,
        endIndex: Math.min((page + 1) * size, data.count) - 1
    };

    return sendSuccessResponse(res, 200, { pagination, services: data.rows }, 'Servizi caricati correttamente');
});

export const searchServices = asyncHandler(async (req: Request, res: Response) => {
    const search = textSearchWhere(['service.name', 'service.description', 'service.code'], req.query.query);
    const limit = boundedInteger(req.query.limit, 20, 1, 50);

    const services = await Service.schema(req.tenantSchema!).findAll({
        where: {
            isActive: true,
            ...(search ?? {})
        },
        order: [[fn('lower', col('service.name')), 'ASC'], ['id', 'ASC']],
        limit
    });

    return sendSuccessResponse(res, 200, services, 'Ricerca completata');
});

export const findOneService = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const service = await Service.schema(schema).findByPk(req.params.serviceId, {
        include: [{ model: Category.schema(schema) }]
    });
    if (!service) {
        return sendErrorResponse(res, 404, 'Nessun servizio trovato');
    }
    return sendSuccessResponse(res, 200, { service }, 'Servizio caricato correttamente');
});

export const updateService = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.serviceId;
    const [rowsUpdated] = await Service.schema(req.tenantSchema!).update(req.body.service ?? req.body, { where: { id } });

    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Impossibile aggiornare il servizio');
    }

    const updatedService = await Service.schema(req.tenantSchema!).findByPk(id);
    return sendSuccessResponse(res, 200, updatedService, 'Servizio aggiornato correttamente');
});

/** "Elimina" un servizio = lo disattiva (soft-delete). Vedi commento analogo su product.controller.ts. */
export const deleteService = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.serviceId;
    const [rowsUpdated] = await Service.schema(req.tenantSchema!).update({ isActive: false }, { where: { id } });

    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Servizio non trovato');
    }

    const removedService = await Service.schema(req.tenantSchema!).findByPk(id);

    return sendSuccessResponse(res, 200, { removedService }, 'Servizio eliminato correttamente');
});

export default { saveService, findAllServices, searchServices, findOneService, updateService, deleteService };

