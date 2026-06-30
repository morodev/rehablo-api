import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface StructureAvailabilityAttributes {
    id: string;
    day: number;
    enabled: boolean | null;
    open: string | null;
    close: string | null;
    structureId: string;
}

export type StructureAvailabilityCreationAttributes = Optional<StructureAvailabilityAttributes, 'id'>;

export class StructureAvailability
    extends Model<StructureAvailabilityAttributes, StructureAvailabilityCreationAttributes>
    implements StructureAvailabilityAttributes {
    declare id: string;
    declare day: number;
    declare enabled: boolean | null;
    declare open: string | null;
    declare close: string | null;
    declare structureId: string;
}

StructureAvailability.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        day: { type: DataTypes.INTEGER, allowNull: false },
        enabled: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
        open: { type: DataTypes.TIME, allowNull: true },
        close: { type: DataTypes.TIME, allowNull: true },
        structureId: { type: DataTypes.UUID, allowNull: false }
    },
    { sequelize, modelName: 'structureAvailability', tableName: 'structure_availabilities' }
);

export default StructureAvailability;

