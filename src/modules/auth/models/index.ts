import Tenant from './tenant.model.js';
import User from './user.model.js';
import Structure from './structure.model.js';
import StructureAvailability from './structureAvailability.model.js';
import UserAvailability from './userAvailability.model.js';
import TenantUser from './tenantUser.model.js';
import StructureUser from './structureUser.model.js';

/** Centralised associations for the auth/tenant domain (mirrors former rehab-authentication.js). */
export function registerAuthAssociations(): void {
    Tenant.belongsToMany(User, { through: TenantUser, foreignKey: 'tenantId', otherKey: 'userId' });
    User.belongsToMany(Tenant, { through: TenantUser, foreignKey: 'userId', otherKey: 'tenantId' });

    Tenant.hasMany(Structure);
    Structure.belongsTo(Tenant);

    Structure.belongsToMany(User, { through: StructureUser, foreignKey: 'structureId', otherKey: 'userId' });
    User.belongsToMany(Structure, { through: StructureUser, foreignKey: 'userId', otherKey: 'structureId' });

    Structure.hasMany(StructureAvailability);
    StructureAvailability.belongsTo(Structure);

    User.hasMany(UserAvailability);
    UserAvailability.belongsTo(User);
}

export async function syncAuthModels(): Promise<void> {
    await Tenant.sync({ alter: true });
    await User.sync({ alter: true });
    await UserAvailability.sync({ alter: true });
    await Structure.sync({ alter: true });
    await StructureAvailability.sync({ alter: true });
    await TenantUser.sync({ alter: true });
    await StructureUser.sync({ alter: true });
}

export { Tenant, User, Structure, StructureAvailability, UserAvailability, TenantUser, StructureUser };

