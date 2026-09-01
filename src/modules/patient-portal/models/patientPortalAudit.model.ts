import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface PatientPortalAuditAttributes {
    id: string;
    accessId: string;
    userId: string;
    patientId: string;
    action: string;
    resource: string;
    resourceId?: string | null;
    outcome: 'SUCCESS' | 'DENIED';
    ipAddress?: string | null;
    userAgent?: string | null;
    createdAt: Date;
}

export type PatientPortalAuditCreationAttributes = Optional<
    PatientPortalAuditAttributes,
    'id' | 'resourceId' | 'ipAddress' | 'userAgent' | 'createdAt'
>;

/** Log append-only nello schema del centro; non contiene mai payload clinici. */
export class PatientPortalAudit
    extends Model<PatientPortalAuditAttributes, PatientPortalAuditCreationAttributes>
    implements PatientPortalAuditAttributes {
    declare id: string;
    declare accessId: string;
    declare userId: string;
    declare patientId: string;
    declare action: string;
    declare resource: string;
    declare resourceId: string | null;
    declare outcome: 'SUCCESS' | 'DENIED';
    declare ipAddress: string | null;
    declare userAgent: string | null;
    declare createdAt: Date;
}

PatientPortalAudit.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        accessId: { type: DataTypes.UUID, allowNull: false },
        userId: { type: DataTypes.UUID, allowNull: false },
        patientId: { type: DataTypes.UUID, allowNull: false },
        action: { type: DataTypes.STRING(32), allowNull: false },
        resource: { type: DataTypes.STRING(48), allowNull: false },
        resourceId: { type: DataTypes.UUID, allowNull: true },
        outcome: { type: DataTypes.STRING(16), allowNull: false },
        ipAddress: { type: DataTypes.STRING(45), allowNull: true },
        userAgent: { type: DataTypes.STRING(255), allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
    },
    {
        sequelize,
        modelName: 'patientPortalAudit',
        tableName: 'patient_portal_audit_logs',
        updatedAt: false,
        indexes: [
            { fields: ['patientId', 'createdAt'] },
            { fields: ['userId', 'createdAt'] }
        ]
    }
);

export default PatientPortalAudit;
