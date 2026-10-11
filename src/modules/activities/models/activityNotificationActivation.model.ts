import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

/** Tenant-scoped activation cutoff, deliberately written at runtime and never by migration. */
export class ActivityNotificationActivation extends Model {
    declare key: string;
    declare activatedAt: Date;
}
ActivityNotificationActivation.init({
    key: {type: DataTypes.STRING(32), primaryKey: true},
    activatedAt: {type: DataTypes.DATE, allowNull: false}
}, {sequelize, modelName: 'activityNotificationActivation', tableName: 'activity_notification_activation', timestamps: false});
export default ActivityNotificationActivation;
