import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface ReminderAlertStateAttributes {
    reminderId: string;
    userId: string;
    scheduledFor?: Date | null;
    deliveredAt?: Date | null;
    snoozedUntil?: Date | null;
}

export class ReminderAlertState extends Model<ReminderAlertStateAttributes> implements ReminderAlertStateAttributes {
    declare reminderId: string;
    declare userId: string;
    declare scheduledFor: Date | null;
    declare deliveredAt: Date | null;
    declare snoozedUntil: Date | null;
}

ReminderAlertState.init(
    {
        reminderId: {type: DataTypes.UUID, allowNull: false, primaryKey: true},
        userId: {type: DataTypes.UUID, allowNull: false, primaryKey: true},
        scheduledFor: {type: DataTypes.DATE, allowNull: true},
        deliveredAt: {type: DataTypes.DATE, allowNull: true},
        snoozedUntil: {type: DataTypes.DATE, allowNull: true}
    },
    {
        sequelize,
        modelName: 'reminderAlertState',
        tableName: 'reminder_alert_states',
        indexes: [{name: 'reminder_alert_states_due', fields: ['userId', 'snoozedUntil']}]
    }
);

export default ReminderAlertState;
