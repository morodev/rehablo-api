import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { Exercise } from '../models/catalog/index.js';

/** CRUD on the global reusable exercises catalog (public schema, shared by every tenant). */
export const saveExercise = asyncHandler(async (req: Request, res: Response) => {
    const exercise = await Exercise.create(req.body);
    return sendSuccessResponse(res, 201, exercise, 'Esercizio creato');
});

export const findAllExercises = asyncHandler(async (req: Request, res: Response) => {
    const { category } = req.query;
    const exercises = await Exercise.findAll({
        where: category ? { category: category as string } : undefined,
        order: [['name', 'ASC']]
    });
    return sendSuccessResponse(res, 200, exercises, 'Esercizi caricati correttamente');
});

export const searchExercises = asyncHandler(async (req: Request, res: Response) => {
    const query = ((req.query.query as string) || '').toLowerCase();

    const exercises = await Exercise.findAll({
        where: {
            [Op.or]: [
                sequelizeWhere(fn('LOWER', col('name')), 'LIKE', `%${query}%`),
                sequelizeWhere(fn('LOWER', col('description')), 'LIKE', `%${query}%`)
            ]
        }
    });

    return sendSuccessResponse(res, 200, exercises, 'Ricerca completata');
});

export const findOneExercise = asyncHandler(async (req: Request, res: Response) => {
    const exercise = await Exercise.findByPk(req.params.exerciseId);
    if (!exercise) {
        return sendErrorResponse(res, 404, 'Esercizio non trovato');
    }
    return sendSuccessResponse(res, 200, exercise, 'Esercizio caricato correttamente');
});

export const updateExercise = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.exerciseId;
    const [rowsUpdated] = await Exercise.update(req.body, { where: { id } });
    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Impossibile aggiornare l\'esercizio');
    }
    const updated = await Exercise.findByPk(id);
    return sendSuccessResponse(res, 200, updated, 'Esercizio aggiornato correttamente');
});

export const deleteExercise = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.exerciseId;
    const removed = await Exercise.findByPk(id);
    await Exercise.destroy({ where: { id } });
    return sendSuccessResponse(res, 200, { removed }, 'Esercizio eliminato correttamente');
});

export default {
    saveExercise,
    findAllExercises,
    searchExercises,
    findOneExercise,
    updateExercise,
    deleteExercise
};

