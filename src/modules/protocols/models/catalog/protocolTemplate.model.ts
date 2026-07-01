import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../../config/database.js';

export interface ProtocolTemplateAttributes {
    id: string;
    name: string;
    description?: string | null;
    pathology?: string | null;
    category?: string | null;
    bodyDistricts?: string[] | null;
    isFullBody: boolean;
    totalDurationDays?: number | null;
}

export type ProtocolTemplateCreationAttributes = Optional<
    ProtocolTemplateAttributes,
    'id' | 'isFullBody' | 'bodyDistricts'
>;

/**
 * Global catalog of reusable rehabilitation protocol templates (e.g. "Protocollo post-ricostruzione LCA"),
 * shared across every tenant. Lives in the "public" schema; a therapist "assigns" it to a patient by
 * creating a `ProtocolInstance` (tenant-scoped), mirroring the `Scale` -> `UserScaleInstance` pattern.
 */
export class ProtocolTemplate
    extends Model<ProtocolTemplateAttributes, ProtocolTemplateCreationAttributes>
    implements ProtocolTemplateAttributes {
    declare id: string;
    declare name: string;
    declare description: string | null;
    declare pathology: string | null;
    declare category: string | null;
    declare bodyDistricts: string[] | null;
    declare isFullBody: boolean;
    declare totalDurationDays: number | null;
}

ProtocolTemplate.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        name: { type: DataTypes.STRING, allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        pathology: { type: DataTypes.STRING, allowNull: true },
        category: { type: DataTypes.STRING, allowNull: true },
        bodyDistricts: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: true, defaultValue: [] },
        isFullBody: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        totalDurationDays: { type: DataTypes.INTEGER, allowNull: true }
    },
    { sequelize, modelName: 'protocolTemplate', tableName: 'protocol_templates', schema: 'public' }
);

export default ProtocolTemplate;

