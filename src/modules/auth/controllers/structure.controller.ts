import { Request, Response } from 'express';
import { Op } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { Structure, StructureAvailability, StructureUser, Tenant, TenantUser } from '../models/index.js';
import { RoleCode } from '../rbac/roles.js';

export const saveStructureForTenant = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getCurrentTenantId(req);

    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) {
        return sendErrorResponse(res, 404, 'Tenant not found');
    }

    // TODO: re-enable the structure quantity limit once subscription plans are wired in.
    // if (tenant.get('structureQuantity') >= tenant.get('maxStructureQuantity')) {
    //     return sendErrorResponse(res, 403, 'Maximum limit for structures');
    // }

    req.body.tenantId = tenantId;

    const newStructure = await Structure.create(req.body, { include: StructureAvailability as any });

    // Una nuova sede non abilita automaticamente tutto il team. Soltanto gli OWNER
    // devono operare su ogni sede per invariant di dominio; gli altri vengono assegnati
    // esplicitamente dalla gestione Team.
    const owners = await TenantUser.findAll({
        where: { tenantId, role: RoleCode.OWNER },
        attributes: ['userId']
    });
    if (owners.length > 0) {
        await StructureUser.bulkCreate(
            owners.map((owner) => ({
                structureId: newStructure.get('id') as string,
                userId: owner.get('userId') as string,
                role: null
            })),
            { ignoreDuplicates: true }
        );
    }

    return sendSuccessResponse(res, 201, newStructure, 'Structure created');
});

export const updateStructureForTenant = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getCurrentTenantId(req);
    const structureId = req.params.structureId;
    const structureToUpdate = req.body.premise;

    const [rowsUpdated] = await Structure.update(structureToUpdate, {
        where: { id: structureId, tenantId }
    });

    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Structure not found');
    }

    if (Array.isArray(structureToUpdate.premiseAvailabilities)) {
        for (const availability of structureToUpdate.premiseAvailabilities) {
            if (availability.id) {
                await StructureAvailability.update(availability, {
                    where: { id: availability.id, structureId }
                });
            } else {
                await StructureAvailability.create({ ...availability, structureId: structureId });
            }
        }
    }

    const updatedStructure = await Structure.findOne({
        where: { id: structureId, tenantId },
        include: [{ model: StructureAvailability }]
    });

    return sendSuccessResponse(res, 200, updatedStructure, 'Structure updated');
});

export const findAllStructuresForTenant = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getCurrentTenantId(req);

    const structures = await Structure.findAll({
        where: { tenantId },
        include: [{ model: StructureAvailability }],
        order: [[StructureAvailability, 'day', 'ASC']]
    });

    return sendSuccessResponse(res, 200, structures, 'Structure loaded');
});

/** Restituisce esclusivamente le sedi in cui l'utente autenticato può operare. */
export const findAccessibleStructures = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getCurrentTenantId(req);
    const userId = (req.user?.sub as string | undefined) ?? req.user?.id;

    if (!userId) {
        return sendErrorResponse(res, 401, 'Utente non autenticato');
    }

    const assignments = await StructureUser.findAll({
        where: { userId },
        attributes: ['structureId']
    });
    const structureIds = assignments.map((assignment) => assignment.get('structureId') as string);

    const structures = structureIds.length
        ? await Structure.findAll({
            where: { tenantId, id: { [Op.in]: structureIds } },
            include: [{ model: StructureAvailability }],
            order: [[StructureAvailability, 'day', 'ASC']]
        })
        : [];

    return sendSuccessResponse(res, 200, structures, 'Accessible structures loaded');
});

export async function findStructureById(structureId: string) {
    return Structure.findByPk(structureId, {
        include: [{ model: StructureAvailability }],
        order: [[StructureAvailability, 'day', 'ASC']]
    });
}

export default {
    saveStructureForTenant,
    updateStructureForTenant,
    findAllStructuresForTenant,
    findAccessibleStructures
};

