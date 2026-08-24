import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface AuditLogAttributes {
    id: string;
    tenantId: string;
    actorId?: string | null;
    action: string;
    resource: string;
    resourceId?: string | null;
    patientId?: string | null;
    metadata?: Record<string, unknown> | null;
    ipAddress?: string | null;
    userAgent?: string | null;
}

export type AuditLogCreationAttributes = Optional<
    AuditLogAttributes,
    'id' | 'actorId' | 'resourceId' | 'patientId' | 'metadata' | 'ipAddress' | 'userAgent'
>;

export class AuditLog
    extends Model<AuditLogAttributes, AuditLogCreationAttributes>
    implements AuditLogAttributes {
    declare id: string;
    declare tenantId: string;
    declare actorId: string | null;
    declare action: string;
    declare resource: string;
    declare resourceId: string | null;
    declare patientId: string | null;
    declare metadata: Record<string, unknown> | null;
    declare ipAddress: string | null;
    declare userAgent: string | null;
}

AuditLog.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        tenantId: { type: DataTypes.UUID, allowNull: false },
        actorId: { type: DataTypes.UUID, allowNull: true },
        action: { type: DataTypes.STRING(80), allowNull: false },
        resource: { type: DataTypes.STRING(80), allowNull: false },
        resourceId: { type: DataTypes.UUID, allowNull: true },
        patientId: { type: DataTypes.UUID, allowNull: true },
        metadata: { type: DataTypes.JSONB, allowNull: true },
        ipAddress: { type: DataTypes.STRING(45), allowNull: true },
        userAgent: { type: DataTypes.STRING(255), allowNull: true }
    },
    {
        sequelize,
        modelName: 'auditLog',
        tableName: 'audit_logs',
        indexes: [
            { fields: ['tenantId', 'resource', 'resourceId'] },
            { fields: ['tenantId', 'patientId'] },
            { fields: ['tenantId', 'action'] }
        ]
    }
);

export default AuditLog;
