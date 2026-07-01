import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export type ProtocolInstanceStatus = 'ACTIVE' | 'COMPLETED' | 'SUSPENDED';

export interface ProtocolInstanceAttributes {
    id: string;
    patientId: string;
    userId?: string | null;
    protocolTemplateId: string;
    startDate: Date;
    endDate?: Date | null;
    status: ProtocolInstanceStatus;
    notes?: string | null;
}

export type ProtocolInstanceCreationAttributes = Optional<
    ProtocolInstanceAttributes,
    'id' | 'startDate' | 'status'
>;

/**
 * Tenant-scoped model: records that a given `ProtocolTemplate` (public-schema catalog) has been
 * assigned to a specific patient. Always access through `ProtocolInstance.schema(req.tenantSchema)`.
 * Mirrors `UserScaleInstance` in the human-body module.
 */
export class ProtocolInstance
    extends Model<ProtocolInstanceAttributes, ProtocolInstanceCreationAttributes>
    implements ProtocolInstanceAttributes {
    declare id: string;
    declare patientId: string;
    declare userId: string | null;
    declare protocolTemplateId: string;
    declare startDate: Date;
    declare endDate: Date | null;
    declare status: ProtocolInstanceStatus;
    declare notes: string | null;
}

ProtocolInstance.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        patientId: { type: DataTypes.UUID, allowNull: false },
        userId: { type: DataTypes.UUID, allowNull: true },
        protocolTemplateId: { type: DataTypes.UUID, allowNull: false },
        startDate: { type: DataTypes.DATEONLY, allowNull: false, defaultValue: DataTypes.NOW },
        endDate: { type: DataTypes.DATEONLY, allowNull: true },
        status: {
            type: DataTypes.ENUM('ACTIVE', 'COMPLETED', 'SUSPENDED'),
            allowNull: false,
            defaultValue: 'ACTIVE'
        },
        notes: { type: DataTypes.TEXT, allowNull: true }
    },
    { sequelize, modelName: 'protocolInstance', tableName: 'protocol_instances' }
);

export default ProtocolInstance;

