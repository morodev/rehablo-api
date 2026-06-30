import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface AgendaEventExceptionAttributes {
    id: string;
    eventId?: string | null;
    exdate?: string | null;
}

export type AgendaEventExceptionCreationAttributes = Optional<AgendaEventExceptionAttributes, 'id'>;

/** Tenant-scoped model: always access through `AgendaEventException.schema(req.tenantSchema)`. */
export class AgendaEventException
    extends Model<AgendaEventExceptionAttributes, AgendaEventExceptionCreationAttributes>
    implements AgendaEventExceptionAttributes {
    declare id: string;
    declare eventId: string | null;
    declare exdate: string | null;
}

AgendaEventException.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        eventId: DataTypes.STRING,
        exdate: DataTypes.STRING
    },
    { sequelize, modelName: 'agendaEventException', tableName: 'agenda_event_exceptions' }
);

export default AgendaEventException;

