import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

/** Tenant-scoped; always use .schema(context.tenantSchema). */
export class ActivityOperation extends Model {
    declare boardId: string;
    declare actorUserId: string;
    declare operationId: string;
    declare command: string;
    declare inputHash: string;
    declare responseStatus: number;
    declare responseBody: Record<string, unknown>;
    declare expiresAt: Date;
    declare createdAt: Date;
    declare updatedAt: Date;
}

ActivityOperation.init({
    boardId: {type: DataTypes.UUID, allowNull: false, primaryKey: true},
    actorUserId: {type: DataTypes.UUID, allowNull: false, primaryKey: true},
    operationId: {type: DataTypes.UUID, allowNull: false, primaryKey: true},
    command: {type: DataTypes.STRING(128), allowNull: false},
    inputHash: {type: DataTypes.STRING(64), allowNull: false},
    responseStatus: {type: DataTypes.INTEGER, allowNull: false},
    responseBody: {type: DataTypes.JSONB, allowNull: false},
    expiresAt: {type: DataTypes.DATE, allowNull: false}
}, {
    sequelize,
    modelName: 'activityOperation',
    tableName: 'activity_operations',
    timestamps: true
});

export default ActivityOperation;

