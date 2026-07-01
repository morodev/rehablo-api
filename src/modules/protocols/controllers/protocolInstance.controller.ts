import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { ProtocolInstance, ProtocolPhaseInstance } from '../models/index.js';
import { ProtocolTemplate, ProtocolPhaseTemplate, ProtocolTemplateExercise, Exercise } from '../models/catalog/index.js';

/**
 * Assigns a `ProtocolTemplate` (public catalog) to a patient: creates the `ProtocolInstance` plus
 * one `ProtocolPhaseInstance` row per phase of the template, so the whole progression history can
 * be tracked. The first phase starts immediately (IN_PROGRESS), the rest stay PENDING.
 */
export const assignProtocol = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { protocolTemplateId, patientId, userId, startDate, notes } = req.body;

    const phaseTemplates = await ProtocolPhaseTemplate.findAll({
        where: { protocolTemplateId },
        order: [['order', 'ASC']]
    });

    if (phaseTemplates.length === 0) {
        return sendErrorResponse(res, 404, 'Protocollo non trovato o privo di fasi');
    }

    const instance = await ProtocolInstance.schema(schema).create({
        patientId,
        userId,
        protocolTemplateId,
        startDate: startDate ?? new Date(),
        notes
    });

    await Promise.all(
        phaseTemplates.map((phaseTemplate, index) =>
            ProtocolPhaseInstance.schema(schema).create({
                protocolInstanceId: instance.get('id') as string,
                protocolPhaseTemplateId: phaseTemplate.get('id') as string,
                status: index === 0 ? 'IN_PROGRESS' : 'PENDING',
                startDate: index === 0 ? startDate ?? new Date() : null
            })
        )
    );

    const created = await ProtocolInstance.schema(schema).findByPk(instance.get('id') as string, {
        include: [{ model: ProtocolTemplate, required: false }, { model: ProtocolPhaseInstance.schema(schema) }]
    });

    return sendSuccessResponse(res, 201, created, 'Protocollo assegnato al paziente');
});

export const findAllProtocolInstances = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { patientId, status } = req.query;

    const instances = await ProtocolInstance.schema(schema).findAll({
        where: {
            ...(patientId ? { patientId: patientId as string } : {}),
            ...(status ? { status: status as string } : {})
        },
        include: [{ model: ProtocolTemplate, required: false }],
        order: [['startDate', 'DESC']]
    });

    return sendSuccessResponse(res, 200, instances, 'Protocolli assegnati caricati correttamente');
});

export const findOneProtocolInstance = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;

    const instance = await ProtocolInstance.schema(schema).findByPk(req.params.protocolInstanceId, {
        include: [
            { model: ProtocolTemplate, required: false },
            {
                model: ProtocolPhaseInstance.schema(schema),
                include: [{ model: ProtocolPhaseTemplate, include: [{ model: ProtocolTemplateExercise, include: [Exercise] }] }]
            }
        ]
    });

    if (!instance) {
        return sendErrorResponse(res, 404, 'Protocollo assegnato non trovato');
    }

    return sendSuccessResponse(res, 200, instance, 'Protocollo assegnato caricato correttamente');
});

export const updateProtocolInstance = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.protocolInstanceId;

    const [rowsUpdated] = await ProtocolInstance.schema(schema).update(req.body, { where: { id } });
    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Impossibile aggiornare il protocollo assegnato');
    }

    const updated = await ProtocolInstance.schema(schema).findByPk(id);
    return sendSuccessResponse(res, 200, updated, 'Protocollo assegnato aggiornato correttamente');
});

export const deleteProtocolInstance = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const id = req.params.protocolInstanceId;

    const removed = await ProtocolInstance.schema(schema).findByPk(id);
    await ProtocolInstance.schema(schema).destroy({ where: { id } });

    return sendSuccessResponse(res, 200, { removed }, 'Protocollo assegnato eliminato correttamente');
});

export default {
    assignProtocol,
    findAllProtocolInstances,
    findOneProtocolInstance,
    updateProtocolInstance,
    deleteProtocolInstance
};

