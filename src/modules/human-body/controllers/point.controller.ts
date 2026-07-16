import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import HumanBodyPoint from '../models/humanBodyPoint.model.js';
import HumanBodyEvent from '../models/humanBodyEvent.model.js';
import { assertEvaluationEditable } from '../../evaluations/services/evaluationGuard.js';

interface HumanBodyEventInput {
    eventType: string;
}

export const createHumanBodyPoint = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    await assertEvaluationEditable(schema, req.body?.evaluationId);
    const events: HumanBodyEventInput[] = req.body.humanBodyEvents ?? [];

    const point = await HumanBodyPoint.schema(schema).create(req.body);

    if (events.length > 0) {
        await HumanBodyEvent.schema(schema).bulkCreate(
            events.map((event) => ({ humanBodyPointId: point.get('id') as string, eventType: event.eventType }))
        );
    }

    return sendSuccessResponse(res, 201, point, 'Human body point created');
});

export const getAllHumanBodyPointsWithEvents = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const userId = req.user!.id;
    const { patientId, evaluationId } = req.query as { patientId?: string; evaluationId?: string };

    // FASE E: quando è indicata una valutazione, i punti sono scoperti per `evaluationId` (una
    // valutazione è condivisa dagli operatori del centro, quindi NON si filtra più per `userId`).
    // Senza `evaluationId` (uso legacy) si mantiene il comportamento storico filtrando per operatore.
    const where: Record<string, unknown> = { patientId };
    if (evaluationId) {
        where.evaluationId = evaluationId;
    } else {
        where.userId = userId;
    }

    const points = await HumanBodyPoint.schema(schema).findAll({
        where,
        include: { model: HumanBodyEvent.schema(schema), required: false },
        raw: true
    });

    // Keep only one point per (cx, cy) coordinate pair, exactly like the legacy microservice.
    const coordinates: Record<string, Record<string, boolean>> = {};
    const uniquePoints = points.filter((item: any) => {
        const cx = item.cxCoordinate;
        const cy = item.cyCoordinate;
        if (!coordinates[cx]?.[cy]) {
            coordinates[cx] = coordinates[cx] ?? {};
            coordinates[cx][cy] = true;
            return true;
        }
        return false;
    });

    return sendSuccessResponse(res, 200, { uniquePoints, points: uniquePoints }, 'Human body points loaded');
});

export const getAllHumanBodyPoints = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const userId = req.user!.id;
    const { patientId, evaluationId } = req.query as { patientId?: string; evaluationId?: string };

    const where: Record<string, unknown> = { patientId };
    if (evaluationId) {
        where.evaluationId = evaluationId;
    } else {
        where.userId = userId;
    }

    const points = await HumanBodyPoint.schema(schema).findAll({ where });

    return sendSuccessResponse(res, 200, { points }, 'Human body points loaded');
});

export const getHumanBodyPointById = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const point = await HumanBodyPoint.schema(schema).findByPk(req.params.pointId);
    if (!point) {
        return sendErrorResponse(res, 404, 'Human body point not found');
    }
    return sendSuccessResponse(res, 200, point, 'Human body point loaded');
});

export const deleteHumanBodyPoint = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const removed = await HumanBodyPoint.schema(schema).destroy({ where: { id: req.params.pointId } });
    if (removed === 0) {
        return sendErrorResponse(res, 404, 'Human body point not found');
    }
    return sendSuccessResponse(res, 200, null, 'Human body point deleted');
});

export default {
    createHumanBodyPoint,
    getAllHumanBodyPointsWithEvents,
    getAllHumanBodyPoints,
    getHumanBodyPointById,
    deleteHumanBodyPoint
};


