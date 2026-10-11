import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

/** Global personal preference; entirely independent from the reminder fallback. */
export class ActivityNotificationPreference extends Model {
    declare userId: string;
    declare emailEnabled: boolean;
    declare emailEnabledAt: Date | null;
}
ActivityNotificationPreference.init({
    userId: {type: DataTypes.UUID, primaryKey: true},
    emailEnabled: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false},
    emailEnabledAt: {type: DataTypes.DATE, allowNull: true}
}, {sequelize, modelName: 'activityNotificationPreference', tableName: 'activity_notification_preferences', schema: 'public'});
export default ActivityNotificationPreference;
