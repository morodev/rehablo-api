import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendSuccessResponse } from '../../../utils/response.js';
import HumanBodyQuestionnaireInstance from '../models/humanBodyQuestionnaireInstance.model.js';
import HumanBodyAnswerInstance from '../models/humanBodyAnswerInstance.model.js';
import HumanBodyQuestionnaire from '../models/humanBodyQuestionnaire.model.js';
import HumanBodyQuestion from '../models/humanBodyQuestion.model.js';
import HumanBodyAnswer from '../models/humanBodyAnswer.model.js';

interface AnswerInstanceInput {
    questionId: string;
    answerId?: string | null;
    customAnswer?: string | null;
}

export const saveQuestionnaireInstance = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const body = req.body as { userId?: string; patientId?: string; questionnaireId: string; questions: AnswerInstanceInput[] };

    const instance = await HumanBodyQuestionnaireInstance.schema(schema).create({
        userId: body.userId,
        patientId: body.patientId,
        humanBodyQuestionnaireId: body.questionnaireId
    });

    // NOTE: the legacy controller bulk-created rows referencing `userScaleInstanceId`/`questionScaleId`/
    // `answerScaleId` (copy-pasted from the scale module), fields that don't even exist on this model.
    // Fixed here to use the correct `HumanBodyAnswerInstance` fields.
    const answersToSave = (body.questions ?? []).map((response) => ({
        humanBodyQuestionnaireInstanceId: instance.get('id') as string,
        humanBodyQuestionId: response.questionId,
        humanBodyAnswerId: response.answerId ?? null,
        customAnswer: response.customAnswer ?? null
    }));

    if (answersToSave.length > 0) {
        await HumanBodyAnswerInstance.schema(schema).bulkCreate(answersToSave);
    }

    return sendSuccessResponse(res, 201, instance, 'Questionnaire instance saved');
});

export const getQuestionnaireInstances = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;

    const instances = await HumanBodyQuestionnaireInstance.schema(schema).findAll({
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
    });

    const simplified = instances.map((instance: any) => ({
        id: instance.id,
        userId: instance.userId,
        patientId: instance.patientId,
        createdAt: instance.createdAt,
        questionnaire: {
            title: instance.humanBodyQuestionnaire?.title,
            description: instance.humanBodyQuestionnaire?.description
        },
        answers: instance.humanBodyAnswerInstances?.map((answer: any) => ({
            question: answer.humanBodyQuestion?.text,
            answer: answer.humanBodyAnswer?.text,
            customAnswer: answer.customAnswer
        }))
    }));

    return sendSuccessResponse(res, 200, simplified, 'Compiled questionnaires fetched');
});

export default {
    saveQuestionnaireInstance,
    getQuestionnaireInstances
};


