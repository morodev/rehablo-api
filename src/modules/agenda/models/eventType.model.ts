import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface EventTypeAttributes {
    id: string;
    title: string;
    description?: string | null;
    price?: number | null;
    icon: string;
    duration: number;
    color: string;
    erasable: boolean;
    editable: boolean;
}

export type EventTypeCreationAttributes = Optional<
    EventTypeAttributes,
    'id' | 'icon' | 'duration' | 'color' | 'erasable' | 'editable'
>;

/** Tenant-scoped model: always access through `EventType.schema(req.tenantSchema)`. */
export class EventType extends Model<EventTypeAttributes, EventTypeCreationAttributes> implements EventTypeAttributes {
    declare id: string;
    declare title: string;
    declare description: string | null;
    declare price: number | null;
    declare icon: string;
    declare duration: number;
    declare color: string;
    declare erasable: boolean;
    declare editable: boolean;
}

EventType.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        title: { type: DataTypes.STRING, allowNull: false },
        description: DataTypes.STRING,
        price: DataTypes.INTEGER,
        icon: { type: DataTypes.STRING, defaultValue: 'event' },
        duration: { type: DataTypes.INTEGER, defaultValue: 60, allowNull: false },
        color: { type: DataTypes.STRING, defaultValue: 'text-green-500' },
        erasable: { type: DataTypes.BOOLEAN, defaultValue: true },
        editable: { type: DataTypes.BOOLEAN, defaultValue: true }
    },
    { sequelize, modelName: 'eventType', tableName: 'event_types' }
);

export default EventType;

