import {Transaction} from 'sequelize';
import {getTenantSchemaName} from '../../../utils/tenantSchema.js';
import {ActivityBoard} from '../models/index.js';
import {ActivityError} from '../utils/activityErrors.js';

/** No DDL: the caller must provision the tenant before creating its next structure. */
export async function createActivityBoardForStructure(
    tenantId: string, structureId: string, transaction: Transaction
): Promise<void> {
    try {
        await ActivityBoard.schema(getTenantSchemaName(tenantId)).bulkCreate([{
            structureId, timezone: 'Europe/Rome', orderRevision: 0, snapshotRevision: 0
        }], {transaction, ignoreDuplicates: true});
    } catch (error) {
        console.error('[activities] board provisioning failed', {
            tenantId, structureId, code: (error as {original?: {code?: string}})?.original?.code
        });
        throw new ActivityError('ACTIVITY_BOARD_UNAVAILABLE', 503,
            'Non siamo riusciti a preparare le attività della nuova sede. La sede non è stata salvata; riprova tra poco.');
    }
}
