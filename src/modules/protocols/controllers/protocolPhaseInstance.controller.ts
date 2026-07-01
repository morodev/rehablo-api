import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { ProtocolPhaseInstance } from '../models/index.js';
import { ProtocolPhaseTemplate } from '../models/catalog/index.js';

/** Manual update of a phase instance (e.g. adding progression notes, forcing a status). */
export const updateProtocolPhaseInstance = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.protocolPhaseInstanceId;

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

