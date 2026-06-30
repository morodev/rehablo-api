import { Request, Response } from 'express';
import { fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import EventType from '../models/eventType.model.js';

export const createEventType = asyncHandler(async (req: Request, res: Response) => {
    const eventType = await EventType.schema(req.tenantSchema!).create(req.body);
    return sendSuccessResponse(res, 201, eventType, 'Event Type created');
});

export const findAllEventType = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const eventsType = await EventType.schema(schema).findAll();

    if (eventsType.length === 0) {
        const defaultEventTypes = await EventType.schema(schema).bulkCreate([
            { title: 'Prima visita', erasable: false },
            { title: 'Visita di controllo', erasable: false }
        ]);
        return sendSuccessResponse(res, 200, defaultEventTypes, 'Default Events Type loaded');
    }

    return sendSuccessResponse(res, 200, eventsType, 'Events Type loaded');
});

export const findEventById = asyncHandler(async (req: Request, res: Response) => {
    const eventType = await EventType.schema(req.tenantSchema!).findByPk(req.params.eventTypeId);
    if (!eventType) {
        return sendErrorResponse(res, 404, 'Event Type not found');
    }
    return sendSuccessResponse(res, 200, eventType, 'Event Type loaded');
});

export const updateEventType = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.eventTypeId;

    const [rowsUpdated] = await EventType.schema(schema).update(req.body.eventType ?? req.body, { where: { id } });
    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Event Type not found');
    }

    const updated = await EventType.schema(schema).findByPk(id);
    return sendSuccessResponse(res, 200, updated, 'Event Type updated');
});

export const deleteEventType = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.eventTypeId;
    const deleted = await EventType.schema(schema).destroy({ where: { id } });
    return sendSuccessResponse(res, 200, { deleted }, 'Event Type deleted');
});

export const searchEventType = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const query = (req.query.query as string) || '';

    const data = await EventType.schema(schema).findAll({
        where: sequelizeWhere(fn('LOWER', col('title')), 'LIKE', `%${query.toLowerCase()}%`)
    });

    return sendSuccessResponse(res, 200, data, 'Event Type searched');
});

export default { createEventType, findAllEventType, findEventById, updateEventType, deleteEventType, searchEventType };

