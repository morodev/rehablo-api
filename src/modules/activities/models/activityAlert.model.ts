import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

/** Tenant-scoped; always use .schema(context.tenantSchema). */
export class ActivityAlert extends Model {
    declare id: string;
    declare activityId: string;
    declare executionId: string | null;
    declare enabled: boolean;
    declare scheduledAt: Date | null;
    declare scheduleVersion: number;
    declare channels: Array<'inApp' | 'push' | 'email'>;
    declare createdAt: Date;
    declare updatedAt: Date;
}

ActivityAlert.init({
    id: {type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true},
    activityId: {type: DataTypes.UUID, allowNull: false, unique: 'activity_alerts_activity_unique'},
    executionId: {type: DataTypes.UUID, allowNull: true},
    enabled: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false},
    scheduledAt: {type: DataTypes.DATE, allowNull: true},
    scheduleVersion: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, validate: {min: 1}},
    channels: {type: DataTypes.ARRAY(DataTypes.STRING(16)), allowNull: false, defaultValue: []}
}, {
    sequelize,
    modelName: 'activityAlert',
    tableName: 'activity_alerts',
    timestamps: true
});

export default ActivityAlert;
