import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

/** Tenant-scoped; always use .schema(context.tenantSchema). */
export class ActivityAssignment extends Model {
    declare activityId: string;
    declare userId: string;
    declare assignedByUserId: string;
    declare createdAt: Date;
    declare updatedAt: Date;
}

ActivityAssignment.init({
    activityId: {type: DataTypes.UUID, allowNull: false, primaryKey: true},
    userId: {type: DataTypes.UUID, allowNull: false, primaryKey: true},
    assignedByUserId: {type: DataTypes.UUID, allowNull: false}
}, {
    sequelize,
    modelName: 'activityAssignment',
    tableName: 'activity_assignments',
    timestamps: true
});

export default ActivityAssignment;

