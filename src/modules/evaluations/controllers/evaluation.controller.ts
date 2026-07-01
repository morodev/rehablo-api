import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import Patient from '../../patients/models/patient.model.js';
import {
    Evaluation,
    HumanBodySymptom,
    HumanBodyArticularity,
    HumanBodyStrength,
    HumanBodyQuestionnaireInstance,
    HumanBodyAnswerInstance,
    HumanBodyQuestionnaire,
    HumanBodyQuestion,
    HumanBodyAnswer,
    UserScaleInstance,
    UserAnswer,
    TestInstance,
    Scale,
    QuestionScale,
    AnswerScale,
    Test
} from '../models/index.js';

/**
 * Creates a new evaluation ("valutazione") for a patient. Symptoms, questionnaires, scales and
 * tests are added afterwards by their own endpoints, passing back this evaluation's `id` as
 * `evaluationId`.
 */
export const createEvaluation = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { patientId, date, title, notes, status, structureId } = req.body as {
        patientId?: string;
        date?: string;
        title?: string;
        notes?: string;
        status?: 'DRAFT' | 'COMPLETED';
        structureId?: string;
    };

    if (!patientId) {
        return sendErrorResponse(res, 400, 'patientId is required');
    }

    // Se la struttura non è indicata esplicitamente per questa valutazione, si ricade sulla
    // struttura di riferimento anagrafico del paziente (necessaria per instradare correttamente
    // un futuro invio al FSE regionale in base alla Regione della struttura).
    let resolvedStructureId = structureId ?? null;
    if (!resolvedStructureId) {
        const patient = await Patient.schema(schema).findByPk(patientId);
        resolvedStructureId = (patient?.get('structureId') as string | undefined) ?? null;
    }

    const evaluation = await Evaluation.schema(schema).create({
        patientId,
        userId: req.user!.id,
        structureId: resolvedStructureId,
        date: date ? new Date(date) : new Date(),
        title: title ?? null,
        notes: notes ?? null,
        status: status ?? 'COMPLETED'
    });

    return sendSuccessResponse(res, 201, evaluation, 'Valutazione creata correttamente');
});

/** Lists the evaluations of a patient (or of the whole tenant if `patientId` is omitted), most recent first. */
export const getEvaluations = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { patientId } = req.query as { patientId?: string };

    const evaluations = await Evaluation.schema(schema).findAll({
        where: patientId ? { patientId } : undefined,
        order: [['date', 'DESC']]
    });

    return sendSuccessResponse(res, 200, evaluations, 'Valutazioni caricate correttamente');
});

/** Full detail of a single evaluation: every symptom/articularity/strength/questionnaire/scale/test attached to it. */
export const getEvaluationById = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { evaluationId } = req.params;

    const evaluation = await Evaluation.schema(schema).findByPk(evaluationId, {
        include: [
            { model: HumanBodySymptom.schema(schema) },
            { model: HumanBodyArticularity.schema(schema) },
            { model: HumanBodyStrength.schema(schema) },
            {
                model: HumanBodyQuestionnaireInstance.schema(schema),
                include: [
                    { model: HumanBodyQuestionnaire.schema(schema), attributes: ['title', 'description'] },
                    {
                        model: HumanBodyAnswerInstance.schema(schema),
                        include: [
                            { model: HumanBodyQuestion.schema(schema), attributes: ['text'] },
                            { model: HumanBodyAnswer.schema(schema), attributes: ['text', 'isCorrect'] }
                        ]
                    }
                ]
            },
            {
                model: UserScaleInstance.schema(schema),
                include: [
                    { model: Scale, attributes: ['name', 'description', 'isFullBody'] },
                    {
                        model: UserAnswer.schema(schema),
                        include: [
                            { model: QuestionScale, attributes: ['description'] },
                            { model: AnswerScale, attributes: ['description', 'value'] }
                        ]
                    }
                ]
            },
            { model: TestInstance.schema(schema), include: [{ model: Test, required: false }] }
        ]
    });

    if (!evaluation) {
        return sendErrorResponse(res, 404, 'Valutazione non trovata');
    }

    return sendSuccessResponse(res, 200, evaluation, 'Valutazione caricata correttamente');
});

export const updateEvaluation = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.evaluationId;

    const [rowsUpdated] = await Evaluation.schema(schema).update(req.body, { where: { id } });
    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Valutazione non trovata');
    }

    const updated = await Evaluation.schema(schema).findByPk(id);
    return sendSuccessResponse(res, 200, updated, 'Valutazione aggiornata correttamente');
});

/** Deleting an evaluation cascades to every symptom/articularity/strength/questionnaire/scale/test attached to it. */
export const deleteEvaluation = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const removed = await Evaluation.schema(schema).destroy({ where: { id: req.params.evaluationId } });
    if (removed === 0) {
        return sendErrorResponse(res, 404, 'Valutazione non trovata');
    }
    return sendSuccessResponse(res, 200, null, 'Valutazione eliminata correttamente');
});

export default {
    createEvaluation,
    getEvaluations,
    getEvaluationById,
    updateEvaluation,
    deleteEvaluation
};

