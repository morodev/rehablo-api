import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

/** Persisted rollout cutoff: overdue reminders from before the feature launch are not emailed. */
export class ReminderNotificationActivation extends Model {
    declare key: string;
    declare activatedAt: Date;
}

ReminderNotificationActivation.init({
    key: {type: DataTypes.STRING(40), allowNull: false, primaryKey: true},
    activatedAt: {type: DataTypes.DATE, allowNull: false}
}, {sequelize, modelName: 'reminderNotificationActivation', tableName: 'reminder_notification_activations'});

export default ReminderNotificationActivation;
