import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

/** Tenant receipt for one browser, without copying browser keys into operational data. */
export class ActivityPushTarget extends Model {
    declare id: string;
    declare deliveryId: string;
    declare subscriptionId: string;
    declare endpointHash: string;
    declare status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED' | 'CANCELLED' | 'UNCERTAIN';
    declare attempts: number;
    declare nextAttemptAt: Date;
    declare dispatchStartedAt: Date | null;
    declare lastError: string | null;
    declare providerReference: string | null;
    declare sentAt: Date | null;
}
ActivityPushTarget.init({
    id: {type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true},
    deliveryId: {type: DataTypes.UUID, allowNull: false},
    subscriptionId: {type: DataTypes.UUID, allowNull: false},
    endpointHash: {type: DataTypes.STRING(64), allowNull: false},
    status: {type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PENDING'},
    attempts: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 0},
    nextAttemptAt: {type: DataTypes.DATE, allowNull: false},
    dispatchStartedAt: {type: DataTypes.DATE, allowNull: true},
    lastError: {type: DataTypes.STRING(255), allowNull: true},
    providerReference: {type: DataTypes.STRING(255), allowNull: true},
    sentAt: {type: DataTypes.DATE, allowNull: true}
}, {sequelize, modelName: 'activityPushTarget', tableName: 'activity_push_targets'});
export default ActivityPushTarget;
