import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface ProtocolExerciseLogAttributes {
    id: string;
    protocolPhaseInstanceId: string;
    protocolTemplateExerciseId: string;
    date: Date;
    completed: boolean;
    setsCompleted?: number | null;
    repsCompleted?: number | null;
    painLevel?: number | null;
    difficultyLevel?: number | null;
    notes?: string | null;
}

export type ProtocolExerciseLogCreationAttributes = Optional<
    ProtocolExerciseLogAttributes,
    'id' | 'date' | 'completed'
>;

/**
 * Tenant-scoped model: a single day's execution log of a prescribed exercise (references the
 * public-schema `ProtocolTemplateExercise`), used to track patient adherence and reported
 * pain/difficulty over time.
 */
export class ProtocolExerciseLog
    extends Model<ProtocolExerciseLogAttributes, ProtocolExerciseLogCreationAttributes>
    implements ProtocolExerciseLogAttributes {
    declare id: string;
    declare protocolPhaseInstanceId: string;
    declare protocolTemplateExerciseId: string;
    declare date: Date;
    declare completed: boolean;
    declare setsCompleted: number | null;
    declare repsCompleted: number | null;
    declare painLevel: number | null;
    declare difficultyLevel: number | null;
    declare notes: string | null;
}

ProtocolExerciseLog.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        protocolPhaseInstanceId: { type: DataTypes.UUID, allowNull: false },
        protocolTemplateExerciseId: { type: DataTypes.UUID, allowNull: false },
        date: { type: DataTypes.DATEONLY, allowNull: false, defaultValue: DataTypes.NOW },
        completed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        setsCompleted: { type: DataTypes.INTEGER, allowNull: true },
        repsCompleted: { type: DataTypes.INTEGER, allowNull: true },
        painLevel: { type: DataTypes.INTEGER, allowNull: true },
        difficultyLevel: { type: DataTypes.INTEGER, allowNull: true },
        notes: { type: DataTypes.TEXT, allowNull: true }
    },
    { sequelize, modelName: 'protocolExerciseLog', tableName: 'protocol_exercise_logs' }
);

export default ProtocolExerciseLog;

