import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export type EvaluationStatus = 'DRAFT' | 'COMPLETED';

export interface EvaluationAttributes {
    id: string;
    patientId: string;
    userId: string;
    // Struttura (sede) in cui è stata svolta la valutazione. Fondamentale in un contesto
    // multi-tenant/multi-struttura/multi-regione: è QUESTO il campo da cui risalire alla
    // Regione (`Structure.region`) per instradare correttamente l'invio al FSE regionale
    // (vedi `modules/compliance/fse`), invece di assumere una singola regione per tenant.
    // Se assente, si può ricadere sulla struttura di riferimento del paziente (`Patient.structureId`).
    structureId?: string | null;
    date: Date;
    title?: string | null;
    notes?: string | null;
    status: EvaluationStatus;
    /**
     * Valutazione da cui questa è stata DERIVATA (FASE E, "Duplica in nuova valutazione"). Una
     * `COMPLETED` è immutabile: per modificarla si crea una nuova `DRAFT` che copia i suoi dati e ne
     * riferisce l'origine qui. Nullable per le valutazioni create ex-novo.
     */
    parentEvaluationId?: string | null;
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
    declare structureId: string | null;
    declare date: Date;
    declare title: string | null;
    declare notes: string | null;
    declare status: EvaluationStatus;
    declare parentEvaluationId: string | null;
}

Evaluation.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        patientId: { type: DataTypes.UUID, allowNull: false },
        userId: { type: DataTypes.UUID, allowNull: false },
        structureId: { type: DataTypes.UUID, allowNull: true },
        date: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        title: { type: DataTypes.STRING, allowNull: true },
        notes: { type: DataTypes.TEXT, allowNull: true },
        status: {
            type: DataTypes.ENUM('DRAFT', 'COMPLETED'),
            allowNull: false,
            defaultValue: 'COMPLETED'
        },
        parentEvaluationId: { type: DataTypes.UUID, allowNull: true }
    },
    { sequelize, modelName: 'evaluation', tableName: 'evaluations' }
);

export default Evaluation;

