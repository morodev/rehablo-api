import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface ScheduledBillingChange { users: number; structures: number; effectiveAt: string; }

/** Only opted-in/new organisations have a row. Absence deliberately means legacy. */
export class BillingAccount extends Model {
    declare tenantId: string;
    declare status: string;
    declare usersLimit: number;
    declare structuresLimit: number;
    declare customerId: string | null;
    declare subscriptionId: string | null;
    declare checkoutSessionId: string | null;
    declare scheduleId: string | null;
    declare currentPeriodEnd: Date | null;
    declare paidThrough: Date | null;
    declare cancelAtPeriodEnd: boolean;
    declare scheduledChange: ScheduledBillingChange | null;
}
BillingAccount.init({
    tenantId: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'pending' },
    usersLimit: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    structuresLimit: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    customerId: { type: DataTypes.STRING, allowNull: true, unique: true },
    subscriptionId: { type: DataTypes.STRING, allowNull: true, unique: true },
    checkoutSessionId: { type: DataTypes.STRING, allowNull: true },
    scheduleId: { type: DataTypes.STRING, allowNull: true },
    currentPeriodEnd: { type: DataTypes.DATE, allowNull: true },
    paidThrough: { type: DataTypes.DATE, allowNull: true },
    cancelAtPeriodEnd: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    scheduledChange: { type: DataTypes.JSONB, allowNull: true }
}, { sequelize, modelName: 'billingAccount', tableName: 'billing_accounts', schema: 'public' });

export class BillingQuote extends Model {
    declare id: string;
    declare tenantId: string;
    declare userId: string;
    declare subscriptionFingerprint: string;
    declare prorationDate: number;
    declare expiresAt: Date;
    declare payload: Record<string, any>;
}
BillingQuote.init({
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    tenantId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    subscriptionFingerprint: { type: DataTypes.TEXT, allowNull: false },
    prorationDate: { type: DataTypes.INTEGER, allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    payload: { type: DataTypes.JSONB, allowNull: false }
}, { sequelize, modelName: 'billingQuote', tableName: 'billing_quotes', schema: 'public', indexes: [{ fields: ['tenantId', 'expiresAt'] }] });

/** Committed before Stripe calls: retries recover the same mutation after a crash. */
export class BillingOperation extends Model {
    declare id: string;
    declare tenantId: string;
    declare kind: string;
    declare state: 'processing' | 'complete' | 'failed';
    declare request: Record<string, any>;
    declare result: Record<string, any> | null;
    declare progress: Record<string, any> | null;
    declare createdAt: Date;
}
BillingOperation.init({
    id: { type: DataTypes.UUID, primaryKey: true },
    tenantId: { type: DataTypes.UUID, allowNull: false },
    kind: { type: DataTypes.STRING(24), allowNull: false },
    state: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'processing' },
    request: { type: DataTypes.JSONB, allowNull: false },
    result: { type: DataTypes.JSONB, allowNull: true },
    progress: { type: DataTypes.JSONB, allowNull: true }
}, { sequelize, modelName: 'billingOperation', tableName: 'billing_operations', schema: 'public', indexes: [{ fields: ['tenantId', 'state'] }] });

export async function syncBillingModels(): Promise<void> {
    await BillingAccount.sync();
    await BillingQuote.sync();
    await BillingOperation.sync();
}
