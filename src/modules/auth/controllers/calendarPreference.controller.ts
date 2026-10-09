import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { getSelectedStructureId, getUserId } from '../../../middleware/rbac.js';
import { sequelize } from '../../../config/database.js';
import { Op } from 'sequelize';
import CalendarPreference from '../models/calendarPreference.model.js';
import Structure from '../models/structure.model.js';
import StructureUser from '../models/structureUser.model.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requestedCalendarIds(body: Record<string, any>): string[] | null {
    const values = body.calendarIds !== undefined ? body.calendarIds : [body.calendarId];
    if (!Array.isArray(values) || values.length === 0 || values.some(value => typeof value !== 'string' || !UUID_PATTERN.test(value))) {
        return null;
    }
    return [...new Set(values)];
}

async function context(req: Request): Promise<{ viewerUserId: string; structureId: string } | null> {
    const structureId = getSelectedStructureId(req);
    const viewerUserId = getUserId(req);
    if (!structureId) return null;
    const [structure, membership] = await Promise.all([
        Structure.findOne({ where: { id: structureId, tenantId: getCurrentTenantId(req) }, attributes: ['id'] }),
        StructureUser.findOne({ where: { structureId, userId: viewerUserId } })
    ]);
    return structure && membership ? { viewerUserId, structureId } : null;
}
export const getCalendarPreferences = asyncHandler(async (req: Request, res: Response) => {
    const selected = await context(req);
    if (!selected) return sendErrorResponse(res, 400, 'Seleziona una sede accessibile');
    const rows = await CalendarPreference.findAll({ where: selected, attributes: ['calendarId'] });
    return sendSuccessResponse(res, 200, { hiddenCalendarIds: rows.map(row => row.calendarId) }, 'Preferenze agenda');
});
export const updateCalendarPreferences = asyncHandler(async (req: Request, res: Response) => {
    const selected = await context(req);
    if (!selected) return sendErrorResponse(res, 400, 'Seleziona una sede accessibile');
    const { visible } = req.body ?? {};
    const calendarIds = requestedCalendarIds(req.body ?? {});
    if (!calendarIds || typeof visible !== 'boolean') {
        return sendErrorResponse(res, 400, 'Preferenza agenda non valida');
    }

    const targets = await StructureUser.findAll({
        where: {userId: {[Op.in]: calendarIds}, structureId: selected.structureId},
        attributes: ['userId']
    });
    const targetIds = new Set(targets.map(target => target.get('userId') as string));
    if (calendarIds.some(calendarId => !targetIds.has(calendarId))) {
        return sendErrorResponse(res, 404, 'Una o più agende non sono presenti nella sede selezionata');
    }

    await sequelize.transaction(async transaction => {
        const where = {...selected, calendarId: {[Op.in]: calendarIds}};
        if (visible) {
            await CalendarPreference.destroy({where, transaction});
        } else {
            await CalendarPreference.bulkCreate(
                calendarIds.map(calendarId => ({...selected, calendarId})),
                {transaction, ignoreDuplicates: true}
            );
        }
    });

    const rows = await CalendarPreference.findAll({ where: selected, attributes: ['calendarId'] });
    return sendSuccessResponse(res, 200, { hiddenCalendarIds: rows.map(row => row.calendarId) }, 'Preferenze agenda aggiornate');
});
