import { Op, Transaction } from 'sequelize';
import { Tenant } from '../../auth/models/tenant.model.js';
import { TenantUser } from '../../auth/models/tenantUser.model.js';
import { Structure } from '../../auth/models/structure.model.js';
import { RoleCode } from '../../auth/rbac/roles.js';
import { BillingAccount, BillingOperation } from '../models/billing.model.js';
import { BillingError, billingAccessAllowed, effectiveLimits } from './billing.policy.js';

export async function countBillingUsage(tenantId: string, transaction?: Transaction): Promise<{ users: number; structures: number }> {
    const [users, structures] = await Promise.all([
        TenantUser.count({ where: { tenantId, deactivatedAt: null, role: { [Op.ne]: RoleCode.PATIENT } }, transaction }),
        Structure.count({ where: { tenantId }, transaction })
    ]);
    return { users, structures };
}
export async function assertBillingAccess(tenantId: string): Promise<void> {
    const account = await BillingAccount.findByPk(tenantId);
    if (!billingAccessAllowed(account)) throw new BillingError(402, 'Attiva o riattiva l’abbonamento per accedere a Rehablo.', 'BILLING_ACCESS_REQUIRED');
}
/** The caller must use the same transaction for the subsequent capacity-consuming write. */
export async function assertBillingCapacity(tenantId: string, resource: 'users' | 'structures', transaction: Transaction): Promise<void> {
    await Tenant.findByPk(tenantId, { transaction, lock: transaction.LOCK.UPDATE });
    const account = await BillingAccount.findByPk(tenantId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!account) return;
    if (!billingAccessAllowed(account)) throw new BillingError(402, 'Attiva l’abbonamento prima di aggiungere utenti o sedi.', 'BILLING_ACCESS_REQUIRED');
    const pending = await BillingOperation.findOne({ where: { tenantId, state: 'processing' }, transaction });
    if (pending) throw new BillingError(409, 'Una modifica dell’abbonamento è in elaborazione. Riprova al termine.', 'BILLING_CHANGE_PENDING');
    const usage = await countBillingUsage(tenantId, transaction);
    if (usage[resource] >= effectiveLimits(account)[resource]) throw new BillingError(409, resource === 'users' ? 'Hai utilizzato tutti i posti utente disponibili. Aggiungi posti dall’abbonamento.' : 'Hai utilizzato tutte le sedi disponibili. Aggiungi sedi dall’abbonamento.', 'BILLING_CAPACITY_EXCEEDED');
}
