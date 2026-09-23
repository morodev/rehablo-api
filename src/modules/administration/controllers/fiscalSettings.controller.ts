import { sequelize } from '../../../config/database.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { Tenant } from '../../auth/models/index.js';
import { getStsFiscalSettings, validateStsFiscalSettings } from '../../invoice/utils/stsExpenseType.js';
import { maskStsCredentials, mergeStsCredentials } from '../services/stsCredentials.service.js';
import { env } from '../../../config/env.js';

export const getFiscalSettings = asyncHandler(async (req, res) => {
    const tenant = await Tenant.findByPk(getCurrentTenantId(req), { attributes: ['administrationSettings'] });
    if (!tenant) return sendErrorResponse(res, 404, 'Profilo aziendale non trovato');
    const data = tenant.get({ plain: true }) as Record<string, any>;
    return sendSuccessResponse(res, 200, {
        ...getStsFiscalSettings(data),
        // Codice regione dell'EROGATORE (unico per la P.IVA, non per sede). Multi-sede con
        // un'unica Partita IVA condivide questo valore.
        codiceRegione: data.administrationSettings?.fiscal?.codiceRegione ?? null,
    });
});

function normalizeCodiceRegione(value: unknown, current: string | null): string | null {
    if (value === undefined) return current;
    if (value === null || (typeof value === 'string' && !value.trim())) return null;
    if (typeof value !== 'string' || !/^\d{1,3}$/.test(value.trim())) {
        throw Object.assign(new Error('Il codice regione deve essere numerico (max 3 cifre).'), { statusCode: 400 });
    }
    return value.trim().padStart(3, '0');
}

export const updateFiscalSettings = asyncHandler(async (req, res) => {
    const result = await sequelize.transaction(async transaction => {
        const tenant = await Tenant.findByPk(getCurrentTenantId(req), { transaction, lock: transaction.LOCK.UPDATE });
        if (!tenant) return null;
        const source = req.body?.data ?? req.body ?? {};
        const data = tenant.get({ plain: true }) as Record<string, any>;
        const fiscal = validateStsFiscalSettings(source, getStsFiscalSettings(data));
        const current = (tenant.get('administrationSettings') ?? {}) as Record<string, any>;
        const codiceRegione = normalizeCodiceRegione(source.codiceRegione, current.fiscal?.codiceRegione ?? null);
        await tenant.update({ administrationSettings: { ...current, fiscal: { ...(current.fiscal ?? {}), ...fiscal, codiceRegione } } }, { transaction });
        return { ...fiscal, codiceRegione };
    });
    if (!result) return sendErrorResponse(res, 404, 'Profilo aziendale non trovato');
    return sendSuccessResponse(res, 200, result, 'Impostazioni Sistema Tessera Sanitaria aggiornate');
});

/**
 * Credenziali Sistema TS del singolo studio (per-tenant). La lettura è mascherata: espone solo la
 * presenza dei segreti, mai i valori. Aggiunge lo stato della configurazione GLOBALE di Rehablo
 * (endpoint e interruttore generale), che il frontend usa solo in sola lettura.
 */
export const getStsCredentials = asyncHandler(async (req, res) => {
    const tenant = await Tenant.findByPk(getCurrentTenantId(req), { attributes: ['administrationSettings'] });
    if (!tenant) return sendErrorResponse(res, 404, 'Profilo aziendale non trovato');
    return sendSuccessResponse(res, 200, {
        ...maskStsCredentials(tenant.get({ plain: true })),
        // Configurazione unica di Rehablo (non modificabile dal tenant), utile per l'interfaccia.
        platform: { transmissionEnabled: env.fiscal.transmissionEnabled, endpointConfigured: Boolean(env.fiscal.stsEndpoint) },
    });
});

export const updateStsCredentials = asyncHandler(async (req, res) => {
    const result = await sequelize.transaction(async transaction => {
        const tenant = await Tenant.findByPk(getCurrentTenantId(req), { transaction, lock: transaction.LOCK.UPDATE });
        if (!tenant) return null;
        const source = req.body?.data ?? req.body ?? {};
        const stsCredentials = mergeStsCredentials(tenant.get({ plain: true }), source, req.access?.userId);
        const current = (tenant.get('administrationSettings') ?? {}) as Record<string, any>;
        await tenant.update({
            administrationSettings: { ...current, fiscal: { ...(current.fiscal ?? {}), stsCredentials } }
        }, { transaction });
        return maskStsCredentials(tenant.get({ plain: true }));
    });
    if (!result) return sendErrorResponse(res, 404, 'Profilo aziendale non trovato');
    return sendSuccessResponse(res, 200, result, 'Credenziali Sistema Tessera Sanitaria aggiornate');
});
