import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface EventTypeStructureAttributes {
    eventTypeId: string;
    structureId: string;
    isDefault: boolean;
}

type EventTypeStructureCreationAttributes = Optional<EventTypeStructureAttributes, 'isDefault'>;

export class EventTypeStructure extends Model<
    EventTypeStructureAttributes,
    EventTypeStructureCreationAttributes
> implements EventTypeStructureAttributes {
    declare eventTypeId: string;
    declare structureId: string;
    declare isDefault: boolean;
}

EventTypeStructure.init(
    {
        eventTypeId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
        structureId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
        isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
    },
    {
        sequelize,
        modelName: 'eventTypeStructure',
        tableName: 'event_type_structures',
        indexes: [
            {name: 'event_type_structures_structure_id', fields: ['structureId']},
            {
                name: 'event_type_structures_one_default_per_structure',
                unique: true,
                fields: ['structureId'],
                where: {isDefault: true}
            }
        ]
    }
);

export default EventTypeStructure;
