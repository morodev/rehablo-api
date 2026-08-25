import { Request, Response } from 'express';
import { fn, col, where as sequelizeWhere, Op, Transaction } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { sequelize } from '../../../config/database.js';
import EventType from '../models/eventType.model.js';

/**
 * Garantisce che resti UN SOLO tipo appuntamento predefinito: azzera il flag su tutti gli altri.
 *
 * Sta lato server e dentro la transazione di chi lo chiama perché l'alternativa - lasciare al
 * client il compito di azzerare gli altri con N chiamate - produrrebbe due predefiniti (o
 * nessuno) al primo errore di rete a metà sequenza.
 */
async function clearOtherDefaults(schema: string, keepId: string | null, transaction: Transaction): Promise<void> {
    await EventType.schema(schema).update(
        { isDefault: false },
        {
            where: keepId ? { id: { [Op.ne]: keepId }, isDefault: true } : { isDefault: true },
            transaction
        }
    );
}

/** true se il payload chiede esplicitamente di rendere predefinito il tipo. */
function wantsDefault(payload: Record<string, unknown>): boolean {
    return payload?.isDefault === true || payload?.isDefault === 'true';
}

function isReservedTimeOffTitle(value: unknown): boolean {
    const title = `${value ?? ''}`.trim().toLocaleLowerCase('it');
    return title === 'ferie' || title === 'permesso';
}

export const createEventType = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;

    if (isReservedTimeOffTitle(req.body?.title)) {
        return sendErrorResponse(
            res,
            409,
            'Ferie e Permesso sono tipi di assenza gestiti dalla sezione dedicata'
        );
    }

    const eventType = await sequelize.transaction(async (transaction) => {
        const created = await EventType.schema(schema).create(req.body, { transaction });

        if (wantsDefault(req.body)) {
            await clearOtherDefaults(schema, created.get('id') as string, transaction);
        }

        return created;
    });

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
    const payload = req.body.eventType ?? req.body;

    if (Object.prototype.hasOwnProperty.call(payload, 'title') && isReservedTimeOffTitle(payload.title)) {
        return sendErrorResponse(
            res,
            409,
            'Ferie e Permesso sono tipi di assenza gestiti dalla sezione dedicata'
        );
    }

    const rowsUpdated = await sequelize.transaction(async (transaction) => {
        const [count] = await EventType.schema(schema).update(payload, { where: { id }, transaction });

        if (count > 0 && wantsDefault(payload)) {
            await clearOtherDefaults(schema, id, transaction);
        }

        return count;
    });

    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Event Type not found');
    }

    const updated = await EventType.schema(schema).findByPk(id);
    return sendSuccessResponse(res, 200, updated, 'Event Type updated');
});

/**
 * PATCH /event-type/:eventTypeId/default
 *
 * Imposta (o rimuove) il tipo proposto di default in agenda. Endpoint dedicato perché è
 * un'azione singola dalla lista: usare la PUT costringerebbe il client a rispedire l'intero
 * tipo appuntamento solo per cambiare un flag, con il rischio di sovrascrivere gli altri campi
 * con una copia ormai vecchia.
 */
export const setDefaultEventType = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.eventTypeId;
    const isDefault = req.body?.isDefault !== false;

    const eventType = await EventType.schema(schema).findByPk(id);
    if (!eventType) {
        return sendErrorResponse(res, 404, 'Event Type not found');
    }

    await sequelize.transaction(async (transaction) => {
        await EventType.schema(schema).update({ isDefault }, { where: { id }, transaction });

        if (isDefault) {
            await clearOtherDefaults(schema, id, transaction);
        }
    });

    // Si restituisce l'intero elenco: cambiare il predefinito tocca anche gli ALTRI tipi
    // (quello precedente perde il flag), quindi il client deve poter riallineare tutta la lista.
    const eventsType = await EventType.schema(schema).findAll();
    return sendSuccessResponse(res, 200, eventsType, isDefault ? 'Default event type set' : 'Default event type removed');
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

export default {
    createEventType,
    findAllEventType,
    findEventById,
    updateEventType,
    setDefaultEventType,
    deleteEventType,
    searchEventType
};

