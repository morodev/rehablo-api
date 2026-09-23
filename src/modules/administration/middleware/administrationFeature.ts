import { NextFunction, Request, Response } from 'express';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { Tenant } from '../../auth/models/index.js';
import { sendErrorResponse } from '../../../utils/response.js';

export async function requireAdministrationFeature(req: Request, res: Response, next: NextFunction) {
    try {
        const tenant = await Tenant.findByPk(getCurrentTenantId(req), { attributes: ['featureFlags'] });
        const flags = (tenant?.get('featureFlags') ?? {}) as Record<string, boolean>;
        if (!flags.administration) {
            return sendErrorResponse(res, 403, 'Il modulo Amministrazione non e attivo per questo tenant');
        }
        return next();
    } catch (error) {
        return next(error);
    }
}
