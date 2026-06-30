import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import HumanBodyQuestionnaire from '../models/humanBodyQuestionnaire.model.js';
import HumanBodyQuestion from '../models/humanBodyQuestion.model.js';
import HumanBodyAnswer from '../models/humanBodyAnswer.model.js';

interface QuestionInput {
    id?: string;
    text: string;
    type: string;
    answers: { id?: string; text: string; isCorrect?: boolean }[];
}

export const saveQuestionnaire = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const body = req.body as { title: string; description?: string; questionnaires: QuestionInput[] };

    const questionnaire = await HumanBodyQuestionnaire.schema(schema).create({
        title: body.title,
        description: body.description
    });

    for (const questionData of body.questionnaires ?? []) {
        const question = await HumanBodyQuestion.schema(schema).create({
            text: questionData.text,
            type: questionData.type,
            humanBodyQuestionnaireId: questionnaire.get('id') as string
        });

        const answers = questionData.answers?.length
            ? questionData.answers
            : [{ text: '', isCorrect: false }];

        await HumanBodyAnswer.schema(schema).bulkCreate(
            answers.map((answerData) => ({
                text: answerData.text,
                isCorrect: answerData.isCorrect,
                humanBodyQuestionId: question.get('id') as string
            }))
        );
    }

    return sendSuccessResponse(res, 201, questionnaire, 'Questionnaire created');
});

export const getAllQuestionnaires = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;

    const questionnaires = await HumanBodyQuestionnaire.schema(schema).findAndCountAll({
        include: [
            {
                model: HumanBodyQuestion.schema(schema),
                required: false,
                include: [{ model: HumanBodyAnswer.schema(schema), required: false }]
            }
        ]
    });

    return sendSuccessResponse(res, 200, questionnaires, 'All questionnaires loaded');
});

export const getQuestionnaireById = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;

    const questionnaire = await HumanBodyQuestionnaire.schema(schema).findOne({
        where: { id: req.params.questionnaireId },
        include: [
            {
                model: HumanBodyQuestion.schema(schema),
                required: false,
                include: [{ model: HumanBodyAnswer.schema(schema), required: false }]
            }
        ]
    });

    if (!questionnaire) {
        return sendErrorResponse(res, 404, 'Questionnaire not found');
    }

    return sendSuccessResponse(res, 200, questionnaire, 'Questionnaire loaded successfully');
});

export const searchQuestionnaires = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const query = ((req.query.query as string) || '').toLowerCase();

    const questionnaires = await HumanBodyQuestionnaire.schema(schema).findAll({
        where: {
            [Op.or]: [
                sequelizeWhere(fn('LOWER', col('title')), 'LIKE', `%${query}%`),
                sequelizeWhere(fn('LOWER', col('description')), 'LIKE', `%${query}%`)
            ]
        },
        include: [
            {
                model: HumanBodyQuestion.schema(schema),
                required: false,
                include: [{ model: HumanBodyAnswer.schema(schema), required: false }]
            }
        ]
    });

    return sendSuccessResponse(res, 200, questionnaires, 'Search results loaded successfully');
});

export const updateQuestionnaireById = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const questionnaireId = req.params.questionnaireId;
    const updatedData = req.body.questionnaire ?? req.body;

    const questionnaire = await HumanBodyQuestionnaire.schema(schema).findByPk(questionnaireId);
    if (!questionnaire) {
        return sendErrorResponse(res, 404, 'Questionnaire not found');
    }

    await questionnaire.update({ title: updatedData.title, description: updatedData.description });

    for (const questionData of (updatedData.questionnaires ?? []) as QuestionInput[]) {
        let question;

        if (questionData.id) {
            question = await HumanBodyQuestion.schema(schema).findByPk(questionData.id);
            if (question) {
                await question.update({ text: questionData.text, type: questionData.type });
            }
        } else {
            question = await HumanBodyQuestion.schema(schema).create({
                text: questionData.text,
                type: questionData.type,
                humanBodyQuestionnaireId: questionnaire.get('id') as string
            });
        }

        for (const answerData of questionData.answers ?? []) {
            if (answerData.id) {
                const answer = await HumanBodyAnswer.schema(schema).findByPk(answerData.id);
                if (answer) {
                    await answer.update({ text: answerData.text, isCorrect: answerData.isCorrect });
                }
            } else if (question) {
                await HumanBodyAnswer.schema(schema).create({
                    text: answerData.text,
                    isCorrect: answerData.isCorrect,
                    humanBodyQuestionId: question.get('id') as string
                });
            }
        }
    }

    return sendSuccessResponse(res, 200, questionnaire, 'Questionnaire updated successfully');
});

export const deleteQuestionnaireById = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const questionnaireId = req.params.questionnaireId;

    const questionnaire = await HumanBodyQuestionnaire.schema(schema).findByPk(questionnaireId);
    if (!questionnaire) {
        return sendErrorResponse(res, 404, 'Questionnaire not found');
    }

    const questions = await HumanBodyQuestion.schema(schema).findAll({ where: { humanBodyQuestionnaireId: questionnaireId } });

    for (const question of questions) {
        await HumanBodyAnswer.schema(schema).destroy({ where: { humanBodyQuestionId: question.get('id') } });
    }

    await HumanBodyQuestion.schema(schema).destroy({ where: { humanBodyQuestionnaireId: questionnaireId } });
    await questionnaire.destroy();

    return sendSuccessResponse(res, 200, null, 'Questionnaire deleted successfully');
});

export default {
    saveQuestionnaire,
    getAllQuestionnaires,
    updateQuestionnaireById,
    deleteQuestionnaireById,
    getQuestionnaireById,
    searchQuestionnaires
};


