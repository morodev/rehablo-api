import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendSuccessResponse } from '../../../utils/response.js';
import { Scale, QuestionScale, AnswerScale } from '../models/catalog/index.js';
import UserScaleInstance from '../models/userScaleInstance.model.js';
import UserAnswer from '../models/userAnswer.model.js';
import { assertEvaluationEditable } from '../../evaluations/services/evaluationGuard.js';

interface ScaleAnswerInput {
    questionId: string;
    answerId?: string | null;
    customAnswer?: string | null;
}

export const saveScale = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const body = req.body as {
        userId?: string;
        patientId?: string;
        evaluationId?: string;
        scaleId: string;
        questions: ScaleAnswerInput[];
    };

    await assertEvaluationEditable(schema, body.evaluationId);

    const newScaleInstance = await UserScaleInstance.schema(schema).create({
        userId: body.userId,
        patientId: body.patientId,
        evaluationId: body.evaluationId ?? null,
        scaleId: body.scaleId
    });

    const answersToSave = (body.questions ?? []).map((response) => ({
        userScaleInstanceId: newScaleInstance.get('id') as string,
        questionScaleId: response.questionId,
        answerScaleId: response.answerId ?? null,
        customAnswer: response.customAnswer ?? null
    }));

    if (answersToSave.length > 0) {
        await UserAnswer.schema(schema).bulkCreate(answersToSave);
    }

    return sendSuccessResponse(res, 201, newScaleInstance, 'Scale instance saved');
});

export const getUserScaleInstances = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { patientId, evaluationId } = req.query as { patientId?: string; evaluationId?: string };

    const where: Record<string, unknown> = {};
    if (patientId) where.patientId = patientId;
    if (evaluationId) where.evaluationId = evaluationId;

    const instances = await UserScaleInstance.schema(schema).findAll({
        where,
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
    });

    const simplified = instances.map((instance: any) => ({
        id: instance.id,
        userId: instance.userId,
        patientId: instance.patientId,
        createdAt: instance.createdAt,
        scale: {
            name: instance.scale?.name,
            description: instance.scale?.description,
            isFullBody: instance.scale?.isFullBody
        },
        answers: instance.userAnswers?.map((answer: any) => ({
            question: answer.questionScale?.description,
            answer: answer.answerScale?.description,
            value: answer.answerScale?.value
        }))
    }));

    return sendSuccessResponse(res, 200, simplified, 'Compiled scales fetched');
});

export default {
    saveScale,
    getUserScaleInstances
};


