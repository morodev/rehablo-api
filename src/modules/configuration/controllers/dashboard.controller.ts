import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import Dashboard from '../models/dashboard.model.js';
import Widget from '../models/widget.model.js';

/**
 * Builds tenant-scoped model variants for querying. Le associazioni Dashboard <-> Widget sono
 * registrate una sola volta a boot in `../models/index.ts` (`registerConfigurationAssociations`),
 * NON qui: dichiararle ad ogni richiesta causa l'errore Sequelize "You have used the alias X in
 * two separate associations..." dalla seconda richiesta in poi (vedi invoice.controller.ts per il
 * dettaglio del perché).
 */
function getScopedModels(schema: string) {
    const DashboardScoped = Dashboard.schema(schema);
    const WidgetScoped = Widget.schema(schema);


    return { DashboardScoped, WidgetScoped };
}

export const createDashboard = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { DashboardScoped, WidgetScoped } = getScopedModels(schema);

    req.body.userId = req.user!.id;
    const widgets = req.body.widgets || [];

    const dashboard: any = await DashboardScoped.create(req.body);
    const createdWidgets = await WidgetScoped.bulkCreate(
        widgets.map((widget: any) => ({ ...widget, dashboardId: dashboard.id }))
    );

    dashboard.dataValues.widgets = createdWidgets;

    return sendSuccessResponse(res, 201, { dashboard }, 'Default patient dashboard created');
});

export const getDashboardByPatientIdAndUserId = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { DashboardScoped, WidgetScoped } = getScopedModels(schema);

    const userId = req.user!.id;
    const patientId = req.query.patientId as string;

    const dashboard = await DashboardScoped.findOne({
        where: { patientId, userId },
        include: [{ model: WidgetScoped, required: false }]
    });

    return sendSuccessResponse(res, 200, { dashboard }, 'Patient dashboard loaded');
});

export const updateDashboard = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { DashboardScoped, WidgetScoped } = getScopedModels(schema);
    const id = req.params.dashboardId;

    const [rowsUpdated] = await DashboardScoped.update(req.body, { where: { id } });
    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Impossibile aggiornare la dashboard');
    }

    const updated = await DashboardScoped.findOne({ where: { id }, include: [{ model: WidgetScoped, required: false }] });
    return sendSuccessResponse(res, 200, updated, 'Dashboard aggiornata correttamente');
});

export const deleteDashboard = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { DashboardScoped } = getScopedModels(schema);
    const id = req.params.dashboardId;

    const removedDashboard = await DashboardScoped.destroy({ where: { id } });
    return sendSuccessResponse(res, 200, { removedDashboard }, 'Dashboard eliminata correttamente');
});

export default { createDashboard, getDashboardByPatientIdAndUserId, deleteDashboard, updateDashboard };

