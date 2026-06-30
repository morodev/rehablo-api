import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database.js';

/** Explicit join table Structure <-> User (instead of an implicit string-based `through`). */
export class StructureUser extends Model {}

StructureUser.init(
    {
        structureId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
        userId: { type: DataTypes.UUID, allowNull: false, primaryKey: true }
    },
    { sequelize, modelName: 'structureUser', tableName: 'structure_users' }
);

export default StructureUser;

