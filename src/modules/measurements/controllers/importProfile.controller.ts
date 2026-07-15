import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import ImportProfile from '../models/catalog/importProfile.model.js';
import type { ImportProfileDefinition } from '../models/catalog/importProfile.model.js';
import { loadMetricInfo } from '../services/observation.service.js';

/** Elenco dei profili di import (mappature) disponibili. */
export const list = asyncHandler(async (_req: Request, res: Response) => {
    const profiles = await ImportProfile.findAll({ order: [['name', 'ASC']] });
    return sendSuccessResponse(res, 200, profiles, 'Profili di import');
});

/** Dettaglio di un profilo per sourceId. */
export const getOne = asyncHandler(async (req: Request, res: Response) => {
    const profile = await ImportProfile.findOne({ where: { sourceId: req.params.sourceId } });
    if (!profile) {
        return sendErrorResponse(res, 404, `Profilo "${req.params.sourceId}" non trovato`);
    }
    return sendSuccessResponse(res, 200, profile, 'Profilo di import');
});

/**
 * Salva/aggiorna una mappatura (output del mapping wizard). È il passaggio che rende il sistema un
 * PRODOTTO: qualsiasi CSV di qualsiasi device si mappa qui, come DATO, senza toccare il codice.
 * Body: { sourceId, name, definition, status?, delimiter? }.
 */
export const upsert = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenants[0].id;
    const { sourceId, name, definition, status, delimiter } = req.body as {
        sourceId?: string;
        name?: string;
        definition?: ImportProfileDefinition;
        status?: 'DRAFT' | 'PUBLISHED';
        delimiter?: string;
    };

    if (!sourceId || !name || !definition) {
        return sendErrorResponse(res, 400, 'sourceId, name e definition sono obbligatori');
    }
    if (!definition.dateColumn || !Array.isArray(definition.rules) || definition.rules.length === 0) {
        return sendErrorResponse(res, 400, 'definition deve contenere dateColumn e almeno una regola (rules)');
    }

    // Validazione: ogni metrica della mappatura deve esistere nel dizionario.
    const referenced = Array.from(
        new Set([
            ...definition.rules.map((r) => r.metricCode),
            ...(definition.derivations ?? []).map((d) => d.metricCode),
            ...(definition.derivations ?? []).map((d) => d.fromMetric)
        ])
    );
    const known = await loadMetricInfo(referenced);
    const unknown = referenced.filter((code) => !known[code]);
    if (unknown.length) {
        return sendErrorResponse(res, 400, `Metriche non presenti nel dizionario: ${unknown.join(', ')}`);
    }

    const existing = await ImportProfile.findOne({ where: { sourceId } });
    if (existing) {
        await existing.update({
            name,
            definition,
            status: status ?? existing.get('status'),
            delimiter: delimiter ?? existing.get('delimiter'),
            contributedByTenantId: tenantId
        });
        return sendSuccessResponse(res, 200, existing, 'Profilo aggiornato');
    }

    const created = await ImportProfile.create({
        sourceId,
        name,
        definition,
        status: status ?? 'DRAFT',
        delimiter: delimiter ?? ',',
        contributedByTenantId: tenantId
    });
    return sendSuccessResponse(res, 201, created, 'Profilo creato');
});

export default { list, getOne, upsert };

