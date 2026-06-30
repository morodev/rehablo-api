import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import Patient from '../models/patient.model.js';

function getPagination(page?: string, size?: string) {
    const limit = size ? +size : 10;
    const offset = page ? +page * limit : 0;
    return { limit, offset };
}

function getPagingData(data: { count: number; rows: unknown[] }, page?: string, limit?: number) {
    const { count: totalItems, rows: contents } = data;
    const currentPage = page ? +page : 0;
    const totalPages = Math.ceil(totalItems / (limit || 10));
    return { totalItems, contents, totalPages, currentPage };
}

export const savePatient = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    req.body.tenantId = req.user!.tenants[0].id;
    req.body.userId = req.user!.id;

    const patient = await Patient.schema(schema).create(req.body);
    return sendSuccessResponse(res, 201, patient, 'Paziente creato correttamente');
});

export const findAndCountAll = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { page, size } = req.query as { page?: string; size?: string };
    const { limit, offset } = getPagination(page, size);

    const data = await Patient.schema(schema).findAndCountAll({
        limit,
        offset,
        order: [[fn('lower', col('name')), 'ASC']]
    });

    return sendSuccessResponse(res, 200, getPagingData(data, page, limit), 'Pazienti caricati correttamente');
});

export const findAll = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const patients = await Patient.schema(schema).findAll();
    return sendSuccessResponse(res, 200, patients, 'Pazienti caricati correttamente');
});

export const findOne = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const patient = await Patient.schema(schema).findByPk(req.params.patientId);
    if (!patient) {
        return sendErrorResponse(res, 404, 'Paziente non trovato');
    }
    return sendSuccessResponse(res, 200, patient, 'Paziente caricato correttamente');
});

export const searchPatients = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const query = ((req.query.query as string) || '').toLowerCase();
    const words = query.split(' ').filter(Boolean);

    const patients = await Patient.schema(schema).findAll({
        where: {
            [Op.or]: [
                sequelizeWhere(fn('LOWER', col('name')), 'LIKE', `%${query}%`),
                sequelizeWhere(fn('LOWER', col('surname')), 'LIKE', `%${query}%`),
                {
                    [Op.and]: words.map((word) => ({
                        [Op.or]: [
                            sequelizeWhere(fn('LOWER', col('name')), 'LIKE', `%${word}%`),
                            sequelizeWhere(fn('LOWER', col('surname')), 'LIKE', `%${word}%`)
                        ]
                    }))
                }
            ]
        },
        order: [[fn('lower', col('name')), 'ASC']]
    });

    return sendSuccessResponse(res, 200, patients, 'Ricerca completata');
});

export const update = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.patientId;

    const [rowsUpdated] = await Patient.schema(schema).update(req.body.contact ?? req.body, { where: { id } });
    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Paziente non trovato');
    }

    const updatedPatient = await Patient.schema(schema).findByPk(id);
    return sendSuccessResponse(res, 200, updatedPatient, 'Paziente aggiornato correttamente');
});

export const deletePatient = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.patientId;

    const removedPatient = await Patient.schema(schema).findByPk(id);
    await Patient.schema(schema).destroy({ where: { id } });

    return sendSuccessResponse(res, 200, removedPatient, 'Paziente eliminato correttamente');
});

export default { savePatient, findAndCountAll, findAll, findOne, searchPatients, update, deletePatient };

