import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

/** Tenant-scoped; always use .schema(context.tenantSchema). */
export class Activity extends Model {
    declare id: string;
    declare boardId: string;
    declare title: string;
    declare description: string | null;
    declare status: 'TODO' | 'IN_PROGRESS' | 'WAITING' | 'COMPLETED';
    declare priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
    declare position: string;
    declare version: number;
    declare checklistRevision: number;
    declare reviewerUserId: string | null;
    declare reviewStatus: 'not_requested' | 'pending' | 'approved';
    declare reviewApprovedByUserId: string | null;
    declare reviewApprovedAt: Date | null;
    declare dueKind: 'timed' | 'allDay' | null;
    declare dueAt: Date | null;
    declare dueDate: string | null;
    declare dueTimezone: string | null;
    declare createdByUserId: string;
    declare updatedByUserId: string | null;
    declare patientId: string | null;
    declare agendaEventId: string | null;
    declare completedAt: Date | null;
    declare completedByUserId: string | null;
    declare archivedAt: Date | null;
    declare archivedByUserId: string | null;
    declare reassignmentRequired: boolean;
    declare createdAt: Date;
    declare updatedAt: Date;
}

Activity.init({
    id: {type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true},
    boardId: {type: DataTypes.UUID, allowNull: false},
    title: {type: DataTypes.STRING(200), allowNull: false, validate: {len: [1, 200]}},
    description: {type: DataTypes.TEXT, allowNull: true, validate: {len: [0, 5000]}},
    status: {type: DataTypes.STRING(16), allowNull: false, defaultValue: 'TODO', validate: {isIn: [['TODO', 'IN_PROGRESS', 'WAITING', 'COMPLETED']]}},
    priority: {type: DataTypes.STRING(8), allowNull: false, defaultValue: 'NORMAL', validate: {isIn: [['LOW', 'NORMAL', 'HIGH', 'URGENT']]}},
    position: {type: DataTypes.BIGINT, allowNull: false, defaultValue: '0'},
    version: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, validate: {min: 1}},
    checklistRevision: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, validate: {min: 0}},
    reviewerUserId: {type: DataTypes.UUID, allowNull: true},
    reviewStatus: {type: DataTypes.STRING(16), allowNull: false, defaultValue: 'not_requested', validate: {isIn: [['not_requested', 'pending', 'approved']]}},
    reviewApprovedByUserId: {type: DataTypes.UUID, allowNull: true},
    reviewApprovedAt: {type: DataTypes.DATE, allowNull: true},
    dueKind: {type: DataTypes.STRING(8), allowNull: true, validate: {isIn: [['timed', 'allDay']]}},
    dueAt: {type: DataTypes.DATE, allowNull: true},
    dueDate: {type: DataTypes.DATEONLY, allowNull: true},
    dueTimezone: {type: DataTypes.STRING(96), allowNull: true},
    createdByUserId: {type: DataTypes.UUID, allowNull: false},
    updatedByUserId: {type: DataTypes.UUID, allowNull: true},
    patientId: {type: DataTypes.UUID, allowNull: true},
    agendaEventId: {type: DataTypes.UUID, allowNull: true},
    completedAt: {type: DataTypes.DATE, allowNull: true},
    completedByUserId: {type: DataTypes.UUID, allowNull: true},
    archivedAt: {type: DataTypes.DATE, allowNull: true},
    archivedByUserId: {type: DataTypes.UUID, allowNull: true},
    reassignmentRequired: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false}
}, {
    sequelize,
    modelName: 'activity',
    tableName: 'activities',
    timestamps: true
});

export default Activity;

