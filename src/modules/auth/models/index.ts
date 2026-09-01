import Tenant from './tenant.model.js';
import User from './user.model.js';
import Structure from './structure.model.js';
import StructureAvailability from './structureAvailability.model.js';
import UserAvailability from './userAvailability.model.js';
import TenantUser from './tenantUser.model.js';
import StructureUser from './structureUser.model.js';
import RefreshToken from './refreshToken.model.js';
import UserEmail, { normalizeIdentityEmail } from './userEmail.model.js';
import PatientPortalAccess from './patientPortalAccess.model.js';
import PatientPortalInvitation from './patientPortalInvitation.model.js';

/** Centralised associations for the auth/tenant domain (mirrors former rehab-authentication.js). */
export function registerAuthAssociations(): void {
    Tenant.belongsToMany(User, { through: TenantUser, foreignKey: 'tenantId', otherKey: 'userId' });
    User.belongsToMany(Tenant, { through: TenantUser, foreignKey: 'userId', otherKey: 'tenantId' });

    Tenant.hasMany(Structure);
    Structure.belongsTo(Tenant);

    Structure.belongsToMany(User, { through: StructureUser, foreignKey: 'structureId', otherKey: 'userId' });
    User.belongsToMany(Structure, { through: StructureUser, foreignKey: 'userId', otherKey: 'structureId' });

    User.hasMany(UserEmail, { foreignKey: 'userId', onDelete: 'cascade', hooks: true });
    UserEmail.belongsTo(User, { foreignKey: 'userId' });

    User.hasMany(PatientPortalAccess, { foreignKey: 'userId', onDelete: 'cascade', hooks: true });
    PatientPortalAccess.belongsTo(User, { foreignKey: 'userId' });
    Tenant.hasMany(PatientPortalAccess, { foreignKey: 'tenantId', onDelete: 'cascade', hooks: true });
    PatientPortalAccess.belongsTo(Tenant, { foreignKey: 'tenantId' });

    Tenant.hasMany(PatientPortalInvitation, { foreignKey: 'tenantId', onDelete: 'cascade', hooks: true });
    PatientPortalInvitation.belongsTo(Tenant, { foreignKey: 'tenantId' });

    Structure.hasMany(StructureAvailability);
    StructureAvailability.belongsTo(Structure);

    User.hasMany(UserAvailability);
    UserAvailability.belongsTo(User);

    // Mantiene il mirror dell'email primaria anche per i flussi legacy che creano direttamente User.
    User.addHook('afterCreate', 'syncPrimaryIdentityEmail', async (user: User, options: any) => {
        const email = user.get('email') as string;
        const normalizedEmail = normalizeIdentityEmail(email);
        if (!normalizedEmail) return;
        await UserEmail.findOrCreate({
            where: { normalizedEmail },
            defaults: {
                userId: user.get('id') as string,
                email: email.trim(),
                normalizedEmail,
                isPrimary: true,
                verifiedAt: user.get('isActive') ? new Date() : null
            },
            transaction: options.transaction
        });
    });
}

export async function syncAuthModels(): Promise<void> {
    await Tenant.sync({ alter: true });
    await User.sync({ alter: true });
    await UserEmail.sync({ alter: true });
    await UserAvailability.sync({ alter: true });
    await Structure.sync({ alter: true });
    await StructureAvailability.sync({ alter: true });
    await TenantUser.sync({ alter: true });
    await StructureUser.sync({ alter: true });
    await RefreshToken.sync({ alter: true });
    await PatientPortalAccess.sync({ alter: true });
    await PatientPortalInvitation.sync({ alter: true });

    // Backfill idempotente per gli account creati prima dell'introduzione degli alias.
    const users = await User.findAll({ attributes: ['id', 'email', 'isActive'] });
    if (users.length > 0) {
        await UserEmail.bulkCreate(
            users
                .map((user) => {
                    const email = user.get('email') as string;
                    return {
                        userId: user.get('id') as string,
                        email,
                        normalizedEmail: normalizeIdentityEmail(email),
                        isPrimary: true,
                        verifiedAt: user.get('isActive') ? new Date() : null
                    };
                })
                .filter((entry) => !!entry.normalizedEmail),
            { ignoreDuplicates: true }
        );
    }
}

export {
    Tenant,
    User,
    Structure,
    StructureAvailability,
    UserAvailability,
    TenantUser,
    StructureUser,
    RefreshToken,
    UserEmail,
    PatientPortalAccess,
    PatientPortalInvitation
};

