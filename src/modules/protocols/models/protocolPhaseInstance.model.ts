import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export type ProtocolPhaseInstanceStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';

export interface ProtocolPhaseInstanceAttributes {
    id: string;
    protocolInstanceId: string;
    protocolPhaseTemplateId: string;
    startDate?: Date | null;
    endDate?: Date | null;
    status: ProtocolPhaseInstanceStatus;
    progressionNotes?: string | null;
}

export type ProtocolPhaseInstanceCreationAttributes = Optional<ProtocolPhaseInstanceAttributes, 'id' | 'status'>;

/**
 * Tenant-scoped model: tracks a patient's progress through one phase of the assigned protocol
 * (references the public-schema `ProtocolPhaseTemplate`). One row per phase of the template is
 * created when the protocol is assigned, so the whole history of progression is kept.
 */
export class ProtocolPhaseInstance
    extends Model<ProtocolPhaseInstanceAttributes, ProtocolPhaseInstanceCreationAttributes>
    implements ProtocolPhaseInstanceAttributes {
    declare id: string;
    declare protocolInstanceId: string;
    declare protocolPhaseTemplateId: string;
    declare startDate: Date | null;
    declare endDate: Date | null;
    declare status: ProtocolPhaseInstanceStatus;
    declare progressionNotes: string | null;
}

ProtocolPhaseInstance.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        protocolInstanceId: { type: DataTypes.UUID, allowNull: false },
        protocolPhaseTemplateId: { type: DataTypes.UUID, allowNull: false },
        startDate: { type: DataTypes.DATEONLY, allowNull: true },
        endDate: { type: DataTypes.DATEONLY, allowNull: true },
        status: {
            type: DataTypes.ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED'),
            allowNull: false,
            defaultValue: 'PENDING'
        },
        progressionNotes: { type: DataTypes.TEXT, allowNull: true }
    },
    { sequelize, modelName: 'protocolPhaseInstance', tableName: 'protocol_phase_instances' }
);

export default ProtocolPhaseInstance;

