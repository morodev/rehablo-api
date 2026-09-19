import { Request, Response } from 'express';
import { fn, col, Op } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { Service, ServiceStructure, Category } from '../models/index.js';
import EventType from '../../agenda/models/eventType.model.js';
import EventTypeStructure from '../../agenda/models/eventTypeStructure.model.js';
import { boundedInteger, textSearchWhere } from '../../../utils/search.js';
import { sequelize } from '../../../config/database.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import {
    availabilityError, availabilityWhere, decorateAvailability, effectiveStructureIds,
    mappedStructureIds, normalizeAvailabilityMode, normalizeStructureIds, syncMappedStructures,
    tenantStructureIds, validateAvailability
} from '../services/structureAvailability.service.js';

function catalogPayload(body: any): Record<string, any> {
    const source = body?.service ?? body ?? {};
    const {structureIds: _structureIds, availableInCurrentStructure: _available, ...payload} = source;
    return payload;
}

async function decorate(req: Request, rows: any[]): Promise<any[]> {
    return decorateAvailability(rows, ServiceStructure, req.tenantSchema!, 'serviceId', req.access?.structureId);
}

async function validateLinkedEventTypes(
    tenantId: string, schema: string, serviceId: string, mode: 'ALL' | 'SELECTED', structureIds: string[]
): Promise<void> {
    const linked = await EventType.schema(schema).findAll({where: {linkedServiceId: serviceId}});
    if (linked.length === 0 || mode === 'ALL') return;
    const allowed = new Set(await effectiveStructureIds(tenantId, mode, structureIds));
    const allTenantIds = await tenantStructureIds(tenantId);
    for (const eventType of linked) {
        const eventIds = eventType.availabilityMode === 'ALL'
            ? allTenantIds
            : await mappedStructureIds(EventTypeStructure, schema, 'eventTypeId', eventType.id);
        if (eventIds.some(id => !allowed.has(id))) {
            throw availabilityError(
                `Il servizio e collegato al tipo appuntamento "${eventType.title}" in una sede che stai disabilitando`,
                409
            );
        }
    }
}

export const saveService = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const source = req.body?.service ?? req.body ?? {};
    const mode = normalizeAvailabilityMode(source.availabilityMode);
    const structureIds = normalizeStructureIds(source.structureIds);
    await validateAvailability(getCurrentTenantId(req), mode, structureIds);
    const created = await sequelize.transaction(async transaction => {
        const service = await Service.schema(schema).create(
            {...catalogPayload(req.body), availabilityMode: mode}, {transaction}
        );
        await syncMappedStructures(ServiceStructure, schema, 'serviceId', service.id, mode, structureIds, transaction);
        return service;
    });
    const [service] = await decorate(req, [created]);
    return sendSuccessResponse(res, 201, service, 'Servizio creato correttamente');
});

export const findAllServices = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const page = boundedInteger(req.query.page, 0, 0, Number.MAX_SAFE_INTEGER);
    const size = boundedInteger(req.query.size, 10, 1, 100);
    const includeInactive = req.query.includeInactive === 'true';
    const search = textSearchWhere(['service.name', 'service.description', 'service.code'], req.query.query);
    const scope = req.query.view === 'management' ? {} : await availabilityWhere(
        ServiceStructure, schema, 'serviceId', req.access?.structureId
    );
    const data = await Service.schema(schema).findAndCountAll({
        where: {[Op.and]: [includeInactive ? {} : {isActive: true}, scope, ...(search ? [search] : [])]},
        include: [{model: Category.schema(schema)}], distinct: true,
        limit: size, offset: page * size,
        order: [[fn('lower', col('service.name')), 'ASC'], ['id', 'ASC']]
    });
    const services = await decorate(req, data.rows);
    const pagination = {
        length: data.count, size, page,
        lastPage: Math.max(Math.ceil(data.count / size), 1),
        startIndex: page * size,
        endIndex: Math.min((page + 1) * size, data.count) - 1
    };
    return sendSuccessResponse(res, 200, {pagination, services}, 'Servizi caricati correttamente');
});

export const searchServices = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const search = textSearchWhere(['service.name', 'service.description', 'service.code'], req.query.query);
    const limit = boundedInteger(req.query.limit, 20, 1, 50);
    const scope = req.query.view === 'management' ? {} : await availabilityWhere(
        ServiceStructure, schema, 'serviceId', req.access?.structureId
    );
    const rows = await Service.schema(schema).findAll({
        where: {[Op.and]: [{isActive: true}, scope, ...(search ? [search] : [])]},
        order: [[fn('lower', col('service.name')), 'ASC'], ['id', 'ASC']], limit
    });
    return sendSuccessResponse(res, 200, await decorate(req, rows), 'Ricerca completata');
});

export const findOneService = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const service = await Service.schema(schema).findByPk(req.params.serviceId, {
        include: [{model: Category.schema(schema)}]
    });
    if (!service) return sendErrorResponse(res, 404, 'Nessun servizio trovato');
    const [decorated] = await decorate(req, [service]);
    return sendSuccessResponse(res, 200, {service: decorated}, 'Servizio caricato correttamente');
});

export const updateService = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.serviceId;
    const current = await Service.schema(schema).findByPk(id);
    if (!current) return sendErrorResponse(res, 404, 'Impossibile aggiornare il servizio');
    const currentIds = await mappedStructureIds(ServiceStructure, schema, 'serviceId', id);
    const source = req.body?.service ?? req.body ?? {};
    const mode = normalizeAvailabilityMode(source.availabilityMode, current.availabilityMode);
    const structureIds = normalizeStructureIds(source.structureIds, currentIds);
    const tenantId = getCurrentTenantId(req);
    await validateAvailability(tenantId, mode, structureIds);
    await validateLinkedEventTypes(tenantId, schema, id, mode, structureIds);

    await sequelize.transaction(async transaction => {
        await current.update({...catalogPayload(req.body), availabilityMode: mode}, {transaction});
        await syncMappedStructures(ServiceStructure, schema, 'serviceId', id, mode, structureIds, transaction);
    });
    const updated = await Service.schema(schema).findByPk(id);
    const [decorated] = await decorate(req, updated ? [updated] : []);
    return sendSuccessResponse(res, 200, decorated, 'Servizio aggiornato correttamente');
});

export const deleteService = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.serviceId;
    const [rowsUpdated] = await Service.schema(req.tenantSchema!).update({isActive: false}, {where: {id}});
    if (rowsUpdated === 0) return sendErrorResponse(res, 404, 'Servizio non trovato');
    const removedService = await Service.schema(req.tenantSchema!).findByPk(id);
    return sendSuccessResponse(res, 200, {removedService}, 'Servizio eliminato correttamente');
});

export default {saveService, findAllServices, searchServices, findOneService, updateService, deleteService};
