import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

/** Tenant-scoped; always use .schema(context.tenantSchema). */
export class ActivityDelivery extends Model {
    declare id: string;
    declare alertId: string;
    declare recipientUserId: string;
    declare scheduleVersion: number;
    declare channel: 'inApp' | 'push' | 'email';
    declare status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED' | 'CANCELLED' | 'UNCERTAIN';
    declare scheduledAt: Date;
    declare dispatchStartedAt: Date | null;
    declare attempts: number;
    declare nextAttemptAt: Date;
    declare leaseUntil: Date | null;
    declare leaseToken: string | null;
    declare lastError: string | null;
    declare providerReference: string | null;
    declare sentAt: Date | null;
    declare readAt: Date | null;
    declare createdAt: Date;
    declare updatedAt: Date;
}

ActivityDelivery.init({
    id: {type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true},
    alertId: {type: DataTypes.UUID, allowNull: false},
    recipientUserId: {type: DataTypes.UUID, allowNull: false},
    scheduleVersion: {type: DataTypes.INTEGER, allowNull: false, validate: {min: 1}},
    channel: {type: DataTypes.STRING(16), allowNull: false},
    status: {type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PENDING'},
    scheduledAt: {type: DataTypes.DATE, allowNull: false},
    dispatchStartedAt: {type: DataTypes.DATE, allowNull: true},
    attempts: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, validate: {min: 0}},
    nextAttemptAt: {type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW},
    leaseUntil: {type: DataTypes.DATE, allowNull: true},
    leaseToken: {type: DataTypes.UUID, allowNull: true},
    lastError: {type: DataTypes.STRING(255), allowNull: true},
    providerReference: {type: DataTypes.STRING(255), allowNull: true},
    sentAt: {type: DataTypes.DATE, allowNull: true},
    readAt: {type: DataTypes.DATE, allowNull: true}
}, {
    sequelize,
    modelName: 'activityDelivery',
    tableName: 'activity_deliveries',
    timestamps: true
});

export default ActivityDelivery;

