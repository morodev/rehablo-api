import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { Structure, StructureAvailability, Tenant, User } from '../models/index.js';

export const saveStructureForTenant = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getCurrentTenantId(req);

    const tenant = await Tenant.findByPk(tenantId, { include: User });
    if (!tenant) {
        return sendErrorResponse(res, 404, 'Tenant not found');
    }

    // TODO: re-enable the structure quantity limit once subscription plans are wired in.
    // if (tenant.get('structureQuantity') >= tenant.get('maxStructureQuantity')) {
    //     return sendErrorResponse(res, 403, 'Maximum limit for structures');
    // }

    req.body.tenantId = tenantId;

    const newStructure = await Structure.create(req.body, { include: StructureAvailability as any });

    const users = await (tenant as any).getUsers();
    await Promise.all(users.map((user: any) => (newStructure as any).addUser(user)));

    return sendSuccessResponse(res, 201, newStructure, 'Structure created');
});

export const updateStructureForTenant = asyncHandler(async (req: Request, res: Response) => {
    const structureId = req.params.structureId;
    const structureToUpdate = req.body.premise;

    const [rowsUpdated] = await Structure.update(structureToUpdate, {
        where: { id: structureId }
    });

    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Structure not found');
    }

    const updatedStructure = await Structure.findByPk(structureId, {
        include: [{ model: StructureAvailability }]
    });

    if (Array.isArray(structureToUpdate.premiseAvailabilities)) {
        for (const availability of structureToUpdate.premiseAvailabilities) {
            if (availability.id) {
                await StructureAvailability.update(availability, { where: { id: availability.id } });
            } else {
                await StructureAvailability.create({ ...availability, structureId: structureId });
            }
        }
    }

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

export async function findStructureById(structureId: string) {
    return Structure.findByPk(structureId, {
        include: [{ model: StructureAvailability }],
        order: [[StructureAvailability, 'day', 'ASC']]
    });
}

export default { saveStructureForTenant, updateStructureForTenant, findAllStructuresForTenant };

