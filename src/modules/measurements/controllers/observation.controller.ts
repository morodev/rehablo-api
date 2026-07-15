import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import {
    ingestObservations,
    listObservations,
    type ObservationInput
} from '../services/observation.service.js';
import type { ObservationProvenance } from '../models/observation.model.js';

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

    const result = await ingestObservations(schema, inputs, { tenantId, operatorId });
    return sendSuccessResponse(
        res,
        201,
        { imported: result.created.length, skipped: result.skipped, observations: result.created },
        'Misure acquisite via API'
    );
});

/** Lettura delle Observation di un paziente (query: patientId, metricCode?). */
export const list = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { patientId, metricCode } = req.query as { patientId?: string; metricCode?: string };

    if (!patientId) {
        return sendErrorResponse(res, 400, 'patientId è obbligatorio');
    }

    const observations = await listObservations(schema, { patientId, metricCode });
    return sendSuccessResponse(res, 200, observations, 'Misure caricate');
});

export default { saveManual, ingestApi, list };

