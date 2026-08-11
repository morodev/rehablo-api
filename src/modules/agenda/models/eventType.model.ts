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
    linkedServiceId?: string | null;
    /**
     * Tipo proposto automaticamente quando si crea un appuntamento in agenda.
     *
     * Al massimo UNO per tenant: l'unicità è garantita lato server (vedi
     * `eventType.controller.ts`), non dal client, perché farla con più chiamate HTTP
     * significherebbe restare con due predefiniti se una delle due fallisse.
     */
    isDefault: boolean;
}

export type EventTypeCreationAttributes = Optional<
    EventTypeAttributes,
    'id' | 'icon' | 'duration' | 'color' | 'erasable' | 'editable' | 'isDefault'
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
    declare linkedServiceId: string | null;
    declare isDefault: boolean;
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
        editable: { type: DataTypes.BOOLEAN, defaultValue: true },
        linkedServiceId: { type: DataTypes.UUID, allowNull: true },
        isDefault: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false }
    },
    { sequelize, modelName: 'eventType', tableName: 'event_types' }
);

export default EventType;

