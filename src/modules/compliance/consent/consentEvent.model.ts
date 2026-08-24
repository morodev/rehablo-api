import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export type ConsentType = 'privacy' | 'sts_opposition' | 'fse_feeding' | 'fse_viewing';

export interface ConsentEventAttributes {
    id: string;
    tenantId: string;
    patientId: string;
    operatorId?: string | null;
    type: ConsentType;
    value: boolean;
    previousValue?: boolean | null;
    policyVersion?: string | null;
    source: string;
    occurredAt: Date;
    metadata?: Record<string, unknown> | null;
}

export type ConsentEventCreationAttributes = Optional<
    ConsentEventAttributes,
    'id' | 'operatorId' | 'previousValue' | 'policyVersion' | 'source' | 'occurredAt' | 'metadata'
>;

export class ConsentEvent
    extends Model<ConsentEventAttributes, ConsentEventCreationAttributes>
    implements ConsentEventAttributes {
    declare id: string;
    declare tenantId: string;
    declare patientId: string;
    declare operatorId: string | null;
    declare type: ConsentType;
    declare value: boolean;
    declare previousValue: boolean | null;
    declare policyVersion: string | null;
    declare source: string;
    declare occurredAt: Date;
    declare metadata: Record<string, unknown> | null;
}

ConsentEvent.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        tenantId: { type: DataTypes.UUID, allowNull: false },
        patientId: { type: DataTypes.UUID, allowNull: false },
        operatorId: { type: DataTypes.UUID, allowNull: true },
        type: { type: DataTypes.STRING(40), allowNull: false },
        value: { type: DataTypes.BOOLEAN, allowNull: false },
        previousValue: { type: DataTypes.BOOLEAN, allowNull: true },
        policyVersion: { type: DataTypes.STRING, allowNull: true },
        source: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'operator' },
        occurredAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        metadata: { type: DataTypes.JSONB, allowNull: true }
    },
    {
        sequelize,
        modelName: 'consentEvent',
        tableName: 'consent_events',
        indexes: [
            { fields: ['tenantId', 'patientId'] },
            { fields: ['tenantId', 'type'] },
            { fields: ['tenantId', 'patientId', 'type'] }
        ]
    }
);

export default ConsentEvent;
