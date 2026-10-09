import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface NoteAssignmentAttributes {
    noteId: string;
    userId: string;
    assignedByUserId: string;
}

export class NoteAssignment extends Model<NoteAssignmentAttributes> implements NoteAssignmentAttributes {
    declare noteId: string;
    declare userId: string;
    declare assignedByUserId: string;
}

NoteAssignment.init(
    {
        noteId: {type: DataTypes.UUID, allowNull: false, primaryKey: true},
        userId: {type: DataTypes.UUID, allowNull: false, primaryKey: true},
        assignedByUserId: {type: DataTypes.UUID, allowNull: false}
    },
    {
        sequelize,
        modelName: 'noteAssignment',
        tableName: 'note_assignments',
        indexes: [{name: 'note_assignments_user_id', fields: ['userId']}]
    }
);

export default NoteAssignment;
