import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export type EvaluationStatus = 'DRAFT' | 'COMPLETED';

export interface EvaluationAttributes {
    id: string;
    patientId: string;
    userId: string;
    date: Date;
    title?: string | null;
    notes?: string | null;
    status: EvaluationStatus;
}

export type EvaluationCreationAttributes = Optional<EvaluationAttributes, 'id' | 'date' | 'status'>;

/**
 * Tenant-scoped model: a single clinical "valutazione" (assessment) session for a patient.
 * Groups together, under a single `evaluationId`, everything gathered during that session:
 * symptoms, articularities, strengths, compiled questionnaires, compiled scales and tests.
 * Always access through `Evaluation.schema(req.tenantSchema)`.
 */
export class Evaluation
    extends Model<EvaluationAttributes, EvaluationCreationAttributes>
    implements EvaluationAttributes {
    declare id: string;
    declare patientId: string;
    declare userId: string;
    declare date: Date;
    declare title: string | null;
    declare notes: string | null;
    declare status: EvaluationStatus;
}

Evaluation.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        patientId: { type: DataTypes.UUID, allowNull: false },
        userId: { type: DataTypes.UUID, allowNull: false },
        date: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        title: { type: DataTypes.STRING, allowNull: true },
        notes: { type: DataTypes.TEXT, allowNull: true },
        status: {
            type: DataTypes.ENUM('DRAFT', 'COMPLETED'),
            allowNull: false,
            defaultValue: 'COMPLETED'
        }
    },
    { sequelize, modelName: 'evaluation', tableName: 'evaluations' }
);

export default Evaluation;

