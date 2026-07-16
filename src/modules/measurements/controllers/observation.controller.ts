import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import {
    ingestObservations,
    listObservations,
    type ObservationInput
} from '../services/observation.service.js';
import type { ObservationProvenance } from '../models/observation.model.js';
import { assertEvaluationEditable } from '../../evaluations/services/evaluationGuard.js';

function readContext(req: Request) {
    return {
        schema: req.tenantSchema!,
        tenantId: req.user!.tenants[0].id,
        operatorId: req.user!.id
    };
}

/** Normalizza il body in un array di ObservationInput, forzando la provenienza del canale. */
function collectInputs(body: any, provenance: ObservationProvenance): ObservationInput[] {
    const raw = Array.isArray(body?.observations) ? body.observations : Array.isArray(body) ? body : [body];
    return raw.map((o: any) => ({ ...o, provenance }));
}

/** Guardia immutabilità (FASE E): rifiuta la scrittura su valutazioni chiuse referenziate dagli input. */
async function assertInputsEditable(schema: string, inputs: ObservationInput[]): Promise<void> {
    const evaluationIds = Array.from(new Set(inputs.map((i) => i.evaluationId).filter(Boolean)));
    for (const evaluationId of evaluationIds) {
        await assertEvaluationEditable(schema, evaluationId as string);
    }
}

/**
 * Canale ④ MANUALE: l'operatore inserisce una o più misure già canoniche.
 * Body: una Observation o { observations: [...] } con { patientId, metricCode, value, side?, ... }.
 */
export const saveManual = asyncHandler(async (req: Request, res: Response) => {
    const { schema, tenantId, operatorId } = readContext(req);
    const inputs = collectInputs(req.body, 'MANUAL');

    if (!inputs.length || !inputs[0]?.patientId) {
        return sendErrorResponse(res, 400, 'patientId e almeno una misura sono obbligatori');
    }

    await assertInputsEditable(schema, inputs);

    const result = await ingestObservations(schema, inputs, { tenantId, operatorId });
    return sendSuccessResponse(
        res,
        201,
        { imported: result.created.length, skipped: result.skipped, observations: result.created },
        'Misure inserite'
    );
});

/**
 * Canale ① INGESTION API (inbound): un partner/app invia misure GIÀ canoniche.
 * Stesso imbuto del manuale, ma provenienza DEVICE_API. (Autenticazione API key: TODO Fase 1.)
 */
export const ingestApi = asyncHandler(async (req: Request, res: Response) => {
    const { schema, tenantId, operatorId } = readContext(req);
    const inputs = collectInputs(req.body, 'DEVICE_API');

    if (!inputs.length || !inputs[0]?.patientId) {
        return sendErrorResponse(res, 400, 'patientId e almeno una misura sono obbligatori');
    }

    await assertInputsEditable(schema, inputs);

    const result = await ingestObservations(schema, inputs, { tenantId, operatorId });
    return sendSuccessResponse(
        res,
        201,
        { imported: result.created.length, skipped: result.skipped, observations: result.created },
        'Misure acquisite via API'
    );
});

/** Lettura delle Observation, filtrabili per patientId, metricCode, humanBodyPointId, evaluationId. */
export const list = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { patientId, metricCode, humanBodyPointId, evaluationId } = req.query as {
        patientId?: string;
        metricCode?: string;
        humanBodyPointId?: string;
        evaluationId?: string;
    };

    // Serve almeno un filtro di scoping (un paziente, un punto o una valutazione) per non restituire
    // l'intera tabella. Il drawer del punto (FASE E) chiama con `humanBodyPointId`.
    if (!patientId && !humanBodyPointId && !evaluationId) {
        return sendErrorResponse(res, 400, 'Almeno uno tra patientId, humanBodyPointId o evaluationId è obbligatorio');
    }

    const observations = await listObservations(schema, { patientId, metricCode, humanBodyPointId, evaluationId });
    return sendSuccessResponse(res, 200, observations, 'Misure caricate');
});

export default { saveManual, ingestApi, list };

