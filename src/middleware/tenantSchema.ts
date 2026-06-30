import { Request, Response, NextFunction } from 'express';
import { ensureTenantSchema, getTenantSchemaName } from '../utils/tenantSchema.js';
import { getCurrentTenantId } from './auth.js';

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            tenantSchema?: string;
        }
    }
}

/**
 * Resolves (and lazily creates) the Postgres schema dedicated to the authenticated user's tenant,
 * exactly like the old `getSchema(req)` helper duplicated across every microservice, but centralised.
 * Must run after `requireAuth`.
 */
export async function resolveTenantSchema(req: Request, res: Response, next: NextFunction) {
    try {
        const tenantId = getCurrentTenantId(req);
        req.tenantSchema = await ensureTenantSchema(tenantId);
        next();
    } catch (err) {
        next(err);
    }
}

export { getTenantSchemaName };

