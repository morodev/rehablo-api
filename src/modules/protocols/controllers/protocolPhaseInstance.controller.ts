import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { patientScopeWhere } from '../../../middleware/rbac.js';
import { ProtocolInstance, ProtocolPhaseInstance } from '../models/index.js';
import { ProtocolPhaseTemplate } from '../models/catalog/index.js';

/**
 * Le fasi non hanno un legame diretto con il paziente: l'unico riferimento è
 * `protocolInstanceId`. La verifica di accesso passa quindi dal protocollo padre,
 * che eredita l'ampiezza dai pazienti visibili.
 */
async function canAccessPhase(req: Request, phaseInstanceId: string): Promise<boolean> {
    const schema = req.tenantSchema!;

    const phase = await ProtocolPhaseInstance.schema(schema).findByPk(phaseInstanceId);
    if (!phase) return false;

    const parent = await ProtocolInstance.schema(schema).findOne({
        where: {
            id: phase.get('protocolInstanceId') as string,
            ...patientScopeWhere(req, schema)
        }
    });

    return !!parent;
}

/** Manual update of a phase instance (e.g. adding progression notes, forcing a status). */
export const updateProtocolPhaseInstance = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.protocolPhaseInstanceId;

    if (!(await canAccessPhase(req, id))) {
        return sendErrorResponse(res, 404, 'Impossibile aggiornare la fase del protocollo');
    }

    const [rowsUpdated] = await ProtocolPhaseInstance.schema(schema).update(req.body, { where: { id } });
    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Impossibile aggiornare la fase del protocollo');
    }

    const updated = await ProtocolPhaseInstance.schema(schema).findByPk(id);
    return sendSuccessResponse(res, 200, updated, 'Fase del protocollo aggiornata correttamente');
});

/**
 * Marks the current phase as COMPLETED and starts the next one (by `order`), i.e. the "progression"
 * action the therapist performs once the patient meets the phase's `progressionCriteria`.
 */
export const advanceProtocolPhase = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.protocolPhaseInstanceId;

    if (!(await canAccessPhase(req, id))) {
        return sendErrorResponse(res, 404, 'Fase del protocollo non trovata');
    }

    const currentPhase = await ProtocolPhaseInstance.schema(schema).findByPk(id, {
        include: [{ model: ProtocolPhaseTemplate }]
    });

    if (!currentPhase) {
        return sendErrorResponse(res, 404, 'Fase del protocollo non trovata');
    }

    await currentPhase.update({ status: 'COMPLETED', endDate: new Date(), progressionNotes: req.body.progressionNotes });

    const currentTemplate = (currentPhase as any).protocolPhaseTemplate;

    const nextPhase = await ProtocolPhaseInstance.schema(schema).findOne({
        where: { protocolInstanceId: currentPhase.get('protocolInstanceId') as string, status: 'PENDING' },
        include: [{ model: ProtocolPhaseTemplate, where: { order: (currentTemplate?.order ?? 0) + 1 } }]
    });

    if (nextPhase) {
        await nextPhase.update({ status: 'IN_PROGRESS', startDate: new Date() });
    }

    return sendSuccessResponse(res, 200, { completedPhase: currentPhase, nextPhase }, 'Fase completata');
});

export default {
    updateProtocolPhaseInstance,
    advanceProtocolPhase
};

