import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

/** Browser subscription bound to the currently authenticated user. */
export class ReminderPushSubscription extends Model {
    declare id: string;
    declare userId: string;
    declare endpointHash: string;
    declare endpoint: string;
    declare p256dh: string;
    declare auth: string;
    declare remindersEnabled: boolean;
    declare activitiesEnabled: boolean;
    declare activitiesEnabledAt: Date | null;
}

ReminderPushSubscription.init({
    id: {type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true},
    userId: {type: DataTypes.UUID, allowNull: false},
    endpointHash: {type: DataTypes.STRING(64), allowNull: false, unique: true},
    endpoint: {type: DataTypes.TEXT, allowNull: false},
    p256dh: {type: DataTypes.TEXT, allowNull: false},
    auth: {type: DataTypes.TEXT, allowNull: false},
    remindersEnabled: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true},
    activitiesEnabled: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false},
    activitiesEnabledAt: {type: DataTypes.DATE, allowNull: true}
}, {
    sequelize,
    modelName: 'reminderPushSubscription',
    tableName: 'reminder_push_subscriptions',
    indexes: [{name: 'reminder_push_subscriptions_user', fields: ['userId']}]
});

export default ReminderPushSubscription;
