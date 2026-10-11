import {Transaction} from 'sequelize';
import {sequelize} from '../config/database.js';

/** Acquire before any board, membership or calendar lock; held until transaction ends. */
export async function acquireTenantActivityGate(
    tenantId: string, transaction: Transaction, mode: 'shared' | 'exclusive'
): Promise<void> {
    const functionName = mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
    await sequelize.query(`SELECT ${functionName}(hashtext('activities-membership-gate'), hashtext(:tenantId))`, {
        replacements: {tenantId: tenantId.toLowerCase()}, transaction
    });
}
