import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { getUserId } from '../../../middleware/rbac.js';
import Dashboard from '../models/dashboard.model.js';
import Widget from '../models/widget.model.js';

/**
 * I widget vivono dentro una dashboard, che è una configurazione PERSONALE.
 * Si può quindi agire solo sui widget delle proprie dashboard, a prescindere dallo
 * scope del ruolo: `dashboardId` è l'unico legame del widget, perciò la verifica
 * di proprietà passa sempre dal padre.
 */
async function ownsDashboard(req: Request, dashboardId: string | null | undefined): Promise<boolean> {
    if (!dashboardId) return false;
    const dashboard = await Dashboard.schema(req.tenantSchema!).findOne({
        where: { id: dashboardId, userId: getUserId(req) }
    });
    return !!dashboard;
}

/** Risolve la dashboard di un widget e ne verifica la proprietà. */
async function ownsWidget(req: Request, widgetId: string): Promise<boolean> {
    const widget = await Widget.schema(req.tenantSchema!).findByPk(widgetId);
    if (!widget) return false;
    return ownsDashboard(req, widget.get('dashboardId') as string);
}

export const addWidgetInDashboard = asyncHandler(async (req: Request, res: Response) => {
    if (!(await ownsDashboard(req, req.body?.dashboardId))) {
        return sendErrorResponse(res, 404, 'Dashboard non trovata');
    }

    const widget = await Widget.schema(req.tenantSchema!).create(req.body);
    return sendSuccessResponse(res, 201, widget, 'Widget added');
});

export const updateWidget = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.widgetId;

    if (!(await ownsWidget(req, id))) {
        return sendErrorResponse(res, 404, 'Impossibile aggiornare il widget');
    }

    const [rowsUpdated] = await Widget.schema(schema).update(req.body, { where: { id } });
    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Impossibile aggiornare il widget');
    }

    const updated = await Widget.schema(schema).findByPk(id);
    return sendSuccessResponse(res, 200, updated, 'Widget aggiornato correttamente');
});

export const deleteWidget = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.widgetId;

    if (!(await ownsWidget(req, id))) {
        return sendErrorResponse(res, 404, 'Widget non trovato');
    }

    const removedWidget = await Widget.schema(schema).destroy({ where: { id } });
    return sendSuccessResponse(res, 200, { removedWidget }, 'Widget eliminato correttamente');
});

export default { addWidgetInDashboard, updateWidget, deleteWidget };

