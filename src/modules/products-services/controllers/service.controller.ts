import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import Service from '../models/service.model.js';

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
    const page = parseInt((req.query.page as string) ?? '0', 10);
    const size = parseInt((req.query.size as string) ?? '10', 10);

    const services = await Service.schema(req.tenantSchema!).findAll();
    const { items, pagination } = paginate(services, page, size);

    return sendSuccessResponse(res, 200, { pagination, services: items }, 'Servizi caricati correttamente');
});

export const searchServices = asyncHandler(async (req: Request, res: Response) => {
    const query = (req.query.query as string) || '';

    const services = await Service.schema(req.tenantSchema!).findAll({
        where: {
            [Op.or]: [
                sequelizeWhere(fn('LOWER', col('name')), 'LIKE', `%${query.toLowerCase()}%`),
                sequelizeWhere(fn('LOWER', col('description')), 'LIKE', `%${query.toLowerCase()}%`)
            ]
        }
    });

    return sendSuccessResponse(res, 200, services, 'Ricerca completata');
});

export const findOneService = asyncHandler(async (req: Request, res: Response) => {
    const service = await Service.schema(req.tenantSchema!).findByPk(req.params.serviceId);
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

export const deleteService = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.serviceId;
    const removedService = await Service.schema(req.tenantSchema!).findByPk(id);
    await Service.schema(req.tenantSchema!).destroy({ where: { id } });

    return sendSuccessResponse(res, 200, { removedService }, 'Servizio eliminato correttamente');
});

export default { saveService, findAllServices, searchServices, findOneService, updateService, deleteService };

