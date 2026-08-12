import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export type ReminderStatus = 'OPEN' | 'DONE' | 'SNOOZED' | 'CANCELLED';
export type ReminderPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export interface ReminderAttributes {
    id: string;
    title: string;
    description?: string | null;
    dueAt?: Date | null;
    remindAt?: Date | null;
    status: ReminderStatus;
    priority: ReminderPriority;
    assigneeUserId: string;
    createdByUserId: string;
    updatedByUserId?: string | null;
    structureId?: string | null;
    patientId?: string | null;
    noteId?: string | null;
    agendaEventId?: string | null;
    completedAt?: Date | null;
    snoozedUntil?: Date | null;
}

export type ReminderCreationAttributes = Optional<
    ReminderAttributes,
    'id' | 'status' | 'priority' | 'description' | 'dueAt' | 'remindAt' | 'completedAt' | 'snoozedUntil'
>;

/** Tenant-scoped reminders. Always access through `Reminder.schema(req.tenantSchema)`. */
export class Reminder
    extends Model<ReminderAttributes, ReminderCreationAttributes>
    implements ReminderAttributes {
    declare id: string;
    declare title: string;
    declare description: string | null;
    declare dueAt: Date | null;
    declare remindAt: Date | null;
    declare status: ReminderStatus;
    declare priority: ReminderPriority;
    declare assigneeUserId: string;
    declare createdByUserId: string;
    declare updatedByUserId: string | null;
    declare structureId: string | null;
    declare patientId: string | null;
    declare noteId: string | null;
    declare agendaEventId: string | null;
    declare completedAt: Date | null;
    declare snoozedUntil: Date | null;
}

Reminder.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        title: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
        description: { type: DataTypes.TEXT, allowNull: true },
        dueAt: { type: DataTypes.DATE, allowNull: true },
        remindAt: { type: DataTypes.DATE, allowNull: true },
        status: {
            type: DataTypes.ENUM('OPEN', 'DONE', 'SNOOZED', 'CANCELLED'),
            allowNull: false,
            defaultValue: 'OPEN'
        },
        priority: {
            type: DataTypes.ENUM('LOW', 'NORMAL', 'HIGH', 'URGENT'),
            allowNull: false,
            defaultValue: 'NORMAL'
        },
        assigneeUserId: { type: DataTypes.UUID, allowNull: false },
        createdByUserId: { type: DataTypes.UUID, allowNull: false },
        updatedByUserId: { type: DataTypes.UUID, allowNull: true },
        structureId: { type: DataTypes.UUID, allowNull: true },
        patientId: { type: DataTypes.UUID, allowNull: true },
        noteId: { type: DataTypes.UUID, allowNull: true },
        agendaEventId: { type: DataTypes.UUID, allowNull: true },
        completedAt: { type: DataTypes.DATE, allowNull: true },
        snoozedUntil: { type: DataTypes.DATE, allowNull: true }
    },
    {
        sequelize,
        modelName: 'reminder',
        tableName: 'reminders',
        paranoid: true
    }
);

export default Reminder;
