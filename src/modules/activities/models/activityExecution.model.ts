import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import Activity from './activity.model.js';

/** Fields projected onto the one operational card; execution ids never replace its stable id. */
export const ACTIVITY_EXECUTION_STATE_FIELDS = [
    'boardId', 'title', 'description', 'status', 'priority', 'position', 'checklistRevision',
    'reviewerUserId', 'reviewStatus', 'reviewApprovedByUserId', 'reviewApprovedAt',
    'dueKind', 'dueAt', 'dueDate', 'dueTimezone', 'createdByUserId', 'updatedByUserId',
    'patientId', 'agendaEventId', 'completedAt', 'completedByUserId', 'archivedAt', 'archivedByUserId',
    'reassignmentRequired'
] as const;

export class ActivityExecution extends Model {
    declare id: string;
    declare activityId: string;
    declare occurrenceDate: string;
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
    declare assigneeIds: string[];
    declare closedAt: Date | null;
    declare deadlineSnapshot: Record<string, unknown> | null;
    declare lateUpdatedAt: Date | null;
    declare lateUpdatedByUserId: string | null;
    declare createdAt: Date;
    declare updatedAt: Date;
}

const parentAttributes = Activity.getAttributes();
const stateAttributes = Object.fromEntries(ACTIVITY_EXECUTION_STATE_FIELDS.map(name => {
    const attribute = parentAttributes[name];
    return [name, {type: attribute.type, allowNull: attribute.allowNull,
        ...(attribute.defaultValue === undefined ? {} : {defaultValue: attribute.defaultValue}),
        ...(attribute.validate ? {validate: attribute.validate} : {})}];
}));

ActivityExecution.init({
    id: {type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true},
    activityId: {type: DataTypes.UUID, allowNull: false},
    occurrenceDate: {type: DataTypes.DATEONLY, allowNull: false},
    ...stateAttributes,
    version: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 1},
    assigneeIds: {type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: []},
    closedAt: {type: DataTypes.DATE, allowNull: true},
    deadlineSnapshot: {type: DataTypes.JSONB, allowNull: true},
    lateUpdatedAt: {type: DataTypes.DATE, allowNull: true},
    lateUpdatedByUserId: {type: DataTypes.UUID, allowNull: true}
}, {sequelize, modelName: 'activityExecution', tableName: 'activity_executions', timestamps: true,
    indexes: [{name: 'activity_executions_activity_date_unique', unique: true, fields: ['activityId', 'occurrenceDate']},
        {name: 'activity_executions_board_date', fields: ['boardId', 'occurrenceDate']}]});

export default ActivityExecution;
