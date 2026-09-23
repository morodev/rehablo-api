import { sequelize } from '../../../config/database.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { Tenant } from '../../auth/models/index.js';
import { getStsFiscalSettings, validateStsFiscalSettings } from '../../invoice/utils/stsExpenseType.js';

export const getFiscalSettings = asyncHandler(async (req, res) => {
    const tenant = await Tenant.findByPk(getCurrentTenantId(req), { attributes: ['administrationSettings'] });
    if (!tenant) return sendErrorResponse(res, 404, 'Profilo aziendale non trovato');
    return sendSuccessResponse(res, 200, getStsFiscalSettings(tenant.get({ plain: true })));
});

export const updateFiscalSettings = asyncHandler(async (req, res) => {
    const result = await sequelize.transaction(async transaction => {
        const tenant = await Tenant.findByPk(getCurrentTenantId(req), { transaction, lock: transaction.LOCK.UPDATE });
        if (!tenant) return null;
        const source = req.body?.data ?? req.body ?? {};
        const fiscal = validateStsFiscalSettings(source, getStsFiscalSettings(tenant.get({ plain: true })));
        const current = (tenant.get('administrationSettings') ?? {}) as Record<string, any>;
        await tenant.update({ administrationSettings: { ...current, fiscal: { ...(current.fiscal ?? {}), ...fiscal } } }, { transaction });
        return fiscal;
    });
    if (!result) return sendErrorResponse(res, 404, 'Profilo aziendale non trovato');
    return sendSuccessResponse(res, 200, result, 'Impostazioni Sistema Tessera Sanitaria aggiornate');
});
