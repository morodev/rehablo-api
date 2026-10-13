import {assertBillingCapacity} from '../../billing/services/billingAccess.service.js';
import { Request, Response } from 'express';
import { Op } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { Structure, StructureAvailability, StructureUser, Tenant, TenantUser } from '../models/index.js';
import { RoleCode } from '../rbac/roles.js';
import { sequelize } from '../../../config/database.js';
import {acquireTenantActivityGate} from '../../../utils/tenantActivityGate.js';
import { createActivityBoardForStructure } from '../../activities/services/activityBoardBootstrap.service.js';

export const saveStructureForTenant = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getCurrentTenantId(req);

    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) {
        return sendErrorResponse(res, 404, 'Tenant not found');
    }

    req.body.tenantId = tenantId;

    // Sede, disponibilità, membership degli owner e board diventano visibili insieme.
    const newStructure = await sequelize.transaction(async transaction => {
        await acquireTenantActivityGate(tenantId, transaction, 'shared');
        await assertBillingCapacity(tenantId, 'structures', transaction);
        const structure = await Structure.create(req.body, {
            include: StructureAvailability as any,
            transaction
        });
        // Una nuova sede non abilita automaticamente tutto il team. Gli altri membri
        // vengono assegnati esplicitamente dalla gestione Team.
        const owners = await TenantUser.findAll({
            where: { tenantId, role: RoleCode.OWNER },
            attributes: ['userId'],
            transaction
        });
        if (owners.length > 0) {
            await StructureUser.bulkCreate(
                owners.map(owner => ({
                    structureId: structure.get('id') as string,
                    userId: owner.get('userId') as string,
                    role: null
                })),
                { ignoreDuplicates: true, transaction }
            );
        }
        await createActivityBoardForStructure(tenantId, structure.get('id') as string, transaction);
        return structure;
    });

    return sendSuccessResponse(res, 201, newStructure, 'Structure created');
});

export const updateStructureForTenant = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getCurrentTenantId(req);
    const structureId = req.params.structureId;
    const premise = req.body?.premise;
    if (!premise || typeof premise !== 'object' || Array.isArray(premise)) {
        return sendErrorResponse(res, 400, 'Structure payload not valid');
    }
    // The route and authenticated tenant own the identities. Never turn a scoped UPDATE
    // into a transfer by allowing those same keys in its SET values.
    const { id: _id, tenantId: _tenantId, createdAt: _createdAt, updatedAt: _updatedAt,
        premiseAvailabilities, ...structureToUpdate } = premise;

    const updatedStructure = await sequelize.transaction(async transaction => {
        if (Object.keys(structureToUpdate).length > 0) {
            const [rowsUpdated] = await Structure.update(structureToUpdate, {
                where: { id: structureId, tenantId }, transaction
            });
            if (rowsUpdated === 0) return null;
        } else {
            // An availability-only edit still needs to prove and lock the parent scope.
            const structure = await Structure.findOne({
                where: { id: structureId, tenantId }, attributes: ['id'],
                transaction, lock: transaction.LOCK.UPDATE
            });
            if (!structure) return null;
        }

        if (Array.isArray(premiseAvailabilities)) {
            for (const availability of premiseAvailabilities) {
                const { id: availabilityId, structureId: _structureId,
                    createdAt: _availabilityCreatedAt, updatedAt: _availabilityUpdatedAt,
                    ...availabilityToUpdate } = availability;
                if (availabilityId) {
                    await StructureAvailability.update(availabilityToUpdate, {
                        where: { id: availabilityId, structureId }, transaction
                    });
                } else {
                    await StructureAvailability.create({ ...availabilityToUpdate, structureId }, { transaction });
                }
            }
        }

        return Structure.findOne({
            where: { id: structureId, tenantId },
            include: [{ model: StructureAvailability }], transaction
        });
    });
    if (!updatedStructure) return sendErrorResponse(res, 404, 'Structure not found');

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

