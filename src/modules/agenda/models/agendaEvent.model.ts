import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface AgendaEventAttributes {
    id: string;
    calendarId?: string | null;
    recurringEventId?: string | null;
    isFirstInstance?: boolean | null;
    title?: string | null;
    patient?: Record<string, unknown> | null;
    description?: string | null;
    start?: string | null;
    end?: string | null;
    allDay?: boolean | null;
    recurrence?: string | null;
    duration?: string | null;
    status?: string | null;
    erasable?: boolean | null;
    eventTypeId?: string | null;
}

export type AgendaEventCreationAttributes = Optional<AgendaEventAttributes, 'id'>;

/** Tenant-scoped model: always access through `AgendaEvent.schema(req.tenantSchema)`. */
export class AgendaEvent
    extends Model<AgendaEventAttributes, AgendaEventCreationAttributes>
    implements AgendaEventAttributes {
    declare id: string;
    declare calendarId: string | null;
    declare recurringEventId: string | null;
    declare isFirstInstance: boolean | null;
    declare title: string | null;
    declare patient: Record<string, unknown> | null;
    declare description: string | null;
    declare start: string | null;
    declare end: string | null;
    declare allDay: boolean | null;
    declare recurrence: string | null;
    declare duration: string | null;
    declare status: string | null;
    declare erasable: boolean | null;
    declare eventTypeId: string | null;
}

AgendaEvent.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        calendarId: DataTypes.STRING,
        recurringEventId: { type: DataTypes.STRING, allowNull: true },
        isFirstInstance: DataTypes.BOOLEAN,
        title: DataTypes.STRING,
        patient: DataTypes.JSON,
        description: DataTypes.STRING,
        start: { type: DataTypes.STRING, allowNull: true },
        end: { type: DataTypes.STRING, allowNull: true },
        allDay: DataTypes.BOOLEAN,
        recurrence: DataTypes.STRING,
        duration: DataTypes.STRING,
        status: DataTypes.STRING,
        erasable: { type: DataTypes.BOOLEAN, defaultValue: true },
        eventTypeId: { type: DataTypes.UUID, allowNull: true }
    },
    { sequelize, modelName: 'agendaEvent', tableName: 'agenda_events' }
);

export default AgendaEvent;

