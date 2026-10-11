import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

/** Tenant-scoped; always use .schema(context.tenantSchema). */
export class ActivityHistory extends Model {
    declare id: string;
    declare activityId: string;
    declare actorUserId: string | null;
    declare eventType: string;
    declare data: Record<string, unknown>;
    declare createdAt: Date;
}

ActivityHistory.init({
    id: {type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true},
    activityId: {type: DataTypes.UUID, allowNull: false},
    actorUserId: {type: DataTypes.UUID, allowNull: true},
    eventType: {type: DataTypes.STRING(64), allowNull: false},
    data: {type: DataTypes.JSONB, allowNull: false, defaultValue: {}}
}, {
    sequelize,
    modelName: 'activityHistory',
    tableName: 'activity_history',
    updatedAt: false,
    timestamps: true
});

export default ActivityHistory;

