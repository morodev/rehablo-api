import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

/** Global user preference: email is enabled unless explicitly disabled. */
export class ReminderNotificationPreference extends Model {
    declare userId: string;
    declare emailFallbackEnabled: boolean;
}

ReminderNotificationPreference.init({
    userId: {type: DataTypes.UUID, allowNull: false, primaryKey: true},
    emailFallbackEnabled: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true}
}, {sequelize, modelName: 'reminderNotificationPreference', tableName: 'reminder_notification_preferences'});

export default ReminderNotificationPreference;
