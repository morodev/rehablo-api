import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import Widget from '../models/widget.model.js';

export const addWidgetInDashboard = asyncHandler(async (req: Request, res: Response) => {
    const widget = await Widget.schema(req.tenantSchema!).create(req.body);
    return sendSuccessResponse(res, 201, widget, 'Widget added');
});

export const updateWidget = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.widgetId;

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

    const removedWidget = await Widget.schema(schema).destroy({ where: { id } });
    return sendSuccessResponse(res, 200, { removedWidget }, 'Widget eliminato correttamente');
});

export default { addWidgetInDashboard, updateWidget, deleteWidget };

