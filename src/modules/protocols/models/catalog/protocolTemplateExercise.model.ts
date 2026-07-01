import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../../config/database.js';

export interface ProtocolTemplateExerciseAttributes {
    id: string;
    protocolPhaseTemplateId: string;
    exerciseId: string;
    order: number;
    sets?: number | null;
    reps?: number | null;
    durationSeconds?: number | null;
    frequencyPerWeek?: number | null;
    notes?: string | null;
}

export type ProtocolTemplateExerciseCreationAttributes = Optional<
    ProtocolTemplateExerciseAttributes,
    'id' | 'order'
>;

/**
 * Join entity: prescribes an `Exercise` from the catalog within a `ProtocolPhaseTemplate`,
 * carrying the standard parameters (sets/reps/duration/weekly frequency) suggested by the template.
 */
export class ProtocolTemplateExercise
    extends Model<ProtocolTemplateExerciseAttributes, ProtocolTemplateExerciseCreationAttributes>
    implements ProtocolTemplateExerciseAttributes {
    declare id: string;
    declare protocolPhaseTemplateId: string;
    declare exerciseId: string;
    declare order: number;
    declare sets: number | null;
    declare reps: number | null;
    declare durationSeconds: number | null;
    declare frequencyPerWeek: number | null;
    declare notes: string | null;
}

ProtocolTemplateExercise.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        protocolPhaseTemplateId: { type: DataTypes.UUID, allowNull: false },
        exerciseId: { type: DataTypes.UUID, allowNull: false },
        order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        sets: { type: DataTypes.INTEGER, allowNull: true },
        reps: { type: DataTypes.INTEGER, allowNull: true },
        durationSeconds: { type: DataTypes.INTEGER, allowNull: true },
        frequencyPerWeek: { type: DataTypes.INTEGER, allowNull: true },
        notes: { type: DataTypes.TEXT, allowNull: true }
    },
    {
        sequelize,
        modelName: 'protocolTemplateExercise',
        tableName: 'protocol_template_exercises',
        schema: 'public'
    }
);

export default ProtocolTemplateExercise;

