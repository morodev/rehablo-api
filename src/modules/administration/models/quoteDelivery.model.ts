import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database.js';

/** Tenant-local evidence of exactly what was prepared/sent, independent of later edits. */
export class QuoteDelivery extends Model {}
QuoteDelivery.init({
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    quoteId: { type: DataTypes.UUID, allowNull: false },
    patientId: { type: DataTypes.UUID, allowNull: false },
    channel: { type: DataTypes.STRING(16), allowNull: false },
    recipient: { type: DataTypes.STRING(254), allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: false },
    snapshot: { type: DataTypes.JSONB, allowNull: false },
    snapshotHash: { type: DataTypes.STRING(64), allowNull: false },
    requestHash: { type: DataTypes.STRING(64), allowNull: false },
    idempotencyKey: { type: DataTypes.STRING(128), allowNull: false },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PREPARING' },
    createdByUserId: { type: DataTypes.UUID, allowNull: false },
    sentAt: { type: DataTypes.DATE, allowNull: true },
    confirmedAt: { type: DataTypes.DATE, allowNull: true },
    confirmedByUserId: { type: DataTypes.UUID, allowNull: true },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    lastError: { type: DataTypes.TEXT, allowNull: true }
}, {
    sequelize, modelName: 'quoteDelivery', tableName: 'quote_deliveries',
    indexes: [
        { name: 'quote_deliveries_idempotency_unique', unique: true, fields: ['quoteId', 'idempotencyKey'] },
        { name: 'quote_deliveries_quote_date_idx', fields: ['quoteId', 'createdAt'] }
    ],
    hooks: {
        beforeUpdate(record) {
            const changed = record.changed() as string[] | false;
            for (const field of ['quoteId', 'patientId', 'channel', 'recipient', 'message', 'snapshot', 'snapshotHash', 'requestHash', 'idempotencyKey', 'createdByUserId']) {
                if (changed && changed.includes(field)) throw new Error('Il contenuto di una consegna è immutabile');
            }
        }
    }
});

/** Public lookup contains no patient, recipient or document content, and only the token hash. */
export class QuoteShareLink extends Model {}
QuoteShareLink.init({
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    tenantId: { type: DataTypes.UUID, allowNull: false },
    quoteId: { type: DataTypes.UUID, allowNull: false },
    deliveryId: { type: DataTypes.UUID, allowNull: false, unique: true },
    tokenHash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    revokedAt: { type: DataTypes.DATE, allowNull: true }
}, {
    sequelize, schema: 'public', modelName: 'quoteShareLink', tableName: 'quote_share_links',
    indexes: [{ name: 'quote_share_links_tenant_quote_idx', fields: ['tenantId', 'quoteId'] }]
});

export async function syncQuotePublicModels(): Promise<void> {
    // Additive creation only: no destructive alter against existing public tables.
    await QuoteShareLink.sync();
}
