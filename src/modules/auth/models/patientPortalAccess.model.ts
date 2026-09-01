import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export const PATIENT_PORTAL_ACCESS_STATUSES = ['ACTIVE', 'HISTORICAL', 'REVOKED'] as const;
export type PatientPortalAccessStatus = (typeof PATIENT_PORTAL_ACCESS_STATUSES)[number];

export interface PatientPortalAccessAttributes {
    id: string;
    userId: string;
    tenantId: string;
    /** UUID del record nello schema dinamico del tenant. */
    patientId: string;
    relationship: 'SELF';
    status: PatientPortalAccessStatus;
    acceptedAt: Date;
    historicalAt?: Date | null;
    revokedAt?: Date | null;
    revokedByUserId?: string | null;
    lastAccessAt?: Date | null;
}

export type PatientPortalAccessCreationAttributes = Optional<
    PatientPortalAccessAttributes,
    'id' | 'relationship' | 'status' | 'acceptedAt' | 'historicalAt' | 'revokedAt' | 'revokedByUserId' | 'lastAccessAt'
>;

/**
 * Collega l'identità globale alla cartella locale di un solo tenant.
 * Non è una TenantUser: i pazienti non fanno parte del team e non consumano licenze staff.
 */
export class PatientPortalAccess
    extends Model<PatientPortalAccessAttributes, PatientPortalAccessCreationAttributes>
    implements PatientPortalAccessAttributes {
    declare id: string;
    declare userId: string;
    declare tenantId: string;
    declare patientId: string;
    declare relationship: 'SELF';
    declare status: PatientPortalAccessStatus;
    declare acceptedAt: Date;
    declare historicalAt: Date | null;
    declare revokedAt: Date | null;
    declare revokedByUserId: string | null;
    declare lastAccessAt: Date | null;
}

PatientPortalAccess.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        userId: { type: DataTypes.UUID, allowNull: false },
        tenantId: { type: DataTypes.UUID, allowNull: false },
        patientId: { type: DataTypes.UUID, allowNull: false },
        relationship: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'SELF' },
        status: {
            type: DataTypes.ENUM(...PATIENT_PORTAL_ACCESS_STATUSES),
            allowNull: false,
            defaultValue: 'ACTIVE'
        },
        acceptedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        historicalAt: { type: DataTypes.DATE, allowNull: true },
        revokedAt: { type: DataTypes.DATE, allowNull: true },
        revokedByUserId: { type: DataTypes.UUID, allowNull: true },
        lastAccessAt: { type: DataTypes.DATE, allowNull: true }
    },
    {
        sequelize,
        modelName: 'patientPortalAccess',
        tableName: 'patient_portal_accesses',
        indexes: [
            { fields: ['userId', 'status'] },
            {
                name: 'patient_portal_access_self_unique',
                unique: true,
                fields: ['tenantId', 'patientId', 'relationship']
            }
        ]
    }
);

export default PatientPortalAccess;
