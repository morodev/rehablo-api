import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database.js';

/** Explicit join table Tenant <-> User (instead of an implicit string-based `through`). */
export class TenantUser extends Model {}

TenantUser.init(
    {
        tenantId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
        userId: { type: DataTypes.UUID, allowNull: false, primaryKey: true }
    },
    { sequelize, modelName: 'tenantUser', tableName: 'tenant_users' }
);

export default TenantUser;

