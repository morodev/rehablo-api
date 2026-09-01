import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface PatientPortalInvitationAttributes {
    id: string;
    tenantId: string;
    patientId: string;
    email: string;
    normalizedEmail: string;
    tokenHash: string;
    invitedByUserId: string;
    expiresAt: Date;
    acceptedAt?: Date | null;
    invalidatedAt?: Date | null;
}

export type PatientPortalInvitationCreationAttributes = Optional<
    PatientPortalInvitationAttributes,
    'id' | 'acceptedAt' | 'invalidatedAt'
>;

/** Token di invito al portale: si persiste esclusivamente l'hash SHA-256. */
export class PatientPortalInvitation
    extends Model<PatientPortalInvitationAttributes, PatientPortalInvitationCreationAttributes>
    implements PatientPortalInvitationAttributes {
    declare id: string;
    declare tenantId: string;
    declare patientId: string;
    declare email: string;
    declare normalizedEmail: string;
    declare tokenHash: string;
    declare invitedByUserId: string;
    declare expiresAt: Date;
    declare acceptedAt: Date | null;
    declare invalidatedAt: Date | null;
}

PatientPortalInvitation.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenantId: { type: DataTypes.UUID, allowNull: false },
        patientId: { type: DataTypes.UUID, allowNull: false },
        email: { type: DataTypes.STRING, allowNull: false },
        normalizedEmail: { type: DataTypes.STRING, allowNull: false },
        tokenHash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
        invitedByUserId: { type: DataTypes.UUID, allowNull: false },
        expiresAt: { type: DataTypes.DATE, allowNull: false },
        acceptedAt: { type: DataTypes.DATE, allowNull: true },
        invalidatedAt: { type: DataTypes.DATE, allowNull: true }
    },
    {
        sequelize,
        modelName: 'patientPortalInvitation',
        tableName: 'patient_portal_invitations',
        indexes: [
            { fields: ['tenantId', 'patientId'] },
            { fields: ['expiresAt'] }
        ]
    }
);

export default PatientPortalInvitation;
