import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { RoleCode } from '../rbac/roles.js';

/** Explicit join table Structure <-> User (instead of an implicit string-based `through`). */
export class StructureUser extends Model {
    declare structureId: string;
    declare userId: string;
    /**
     * Override OPZIONALE del ruolo per questa struttura.
     * `null` => vale il ruolo base definito su `tenant_users.role`.
     */
    declare role: RoleCode | null;
}

StructureUser.init(
    {
        structureId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
        userId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
        role: {
            type: DataTypes.ENUM(...Object.values(RoleCode)),
            allowNull: true,
            defaultValue: null
        }
    },
    { sequelize, modelName: 'structureUser', tableName: 'structure_users' }
);

export default StructureUser;

