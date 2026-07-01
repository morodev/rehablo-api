import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere, Includeable } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import {
    ProtocolTemplate,
    ProtocolPhaseTemplate,
    ProtocolTemplateExercise,
    Exercise
} from '../models/catalog/index.js';

/**
 * CRUD on the global reusable protocol templates catalog (public schema): a template is made of
 * ordered phases, each prescribing a list of exercises with sets/reps/frequency parameters.
 */
const templateInclude: Includeable[] = [
    {
        model: ProtocolPhaseTemplate,
        include: [{ model: ProtocolTemplateExercise, include: [Exercise] }]
    }
];

interface PhaseInput {
    name: string;
    order?: number;
    durationDays?: number;
    goals?: string;
    progressionCriteria?: string;
    exercises?: {
        exerciseId: string;
        order?: number;
        sets?: number;
        reps?: number;
        durationSeconds?: number;
        frequencyPerWeek?: number;
        notes?: string;
    }[];
}

export const saveProtocolTemplate = asyncHandler(async (req: Request, res: Response) => {
    const { phases = [] as PhaseInput[], ...templateFields } = req.body;

    const template = await ProtocolTemplate.create(templateFields);

    for (const [index, phase] of phases.entries()) {
        const { exercises = [], ...phaseFields } = phase;
        const phaseTemplate = await ProtocolPhaseTemplate.create({
            ...phaseFields,
            order: phaseFields.order ?? index,
            protocolTemplateId: template.get('id') as string
        });

        await Promise.all(
            exercises.map((exercise, exerciseIndex) =>
                ProtocolTemplateExercise.create({
                    ...exercise,
                    order: exercise.order ?? exerciseIndex,
                    protocolPhaseTemplateId: phaseTemplate.get('id') as string
                })
            )
        );
    }

    const created = await ProtocolTemplate.findByPk(template.get('id') as string, { include: templateInclude });
    return sendSuccessResponse(res, 201, created, 'Protocollo creato');
});

export const findAllProtocolTemplates = asyncHandler(async (req: Request, res: Response) => {
    const templates = await ProtocolTemplate.findAll({ include: templateInclude, order: [['name', 'ASC']] });
    return sendSuccessResponse(res, 200, templates, 'Protocolli caricati correttamente');
});

export const searchProtocolTemplates = asyncHandler(async (req: Request, res: Response) => {
    const query = ((req.query.query as string) || '').toLowerCase();

    const templates = await ProtocolTemplate.findAll({
        where: {
            [Op.or]: [
                sequelizeWhere(fn('LOWER', col('name')), 'LIKE', `%${query}%`),
                sequelizeWhere(fn('LOWER', col('pathology')), 'LIKE', `%${query}%`),
                sequelizeWhere(fn('LOWER', col('description')), 'LIKE', `%${query}%`)
            ]
        },
        include: templateInclude
    });

    return sendSuccessResponse(res, 200, templates, 'Ricerca completata');
});

export const findOneProtocolTemplate = asyncHandler(async (req: Request, res: Response) => {
    const template = await ProtocolTemplate.findByPk(req.params.protocolTemplateId, { include: templateInclude });
    if (!template) {
        return sendErrorResponse(res, 404, 'Protocollo non trovato');
    }
    return sendSuccessResponse(res, 200, template, 'Protocollo caricato correttamente');
});

export const updateProtocolTemplate = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.protocolTemplateId;
    const { phases, ...templateFields } = req.body;

    const [rowsUpdated] = await ProtocolTemplate.update(templateFields, { where: { id } });
    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Impossibile aggiornare il protocollo');
    }

    const updated = await ProtocolTemplate.findByPk(id, { include: templateInclude });
    return sendSuccessResponse(res, 200, updated, 'Protocollo aggiornato correttamente');
});

export const deleteProtocolTemplate = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.protocolTemplateId;
    const removed = await ProtocolTemplate.findByPk(id);
    await ProtocolTemplate.destroy({ where: { id } });
    return sendSuccessResponse(res, 200, { removed }, 'Protocollo eliminato correttamente');
});

export default {
    saveProtocolTemplate,
    findAllProtocolTemplates,
    searchProtocolTemplates,
    findOneProtocolTemplate,
    updateProtocolTemplate,
    deleteProtocolTemplate
};



