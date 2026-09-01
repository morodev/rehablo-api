import { Request, Response } from 'express';
import { Op, Transaction } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { scopeWhere } from '../../../middleware/rbac.js';
import { sequelize } from '../../../config/database.js';
import { Structure, StructureUser, TenantUser, User } from '../../auth/models/index.js';
import TimeOffRequest, {
    TIME_OFF_STATUSES,
    TIME_OFF_TYPES,
    TimeOffStatus,
    TimeOffType
} from '../models/timeOffRequest.model.js';
import TimeOffStatusHistory from '../models/timeOffStatusHistory.model.js';

const TIME_OFF_SCOPE_FIELDS = {
    ownerField: 'userId',
    structureField: 'structureId',
    // I soli record migrati possono non avere una sede certa; restano visibili finché
    // una successiva bonifica non li assegna esplicitamente.
    includeUnassigned: false
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bodyOf(req: Request): Record<string, any> {
    return req.body?.timeOffRequest ?? req.body ?? {};
}

function parseDate(value: unknown): Date | null {
    if (!value) return null;
    const date = new Date(value as string | number | Date);
    return Number.isNaN(date.getTime()) ? null : date;
}

function cleanText(value: unknown): string | null {
    const text = `${value ?? ''}`.trim();
    return text || null;
}

function isTimeOffType(value: unknown): value is TimeOffType {
    return TIME_OFF_TYPES.includes(value as TimeOffType);
}

function isTimeOffStatus(value: unknown): value is TimeOffStatus {
    return TIME_OFF_STATUSES.includes(value as TimeOffStatus);
}

function actorUserId(req: Request): string {
    return req.access?.userId ?? (req.user!.sub as string) ?? (req.user!.id as string);
}

function resolveStructureId(req: Request, requested: unknown): string | null {
    if (req.access?.scope === 'tenant') {
        return (requested as string | undefined) ?? req.access.structureId ?? null;
    }
    return req.access?.structureId ?? null;
}

function resolveTargetUserId(req: Request, requested: unknown): string {
    if (req.access?.scope === 'own') {
        return actorUserId(req);
    }
    return (requested as string | undefined) ?? actorUserId(req);
}

function canCreateApproved(req: Request): boolean {
    return req.access?.scope === 'structure' || req.access?.scope === 'tenant';
}

async function validateTarget(req: Request, structureId: string, userId: string): Promise<boolean> {
    if (!UUID_REGEX.test(structureId) || !UUID_REGEX.test(userId)) {
        return false;
    }

    const tenantId = getCurrentTenantId(req);
    const [structure, tenantMembership, identity, structureMembership] = await Promise.all([
        Structure.findOne({ where: { id: structureId, tenantId } }),
        TenantUser.findOne({ where: { tenantId, userId, deactivatedAt: { [Op.is]: null } } }),
        User.findOne({ where: { id: userId, deactivatedAt: { [Op.is]: null } }, attributes: ['id'] }),
        StructureUser.findOne({ where: { structureId, userId } })
    ]);

    return !!structure && !!tenantMembership && !!identity && !!structureMembership;
}

function parsePeriod(startValue: unknown, endValue: unknown): { start: Date; end: Date } | null {
    const start = parseDate(startValue);
    const end = parseDate(endValue);
    if (!start || !end || end.getTime() <= start.getTime()) {
        return null;
    }
    return { start, end };
}

async function appendHistory(
    schema: string,
    transaction: Transaction,
    requestId: string,
    fromStatus: TimeOffStatus | null,
    toStatus: TimeOffStatus,
    actorId: string,
    note: string | null
): Promise<void> {
    await TimeOffStatusHistory.schema(schema).create(
        {
            timeOffRequestId: requestId,
            fromStatus,
            toStatus,
            actorUserId: actorId,
            note
        },
        { transaction }
    );
}

async function findScoped(req: Request, id: string): Promise<TimeOffRequest | null> {
    if (!UUID_REGEX.test(id)) return null;
    return TimeOffRequest.schema(req.tenantSchema!).findOne({
        where: { id, ...scopeWhere(req, TIME_OFF_SCOPE_FIELDS) }
    });
}

async function findActiveOverlap(
    schema: string,
    userId: string,
    period: { start: Date; end: Date },
    excludeId?: string
): Promise<TimeOffRequest | null> {
    return TimeOffRequest.schema(schema).findOne({
        where: {
            userId,
            status: { [Op.in]: ['PENDING', 'APPROVED'] },
            start: { [Op.lt]: period.end },
            end: { [Op.gt]: period.start },
            ...(excludeId ? { id: { [Op.ne]: excludeId } } : {})
        }
    });
}

export const getTimeOffRequests = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { start, end, userId, status, type } = req.query as Record<string, string | undefined>;
    const where: Record<string | symbol, unknown> = {
        ...scopeWhere(req, TIME_OFF_SCOPE_FIELDS)
    };

    if (userId) {
        if (!UUID_REGEX.test(userId)) {
            return sendErrorResponse(res, 400, 'Filtro operatore non valido');
        }
        where.userId = userId;
    }
    if (type) {
        if (!isTimeOffType(type)) {
            return sendErrorResponse(res, 400, 'Filtro tipo assenza non valido');
        }
        where.type = type;
    }

    if (status) {
        const requestedStatuses = status.split(',').filter(Boolean);
        const statuses = requestedStatuses.filter(isTimeOffStatus);
        if (statuses.length !== requestedStatuses.length) {
            return sendErrorResponse(res, 400, 'Filtro stato assenza non valido');
        }
        if (statuses.length === 1) where.status = statuses[0];
        if (statuses.length > 1) where.status = { [Op.in]: statuses };
    }

    const fromDate = parseDate(start);
    const toDate = parseDate(end);
    if ((start && !fromDate) || (end && !toDate) || (fromDate && toDate && toDate <= fromDate)) {
        return sendErrorResponse(res, 400, 'Intervallo di ricerca non valido');
    }
    const overlap: Record<string, unknown>[] = [];
    if (fromDate) overlap.push({ end: { [Op.gt]: fromDate } });
    if (toDate) overlap.push({ start: { [Op.lt]: toDate } });
    if (overlap.length > 0) where[Op.and] = overlap;

    const requests = await TimeOffRequest.schema(schema).findAll({
        where,
        order: [
            ['start', 'ASC'],
            ['createdAt', 'ASC']
        ],
        limit: 1000
    });

    return sendSuccessResponse(res, 200, requests, 'Richieste di assenza caricate');
});

export const getTimeOffRequestById = asyncHandler(async (req: Request, res: Response) => {
    const request = await findScoped(req, req.params.timeOffRequestId);
    if (!request) {
        return sendErrorResponse(res, 404, 'Richiesta di assenza non trovata');
    }
    return sendSuccessResponse(res, 200, request, 'Richiesta di assenza caricata');
});

export const getTimeOffRequestHistory = asyncHandler(async (req: Request, res: Response) => {
    const request = await findScoped(req, req.params.timeOffRequestId);
    if (!request) {
        return sendErrorResponse(res, 404, 'Richiesta di assenza non trovata');
    }

    const history = await TimeOffStatusHistory.schema(req.tenantSchema!).findAll({
        where: { timeOffRequestId: request.id },
        order: [['createdAt', 'ASC']]
    });

    return sendSuccessResponse(res, 200, history, 'Storico della richiesta caricato');
});

export const createTimeOffRequest = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const body = bodyOf(req);
    const actorId = actorUserId(req);
    const structureId = resolveStructureId(req, body.structureId);
    const userId = resolveTargetUserId(req, body.userId);
    const period = parsePeriod(body.start, body.end);

    if (!structureId) {
        return sendErrorResponse(res, 400, 'Seleziona una struttura prima di creare la richiesta');
    }
    if (!(await validateTarget(req, structureId, userId))) {
        return sendErrorResponse(res, 400, 'Operatore o struttura non validi');
    }
    if (!isTimeOffType(body.type)) {
        return sendErrorResponse(res, 400, 'Tipo di assenza non valido');
    }
    if (!period) {
        return sendErrorResponse(res, 400, 'Intervallo temporale non valido');
    }
    if (await findActiveOverlap(schema, userId, period)) {
        return sendErrorResponse(
            res,
            409,
            'Esiste già una richiesta pendente o approvata nello stesso intervallo'
        );
    }

    const status: TimeOffStatus = body.status === 'APPROVED' && canCreateApproved(req)
        ? 'APPROVED'
        : 'PENDING';
    const note = cleanText(body.reviewNote);
    const reviewed = status === 'APPROVED';

    const created = await sequelize.transaction(async (transaction) => {
        const request = await TimeOffRequest.schema(schema).create(
            {
                structureId,
                userId,
                type: body.type,
                status,
                start: period.start,
                end: period.end,
                allDay: !!body.allDay,
                reason: cleanText(body.reason),
                requestedByUserId: actorId,
                reviewedByUserId: reviewed ? actorId : null,
                reviewedAt: reviewed ? new Date() : null,
                reviewNote: reviewed ? note : null
            },
            { transaction }
        );

        await appendHistory(schema, transaction, request.id, null, status, actorId, note);
        return request;
    });

    return sendSuccessResponse(res, 201, created, 'Richiesta di assenza creata');
});

export const updateTimeOffRequest = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const body = bodyOf(req);
    const current = await findScoped(req, req.params.timeOffRequestId);

    if (!current) {
        return sendErrorResponse(res, 404, 'Richiesta di assenza non trovata');
    }
    if (current.status === 'CANCELLED' || current.status === 'REVOKED') {
        return sendErrorResponse(res, 409, 'Una richiesta chiusa non può essere modificata');
    }

    const hasType = Object.prototype.hasOwnProperty.call(body, 'type');
    const hasStart = Object.prototype.hasOwnProperty.call(body, 'start');
    const hasEnd = Object.prototype.hasOwnProperty.call(body, 'end');
    const hasAllDay = Object.prototype.hasOwnProperty.call(body, 'allDay');
    const hasReason = Object.prototype.hasOwnProperty.call(body, 'reason');

    if (!hasType && !hasStart && !hasEnd && !hasAllDay && !hasReason) {
        return sendErrorResponse(res, 400, 'Nessun campo modificabile specificato');
    }

    const type = hasType ? body.type : current.type;
    if (!isTimeOffType(type)) {
        return sendErrorResponse(res, 400, 'Tipo di assenza non valido');
    }

    const period = parsePeriod(hasStart ? body.start : current.start, hasEnd ? body.end : current.end);
    if (!period) {
        return sendErrorResponse(res, 400, 'Intervallo temporale non valido');
    }
    if (await findActiveOverlap(schema, current.userId, period, current.id)) {
        return sendErrorResponse(
            res,
            409,
            'Esiste già una richiesta pendente o approvata nello stesso intervallo'
        );
    }

    const previousStatus = current.status;
    const nextStatus: TimeOffStatus = previousStatus === 'APPROVED' || previousStatus === 'REJECTED'
        ? 'PENDING'
        : previousStatus;
    const actorId = actorUserId(req);

    await sequelize.transaction(async (transaction) => {
        await current.update(
            {
                type,
                start: period.start,
                end: period.end,
                allDay: hasAllDay ? !!body.allDay : current.allDay,
                reason: hasReason ? cleanText(body.reason) : current.reason,
                status: nextStatus,
                reviewedByUserId: nextStatus === 'PENDING' ? null : current.reviewedByUserId,
                reviewedAt: nextStatus === 'PENDING' ? null : current.reviewedAt,
                reviewNote: nextStatus === 'PENDING' ? null : current.reviewNote
            },
            { transaction }
        );

        if (nextStatus !== previousStatus) {
            await appendHistory(
                schema,
                transaction,
                current.id,
                previousStatus,
                nextStatus,
                actorId,
                'Richiesta modificata e reinviata in approvazione'
            );
        }
    });

    return sendSuccessResponse(res, 200, current, 'Richiesta di assenza aggiornata');
});

async function transition(
    req: Request,
    res: Response,
    allowedFrom: TimeOffStatus[],
    toStatus: TimeOffStatus,
    message: string
) {
    const schema = req.tenantSchema!;
    const current = await findScoped(req, req.params.timeOffRequestId);
    if (!current) {
        return sendErrorResponse(res, 404, 'Richiesta di assenza non trovata');
    }
    if (!allowedFrom.includes(current.status)) {
        return sendErrorResponse(
            res,
            409,
            `Transizione ${current.status} -> ${toStatus} non consentita`
        );
    }

    const actorId = actorUserId(req);
    const note = cleanText(req.body?.note ?? req.body?.reviewNote);

    const changed = await sequelize.transaction(async (transaction) => {
        const [rowsUpdated] = await TimeOffRequest.schema(schema).update(
            {
                status: toStatus,
                reviewedByUserId: actorId,
                reviewedAt: new Date(),
                reviewNote: note
            },
            {
                where: { id: current.id, status: current.status },
                transaction
            }
        );

        if (rowsUpdated === 0) {
            return false;
        }

        await appendHistory(schema, transaction, current.id, current.status, toStatus, actorId, note);
        return true;
    });

    if (!changed) {
        return sendErrorResponse(res, 409, 'La richiesta è stata modificata da un altro utente');
    }

    const updated = await TimeOffRequest.schema(schema).findByPk(current.id);
    return sendSuccessResponse(res, 200, updated, message);
}

export const approveTimeOffRequest = asyncHandler((req: Request, res: Response) =>
    transition(req, res, ['PENDING'], 'APPROVED', 'Richiesta di assenza approvata')
);

export const rejectTimeOffRequest = asyncHandler((req: Request, res: Response) =>
    transition(req, res, ['PENDING'], 'REJECTED', 'Richiesta di assenza rifiutata')
);

export const cancelTimeOffRequest = asyncHandler((req: Request, res: Response) =>
    transition(req, res, ['PENDING'], 'CANCELLED', 'Richiesta di assenza ritirata')
);

export const revokeTimeOffRequest = asyncHandler((req: Request, res: Response) =>
    transition(req, res, ['APPROVED'], 'REVOKED', 'Richiesta di assenza revocata')
);

export default {
    getTimeOffRequests,
    getTimeOffRequestById,
    getTimeOffRequestHistory,
    createTimeOffRequest,
    updateTimeOffRequest,
    approveTimeOffRequest,
    rejectTimeOffRequest,
    cancelTimeOffRequest,
    revokeTimeOffRequest
};
