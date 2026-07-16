import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendSuccessResponse } from '../../../utils/response.js';

import HumanBodyPoint from '../../human-body/models/humanBodyPoint.model.js';
import HumanBodyEvent from '../../human-body/models/humanBodyEvent.model.js';
import HumanBodySymptom from '../../human-body/models/humanBodySymptom.model.js';
import HumanBodyArticularity from '../../human-body/models/humanBodyArticularity.model.js';
import HumanBodyStrength from '../../human-body/models/humanBodyStrength.model.js';
import HumanBodyQuestionnaireInstance from '../../human-body/models/humanBodyQuestionnaireInstance.model.js';
import HumanBodyAnswerInstance from '../../human-body/models/humanBodyAnswerInstance.model.js';
import UserScaleInstance from '../../human-body/models/userScaleInstance.model.js';
import UserAnswer from '../../human-body/models/userAnswer.model.js';
import TestInstance from '../../human-body/models/testInstance.model.js';
import Observation from '../../measurements/models/observation.model.js';

/**
 * E4 — Pulizia dati clinici LEGACY (senza `evaluationId`). Prima della FASE E i dati clinici venivano
 * salvati per solo `patientId`, senza valutazione: sono "orfani" e mostrati mischiati tra giorni diversi.
 * Questo endpoint (SOLO super-admin) li cancella nello schema del tenant corrente, in ordine di
 * dipendenza. Idempotente: rieseguendolo non trova più nulla da cancellare.
 */
export const purgeLegacyClinicalData = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const counts: Record<string, number> = {};

    // Id dei record "padre" legacy (evaluationId IS NULL), per rimuovere prima i figli senza evaluationId.
    const legacyPointIds = (
        await HumanBodyPoint.schema(schema).findAll({ where: { evaluationId: null }, attributes: ['id'], raw: true })
    ).map((r: any) => r.id);

    const legacyQuestionnaireIds = (
        await HumanBodyQuestionnaireInstance.schema(schema).findAll({
            where: { evaluationId: null },
            attributes: ['id'],
            raw: true
        })
    ).map((r: any) => r.id);

    const legacyScaleInstanceIds = (
        await UserScaleInstance.schema(schema).findAll({ where: { evaluationId: null }, attributes: ['id'], raw: true })
    ).map((r: any) => r.id);

    // 1) Figli dei padri legacy (non hanno un proprio evaluationId).
    if (legacyPointIds.length) {
        counts.humanBodyEvents = await HumanBodyEvent.schema(schema).destroy({
            where: { humanBodyPointId: legacyPointIds }
        });
    }
    if (legacyQuestionnaireIds.length) {
        counts.humanBodyAnswerInstances = await HumanBodyAnswerInstance.schema(schema).destroy({
            where: { humanBodyQuestionnaireInstanceId: legacyQuestionnaireIds }
        });
    }
    if (legacyScaleInstanceIds.length) {
        counts.userAnswers = await UserAnswer.schema(schema).destroy({
            where: { userScaleInstanceId: legacyScaleInstanceIds }
        });
    }

    // 2) Record con evaluationId IS NULL.
    counts.humanBodySymptoms = await HumanBodySymptom.schema(schema).destroy({ where: { evaluationId: null } });
    counts.humanBodyArticularities = await HumanBodyArticularity.schema(schema).destroy({ where: { evaluationId: null } });
    counts.humanBodyStrengths = await HumanBodyStrength.schema(schema).destroy({ where: { evaluationId: null } });
    counts.humanBodyQuestionnaireInstances = await HumanBodyQuestionnaireInstance.schema(schema).destroy({
        where: { evaluationId: null }
    });
    counts.userScaleInstances = await UserScaleInstance.schema(schema).destroy({ where: { evaluationId: null } });
    counts.testInstances = await TestInstance.schema(schema).destroy({ where: { evaluationId: null } });
    counts.observations = await Observation.schema(schema).destroy({ where: { evaluationId: null } });

    // 3) I punti legacy per ultimi (dopo aver rimosso eventi e sotto-record agganciati).
    counts.humanBodyPoints = await HumanBodyPoint.schema(schema).destroy({ where: { evaluationId: null } });

    const totalDeleted = Object.values(counts).reduce((acc, n) => acc + (n || 0), 0);
    return sendSuccessResponse(res, 200, { deleted: counts, totalDeleted }, 'Pulizia dati legacy completata');
});

export default { purgeLegacyClinicalData };

