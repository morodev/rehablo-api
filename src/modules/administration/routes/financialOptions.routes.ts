import {Router} from 'express';
import {sequelize} from '../../../config/database.js';
import {requireAuth, getCurrentTenantId} from '../../../middleware/auth.js';
import {requireAnyPermission, requirePermission} from '../../../middleware/rbac.js';
import {resolveTenantSchema} from '../../../middleware/tenantSchema.js';
import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendSuccessResponse} from '../../../utils/response.js';
import {Structure, Tenant} from '../../auth/models/index.js';
import {readFinancialOptions, lockFinancialAccounts} from '../services/financialAccountResolver.service.js';
import {nullableTreasuryUuid, treasuryError, validateTreasuryAccount} from '../services/treasuryValidation.service.js';

export async function financialOptionsStructure(req: any, value: unknown, transaction?: any): Promise<string> {
    const id = nullableTreasuryUuid(value ?? req.access?.structureId, 'Sede');
    if (!id) treasuryError('Seleziona una sede', 422);
    if (req.access?.scope !== 'tenant' && id !== req.access?.structureId) treasuryError('Sede non accessibile', 403);
    if (!await Structure.findOne({where: {id, tenantId: getCurrentTenantId(req)}, transaction})) treasuryError('Sede non disponibile', 404);
    return id;
}
export const getFinancialOptions = asyncHandler(async (req, res) => {
    const id = await financialOptionsStructure(req, req.query.structureId);
    return sendSuccessResponse(res, 200, await readFinancialOptions(req.tenantSchema!, id));
});
export const setDefaultFinancialAccount = asyncHandler(async (req, res) => {
    const id = await financialOptionsStructure(req, req.body?.structureId);
    const accountId = nullableTreasuryUuid(req.body?.accountId, 'Conto');
    if (!Object.hasOwn(req.body ?? {}, 'accountId')) treasuryError('Indica il conto preferito o rimuovi la preferenza');
    await sequelize.transaction(async transaction => {
        await lockFinancialAccounts(req.tenantSchema!, id, transaction);
        if (accountId) await validateTreasuryAccount(req.tenantSchema!, accountId, id, transaction);
        const tenant = await Tenant.findByPk(getCurrentTenantId(req), {transaction, lock: transaction.LOCK.UPDATE});
        if (!tenant) treasuryError('Organizzazione non disponibile', 404);
        const settings = tenant.get('administrationSettings') as any ?? {};
        const treasury = settings.treasury ?? {};
        const defaults = {...treasury.defaultAccountByStructureId};
        if (accountId) defaults[id] = accountId; else delete defaults[id];
        await tenant.update({administrationSettings: {...settings, treasury: {...treasury, defaultAccountByStructureId: defaults}}}, {transaction});
    });
    return sendSuccessResponse(res, 200, await readFinancialOptions(req.tenantSchema!, id));
});
const router = Router();
router.use(requireAuth, resolveTenantSchema);
router.get('/financial-options', requireAnyPermission(['payment', 'create'], ['invoice', 'create'], ['treasury', 'read'],
    ['treasury', 'create'], ['treasury', 'update'], ['expense', 'update']), getFinancialOptions);
router.patch('/financial-options/default-account', requirePermission('treasury', 'update', 'structure'), setDefaultFinancialAccount);
export default router;
