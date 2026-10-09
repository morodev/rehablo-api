import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

export type ReminderDeliveryStatus = 'PENDING' | 'PROCESSING' | 'SENT' | 'SKIPPED';

/** Tenant-scoped durable external notification, one per recipient and effective alert time. */
export class ReminderExternalDelivery extends Model {
    declare id: string;
    declare reminderId: string;
    declare userId: string;
    declare scheduledFor: Date;
    declare baseScheduledFor: Date;
    declare status: ReminderDeliveryStatus;
    declare attempts: number;
    declare nextAttemptAt: Date;
    declare leaseUntil: Date | null;
    declare deliveredVia: string | null;
    declare lastError: string | null;
}

ReminderExternalDelivery.init({
    id: {type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true},
    reminderId: {type: DataTypes.UUID, allowNull: false},
    userId: {type: DataTypes.UUID, allowNull: false},
    scheduledFor: {type: DataTypes.DATE, allowNull: false},
    baseScheduledFor: {type: DataTypes.DATE, allowNull: false},
    status: {type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PENDING'},
    attempts: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 0},
    nextAttemptAt: {type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW},
    leaseUntil: {type: DataTypes.DATE, allowNull: true},
    deliveredVia: {type: DataTypes.STRING(16), allowNull: true},
    lastError: {type: DataTypes.STRING(255), allowNull: true}
}, {
    sequelize,
    modelName: 'reminderExternalDelivery',
    tableName: 'reminder_external_deliveries',
    indexes: [
        {name: 'reminder_external_deliveries_unique_schedule', unique: true, fields: ['reminderId', 'userId', 'scheduledFor']},
        {name: 'reminder_external_deliveries_due', fields: ['status', 'nextAttemptAt']}
    ]
});

export default ReminderExternalDelivery;
