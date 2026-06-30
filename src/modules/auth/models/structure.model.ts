import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface StructureAttributes {
    id: string;
    name?: string | null;
    address?: string | null;
    tenantId: string;
}

export type StructureCreationAttributes = Optional<StructureAttributes, 'id'>;

export class Structure extends Model<StructureAttributes, StructureCreationAttributes> implements StructureAttributes {
    declare id: string;
    declare name: string | null;
    declare address: string | null;
    declare tenantId: string;
}

Structure.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        name: { type: DataTypes.STRING, allowNull: true },
        address: { type: DataTypes.STRING, allowNull: true },
        tenantId: { type: DataTypes.UUID, allowNull: false }
    },
    { sequelize, modelName: 'structure', tableName: 'structures' }
);

export default Structure;

