import { NextFunction, Request, Response } from 'express';
import { Op } from 'sequelize';
import { PatientPortalAccess } from '../../auth/models/index.js';
import { sendErrorResponse } from '../../../utils/response.js';

declare global {
    namespace Express {
        interface Request {
            patientPortalAccess?: PatientPortalAccess;
        }
    }
}
/** Verifica il collegamento esatto a ogni richiesta, così la revoca è immediata. */
export async function requirePatientPortalAccess(req: Request, res: Response, next: NextFunction) {
    if (req.user?.actor !== 'patient') {
        return sendErrorResponse(res, 403, 'Contesto paziente richiesto');
    }

    const userId = (req.user.sub as string | undefined) ?? req.user.id;
    const tenantId = req.user.tid as string | undefined;
    const patientId = req.user.pid as string | undefined;
    const accessId = req.user.patientAccessId as string | undefined;
    if (!userId || !tenantId || !patientId || !accessId) {
        return sendErrorResponse(res, 403, 'Contesto paziente incompleto');
    }

    const access = await PatientPortalAccess.findOne({
        where: {
            id: accessId,
            userId,
            tenantId,
            patientId,
            status: { [Op.in]: ['ACTIVE', 'HISTORICAL'] }
        }
    });
    if (!access) return sendErrorResponse(res, 403, 'Accesso al centro revocato');

    req.patientPortalAccess = access;
    access.update({ lastAccessAt: new Date() }).catch(() => undefined);
    return next();
}
