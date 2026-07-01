import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { Service, Category } from '../models/index.js';

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

export const saveService = asyncHandler(async (req: Request, res: Response) => {
    const service = await Service.schema(req.tenantSchema!).create(req.body);
    return sendSuccessResponse(res, 201, service, 'Servizio creato correttamente');
});

export const findAllServices = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const page = parseInt((req.query.page as string) ?? '0', 10);
    const size = parseInt((req.query.size as string) ?? '10', 10);
    const includeInactive = req.query.includeInactive === 'true';

    const services = await Service.schema(schema).findAll({
        where: includeInactive ? {} : { isActive: true },
        include: [{ model: Category.schema(schema) }]
    });
    const { items, pagination } = paginate(services, page, size);

    return sendSuccessResponse(res, 200, { pagination, services: items }, 'Servizi caricati correttamente');
});

export const searchServices = asyncHandler(async (req: Request, res: Response) => {
    const query = (req.query.query as string) || '';

    const services = await Service.schema(req.tenantSchema!).findAll({
        where: {
            isActive: true,
            [Op.or]: [
                sequelizeWhere(fn('LOWER', col('name')), 'LIKE', `%${query.toLowerCase()}%`),
                sequelizeWhere(fn('LOWER', col('description')), 'LIKE', `%${query.toLowerCase()}%`)
            ]
        }
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

