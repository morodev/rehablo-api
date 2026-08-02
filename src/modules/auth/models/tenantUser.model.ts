import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { DEFAULT_ROLE, RoleCode } from '../rbac/roles.js';

/** Explicit join table Tenant <-> User (instead of an implicit string-based `through`). */
export class TenantUser extends Model {
    declare tenantId: string;
    declare userId: string;
    /** Ruolo BASE dell'utente all'interno del tenant (override per struttura su StructureUser). */
    declare role: RoleCode;
}

TenantUser.init(
    {
        tenantId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
        userId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
        role: {
            type: DataTypes.ENUM(...Object.values(RoleCode)),
            allowNull: false,
            defaultValue: DEFAULT_ROLE
        }
    },
    { sequelize, modelName: 'tenantUser', tableName: 'tenant_users' }
);

export default TenantUser;

