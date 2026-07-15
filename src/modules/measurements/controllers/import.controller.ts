import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { listDeviceSources } from '../mapping/deviceMappings.js';
import { applyMapping, inspectCsv } from '../mapping/mappingEngine.js';
import { resolveDeviceMapping } from '../mapping/mappingResolver.js';
import { ingestObservations, loadMetricInfo, type ObservationInput } from '../services/observation.service.js';

/**
 * Elenco delle sorgenti/dispositivi disponibili per l'import (alimenta il menù a tendina del frontend,
 * da cui l'operatore sceglie il `sourceId`). In futuro arriverà dal catalogo `DeviceSource`.
 */
export const sources = asyncHandler(async (_req: Request, res: Response) => {
    return sendSuccessResponse(res, 200, listDeviceSources(), 'Sorgenti con mappatura CSV');
});

/**
 * ISPEZIONE CSV (per il mapping wizard): restituisce colonne + righe di esempio, senza mappare nulla.
 * L'operatore poi trascina colonna -> metrica e salva un ImportProfile.
 * Body JSON: { csv }.
 */
export const inspect = asyncHandler(async (req: Request, res: Response) => {
    const { csv } = req.body as { csv?: string };
    if (!csv) {
        return sendErrorResponse(res, 400, 'csv è obbligatorio');
    }
    return sendSuccessResponse(res, 200, inspectCsv(csv), 'Anteprima CSV');
});

/**
 * Canale ③ IMPORT FILE (CSV).
 * Body JSON: { sourceId, patientId, csv }  (l'upload multipart con `multer` è l'upgrade di Fase 1).
 * - `sourceId`: scelto dall'operatore -> determina QUALE mappatura usare.
 * - il motore traduce il CSV nelle metriche canoniche + calcola le derivate (LSI).
 * - l'imbuto unico salva le Observation.
 */
export const importCsv = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const tenantId = req.user!.tenants[0].id;
    const operatorId = req.user!.id;
    const { sourceId, patientId, csv } = req.body as { sourceId?: string; patientId?: string; csv?: string };

    if (!sourceId || !patientId || !csv) {
        return sendErrorResponse(res, 400, 'sourceId, patientId e csv sono obbligatori');
    }

    const mapping = await resolveDeviceMapping(sourceId);
    if (!mapping) {
        return sendErrorResponse(
            res,
            404,
            `Nessuna mappatura per "${sourceId}". Crea un profilo di import (wizard) prima di importare.`
        );
    }

    // Il dizionario (unità canoniche + verso) serve al motore per conversione e prova migliore.
    const dictionary = await loadMetricInfo();
    const { measurements, warnings } = applyMapping(csv, mapping, dictionary);

    // Da misura mappata -> input canonico per l'imbuto, agganciando il paziente scelto dall'operatore.
    const inputs: ObservationInput[] = measurements.map((m) => ({
        patientId,
        metricCode: m.metricCode,
        value: m.value,
        unit: m.unit,
        side: m.side,
        effectiveDateTime: m.effectiveDateTime,
        sourceId: m.sourceId,
        aggregation: m.aggregation,
        calculationMethod: m.calculationMethod ?? null,
        provenance: m.provenance,
        metadata: { device: mapping.label, vendor: mapping.vendor }
    }));

    const result = await ingestObservations(schema, inputs, { tenantId, operatorId });

    return sendSuccessResponse(
        res,
        201,
        {
            imported: result.created.length,
            skipped: result.skipped,
            warnings,
            observations: result.created
        },
        `Import da ${mapping.label} completato`
    );
});

export default { sources, inspect, importCsv };

