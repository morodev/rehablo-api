import { Request, Response } from 'express';
import { fn, col, Op, Transaction } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { boundedInteger, textSearchWhere } from '../../../utils/search.js';
import { sequelize } from '../../../config/database.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import EventType from '../models/eventType.model.js';
import EventTypeStructure from '../models/eventTypeStructure.model.js';
import { Service, ServiceStructure } from '../../products-services/models/index.js';
import {
    availabilityError, availabilityWhere, effectiveStructureIds, itemAvailableInStructure,
    mappedStructureIds, normalizeAvailabilityMode, normalizeStructureIds, tenantStructureIds,
    validateAvailability
} from '../../products-services/services/structureAvailability.service.js';

function isReservedTimeOffTitle(value: unknown): boolean {
    const title = `${value ?? ''}`.trim().toLocaleLowerCase('it');
    return title === 'ferie' || title === 'permesso';
}

function eventTypePayload(body: any): Record<string, any> {
    const source = body?.eventType ?? body ?? {};
    const {
        structureIds: _structureIds,
        defaultStructureIds: _defaultStructureIds,
        availableInCurrentStructure: _available,
        ...payload
    } = source;
    return payload;
}

function sortEventTypes(rows: any[]): any[] {
    return [...rows].sort((left, right) =>
        Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault))
        || String(left.title ?? '').localeCompare(String(right.title ?? ''), 'it')
        || String(left.id).localeCompare(String(right.id))
    );
}

async function ownMappings(schema: string, eventTypeId: string, transaction?: Transaction): Promise<any[]> {
    return EventTypeStructure.schema(schema).findAll({
        where: {eventTypeId}, attributes: ['structureId', 'isDefault'], raw: true, transaction
    });
}

async function decorate(req: Request, rows: any[]): Promise<any[]> {
    const plainRows = rows.map(row => typeof row?.get === 'function' ? row.get({plain: true}) : row);
    const ids = plainRows.map(row => row.id).filter(Boolean);
    const mappings = ids.length ? await EventTypeStructure.schema(req.tenantSchema!).findAll({
        where: {eventTypeId: {[Op.in]: ids}}, attributes: ['eventTypeId', 'structureId', 'isDefault'], raw: true
    }) : [];
    const selectedByEvent = new Map<string, string[]>();
    const defaultsByEvent = new Map<string, string[]>();
    for (const mapping of mappings) {
        const id = String(mapping.eventTypeId);
        selectedByEvent.set(id, [...(selectedByEvent.get(id) ?? []), String(mapping.structureId)]);
        if (mapping.isDefault) {
            defaultsByEvent.set(id, [...(defaultsByEvent.get(id) ?? []), String(mapping.structureId)]);
        }
    }
    const currentStructureId = req.access?.structureId ?? null;
    return sortEventTypes(plainRows.map(row => {
        const mappedIds = selectedByEvent.get(String(row.id)) ?? [];
        const defaultStructureIds = defaultsByEvent.get(String(row.id)) ?? [];
        const structureIds = row.availabilityMode === 'SELECTED' ? mappedIds : [];
        return {
            ...row,
            structureIds,
            defaultStructureIds,
            availableInCurrentStructure: row.availabilityMode === 'ALL'
                || (!!currentStructureId && structureIds.includes(currentStructureId)),
            isDefault: !!currentStructureId && defaultStructureIds.includes(currentStructureId)
        };
    }));
}

async function validateLinkedService(
    tenantId: string,
    schema: string,
    linkedServiceId: unknown,
    mode: 'ALL' | 'SELECTED',
    structureIds: string[],
    transaction?: Transaction
): Promise<void> {
    if (!linkedServiceId) return;
    const service = await Service.schema(schema).findOne({
        where: {id: linkedServiceId, isActive: true}, transaction
    });
    if (!service) throw availabilityError('Il servizio collegato non esiste o non e attivo');
    const serviceSelected = await mappedStructureIds(
        ServiceStructure, schema, 'serviceId', service.id, transaction
    );
    const [eventStructures, serviceStructures] = await Promise.all([
        effectiveStructureIds(tenantId, mode, structureIds, transaction),
        effectiveStructureIds(tenantId, service.availabilityMode, serviceSelected, transaction)
    ]);
    const serviceSet = new Set(serviceStructures);
    if (eventStructures.some(id => !serviceSet.has(id))) {
        throw availabilityError('Il servizio collegato deve essere disponibile in tutte le sedi del tipo appuntamento');
    }
}

async function syncEventMappings(
    schema: string,
    eventTypeId: string,
    mode: 'ALL' | 'SELECTED',
    structureIds: string[],
    defaultStructureIds: string[],
    transaction: Transaction
): Promise<void> {
    const scoped = EventTypeStructure.schema(schema);
    if (defaultStructureIds.length) {
        await scoped.update(
            {isDefault: false},
            {where: {structureId: {[Op.in]: defaultStructureIds}, eventTypeId: {[Op.ne]: eventTypeId}}, transaction}
        );
    }
    await scoped.destroy({where: {eventTypeId}, transaction});
    const rowIds = mode === 'SELECTED'
        ? structureIds
        : defaultStructureIds;
    if (rowIds.length) {
        const defaults = new Set(defaultStructureIds);
        await scoped.bulkCreate(rowIds.map(structureId => ({
            eventTypeId, structureId, isDefault: defaults.has(structureId)
        })), {transaction});
    }
}

async function normalizedConfiguration(
    req: Request,
    source: any,
    fallback?: {mode: 'ALL' | 'SELECTED'; structureIds: string[]; defaultStructureIds: string[]}
): Promise<{mode: 'ALL' | 'SELECTED'; structureIds: string[]; defaultStructureIds: string[]}> {
    const tenantId = getCurrentTenantId(req);
    const mode = normalizeAvailabilityMode(source.availabilityMode, fallback?.mode ?? 'ALL');
    const structureIds = normalizeStructureIds(source.structureIds, fallback?.structureIds ?? []);
    await validateAvailability(tenantId, mode, structureIds);
    let defaultStructureIds = normalizeStructureIds(source.defaultStructureIds, fallback?.defaultStructureIds ?? []);
    const currentStructureId = req.access?.structureId;
    if (source.defaultStructureIds === undefined && Object.prototype.hasOwnProperty.call(source, 'isDefault') && currentStructureId) {
        const defaults = new Set(defaultStructureIds);
        if (source.isDefault === true || source.isDefault === 'true') defaults.add(currentStructureId);
        else defaults.delete(currentStructureId);
        defaultStructureIds = [...defaults];
    }
    await validateAvailability(tenantId, defaultStructureIds.length ? 'SELECTED' : 'ALL', defaultStructureIds);
    const effective = new Set(await effectiveStructureIds(tenantId, mode, structureIds));
    if (defaultStructureIds.some(id => !effective.has(id))) {
        throw availabilityError('Una sede predefinita non e abilitata per questo tipo appuntamento');
    }
    await validateLinkedService(tenantId, req.tenantSchema!, source.linkedServiceId, mode, structureIds);
    return {mode, structureIds, defaultStructureIds};
}

export const createEventType = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const source = req.body?.eventType ?? req.body ?? {};
    if (isReservedTimeOffTitle(source.title)) {
        return sendErrorResponse(res, 409, 'Ferie e Permesso sono tipi di assenza gestiti dalla sezione dedicata');
    }
    const config = await normalizedConfiguration(req, source);
    const eventType = await sequelize.transaction(async transaction => {
        const created = await EventType.schema(schema).create({
            ...eventTypePayload(req.body),
            availabilityMode: config.mode,
            isDefault: config.defaultStructureIds.length > 0
        } as any, {transaction});
        await syncEventMappings(
            schema, created.id, config.mode, config.structureIds, config.defaultStructureIds, transaction
        );
        return created;
    });
    const [decorated] = await decorate(req, [eventType]);
    return sendSuccessResponse(res, 201, decorated, 'Event Type created');
});

export const findAllEventType = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    let rows = await EventType.schema(schema).findAll({order: [[fn('LOWER', col('title')), 'ASC'], ['id', 'ASC']]});
    if (rows.length === 0) {
        await EventType.schema(schema).bulkCreate([
            {title: 'Prima visita', erasable: false, availabilityMode: 'ALL'},
            {title: 'Visita di controllo', erasable: false, availabilityMode: 'ALL'}
        ]);
        rows = await EventType.schema(schema).findAll();
    }
    if (req.query.view !== 'management') {
        const scope = await availabilityWhere(EventTypeStructure, schema, 'eventTypeId', req.access?.structureId);
        rows = await EventType.schema(schema).findAll({
            where: scope, order: [[fn('LOWER', col('title')), 'ASC'], ['id', 'ASC']]
        });
    }
    return sendSuccessResponse(res, 200, await decorate(req, rows), 'Events Type loaded');
});

export const findEventById = asyncHandler(async (req: Request, res: Response) => {
    const eventType = await EventType.schema(req.tenantSchema!).findByPk(req.params.eventTypeId);
    if (!eventType) return sendErrorResponse(res, 404, 'Event Type not found');
    const [decorated] = await decorate(req, [eventType]);
    return sendSuccessResponse(res, 200, decorated, 'Event Type loaded');
});

export const updateEventType = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.eventTypeId;
    const source = req.body?.eventType ?? req.body ?? {};
    if (Object.prototype.hasOwnProperty.call(source, 'title') && isReservedTimeOffTitle(source.title)) {
        return sendErrorResponse(res, 409, 'Ferie e Permesso sono tipi di assenza gestiti dalla sezione dedicata');
    }
    const current = await EventType.schema(schema).findByPk(id);
    if (!current) return sendErrorResponse(res, 404, 'Event Type not found');
    const mappings = await ownMappings(schema, id);
    const currentSelected = current.availabilityMode === 'SELECTED'
        ? mappings.map(mapping => String(mapping.structureId))
        : [];
    const currentDefaults = mappings.filter(mapping => mapping.isDefault).map(mapping => String(mapping.structureId));
    const config = await normalizedConfiguration(req, source, {
        mode: current.availabilityMode, structureIds: currentSelected, defaultStructureIds: currentDefaults
    });
    const linkedServiceId = Object.prototype.hasOwnProperty.call(source, 'linkedServiceId')
        ? source.linkedServiceId
        : current.linkedServiceId;
    await validateLinkedService(
        getCurrentTenantId(req), schema, linkedServiceId, config.mode, config.structureIds
    );

    await sequelize.transaction(async transaction => {
        await current.update({
            ...eventTypePayload(req.body),
            availabilityMode: config.mode,
            isDefault: config.defaultStructureIds.length > 0
        }, {transaction});
        await syncEventMappings(schema, id, config.mode, config.structureIds, config.defaultStructureIds, transaction);
    });
    const updated = await EventType.schema(schema).findByPk(id);
    const [decorated] = await decorate(req, updated ? [updated] : []);
    return sendSuccessResponse(res, 200, decorated, 'Event Type updated');
});

export const setDefaultEventType = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.eventTypeId;
    const structureId = req.access?.structureId;
    if (!structureId) return sendErrorResponse(res, 400, 'Seleziona una sede');
    const eventType = await EventType.schema(schema).findByPk(id);
    if (!eventType) return sendErrorResponse(res, 404, 'Event Type not found');
    if (!await itemAvailableInStructure(eventType, EventTypeStructure, schema, 'eventTypeId', structureId)) {
        return sendErrorResponse(res, 409, 'Il tipo appuntamento non e disponibile nella sede selezionata');
    }
    const isDefault = req.body?.isDefault !== false;
    await sequelize.transaction(async transaction => {
        const scoped = EventTypeStructure.schema(schema);
        if (isDefault) {
            await scoped.update({isDefault: false}, {where: {structureId, isDefault: true}, transaction});
            const [row] = await scoped.findOrCreate({where: {eventTypeId: id, structureId}, transaction});
            await row.update({isDefault: true}, {transaction});
        } else {
            await scoped.update({isDefault: false}, {where: {eventTypeId: id, structureId}, transaction});
        }
        const defaultCount = await scoped.count({where: {eventTypeId: id, isDefault: true}, transaction});
        await eventType.update({isDefault: defaultCount > 0}, {transaction});
    });
    const scope = req.query.view === 'management'
        ? {}
        : await availabilityWhere(EventTypeStructure, schema, 'eventTypeId', structureId);
    const rows = await EventType.schema(schema).findAll({where: scope});
    return sendSuccessResponse(
        res, 200, await decorate(req, rows), isDefault ? 'Default event type set' : 'Default event type removed'
    );
});

export const deleteEventType = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.eventTypeId;
    const deleted = await sequelize.transaction(async transaction => {
        await EventTypeStructure.schema(schema).destroy({where: {eventTypeId: id}, transaction});
        return EventType.schema(schema).destroy({where: {id}, transaction});
    });
    return sendSuccessResponse(res, 200, {deleted}, 'Event Type deleted');
});

export const searchEventType = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const search = textSearchWhere(['title', 'description'], req.query.query);
    const limit = boundedInteger(req.query.limit, 20, 1, 50);
    const scope = req.query.view === 'management'
        ? {}
        : await availabilityWhere(EventTypeStructure, schema, 'eventTypeId', req.access?.structureId);
    const rows = await EventType.schema(schema).findAll({
        where: {[Op.and]: [scope, ...(search ? [search] : [])]}, limit,
        order: [[fn('LOWER', col('title')), 'ASC'], ['id', 'ASC']]
    });
    return sendSuccessResponse(res, 200, await decorate(req, rows), 'Event Type searched');
});

export default {
    createEventType, findAllEventType, findEventById, updateEventType,
    setDefaultEventType, deleteEventType, searchEventType
};
