import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface ReminderAssignmentAttributes {
    reminderId: string;
    userId: string;
    assignedByUserId: string;
}

export class ReminderAssignment extends Model<ReminderAssignmentAttributes> implements ReminderAssignmentAttributes {
    declare reminderId: string;
    declare userId: string;
    declare assignedByUserId: string;
}

ReminderAssignment.init(
    {
        reminderId: {type: DataTypes.UUID, allowNull: false, primaryKey: true},
        userId: {type: DataTypes.UUID, allowNull: false, primaryKey: true},
        assignedByUserId: {type: DataTypes.UUID, allowNull: false}
    },
    {
        sequelize,
        modelName: 'reminderAssignment',
        tableName: 'reminder_assignments',
        indexes: [{name: 'reminder_assignments_user_id', fields: ['userId']}]
    }
);

export default ReminderAssignment;
