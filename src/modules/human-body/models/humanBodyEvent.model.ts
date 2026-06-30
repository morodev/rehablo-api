import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface HumanBodyEventAttributes {
    id: string;
    humanBodyPointId: string;
    eventType: string;
}

export type HumanBodyEventCreationAttributes = Optional<HumanBodyEventAttributes, 'id'>;

/** Tenant-scoped model: always access through `HumanBodyEvent.schema(req.tenantSchema)`. */
export class HumanBodyEvent
    extends Model<HumanBodyEventAttributes, HumanBodyEventCreationAttributes>
    implements HumanBodyEventAttributes {
    declare id: string;
    declare humanBodyPointId: string;
    declare eventType: string;
}

HumanBodyEvent.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        humanBodyPointId: { type: DataTypes.UUID, allowNull: false },
        eventType: { type: DataTypes.STRING, allowNull: false }
    },
    { sequelize, modelName: 'humanBodyEvent', tableName: 'human_body_events' }
);

export default HumanBodyEvent;

