import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../../config/database.js';

export interface ProtocolPhaseTemplateAttributes {
    id: string;
    protocolTemplateId: string;
    name: string;
    order: number;
    durationDays?: number | null;
    goals?: string | null;
    progressionCriteria?: string | null;
}

export type ProtocolPhaseTemplateCreationAttributes = Optional<ProtocolPhaseTemplateAttributes, 'id' | 'order'>;

/**
 * A phase (e.g. "Fase acuta", "Fase di rinforzo", "Ritorno allo sport") belonging to a
 * `ProtocolTemplate`, ordered by `order`. `progressionCriteria` describes the clinical condition
 * needed to move on to the next phase (e.g. "ROM > 90°, dolore < 3/10").
 */
export class ProtocolPhaseTemplate
    extends Model<ProtocolPhaseTemplateAttributes, ProtocolPhaseTemplateCreationAttributes>
    implements ProtocolPhaseTemplateAttributes {
    declare id: string;
    declare protocolTemplateId: string;
    declare name: string;
    declare order: number;
    declare durationDays: number | null;
    declare goals: string | null;
    declare progressionCriteria: string | null;
}

ProtocolPhaseTemplate.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        protocolTemplateId: { type: DataTypes.UUID, allowNull: false },
        name: { type: DataTypes.STRING, allowNull: false },
        order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        durationDays: { type: DataTypes.INTEGER, allowNull: true },
        goals: { type: DataTypes.TEXT, allowNull: true },
        progressionCriteria: { type: DataTypes.TEXT, allowNull: true }
    },
    { sequelize, modelName: 'protocolPhaseTemplate', tableName: 'protocol_phase_templates', schema: 'public' }
);

export default ProtocolPhaseTemplate;

