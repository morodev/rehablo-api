import {Transaction} from 'sequelize';
import ActivityNotificationActivation from '../models/activityNotificationActivation.model.js';

export function activitiesDeliveryEnabled(): boolean {
    return process.env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT && process.env.ACTIVITIES_DELIVERY_ENABLED !== 'false';
}

/** Called by startup, provisioning and before a new alert; migration scripts never call it. */
export async function ensureActivityDeliveryActivation(
    schema: string, transaction?: Transaction, options: {force?: boolean; now?: Date} = {}
): Promise<Date | null> {
    if (!options.force && !activitiesDeliveryEnabled()) return null;
    const [row] = await ActivityNotificationActivation.schema(schema).findOrCreate({
        where: {key: 'activities'}, defaults: {key: 'activities', activatedAt: options.now ?? new Date()}, transaction
    });
    return row.activatedAt;
}
