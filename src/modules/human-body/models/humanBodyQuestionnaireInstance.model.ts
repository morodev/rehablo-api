import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface HumanBodyQuestionnaireInstanceAttributes {
    id: string;
    userId?: string | null;
    patientId?: string | null;
    evaluationId?: string | null;
    humanBodyPointId?: string | null;
    humanBodyQuestionnaireId: string;
}

export type HumanBodyQuestionnaireInstanceCreationAttributes = Optional<HumanBodyQuestionnaireInstanceAttributes, 'id'>;

/**
 * Tenant-scoped model: a patient's compiled instance of a custom `HumanBodyQuestionnaire`.
 * Always access through `HumanBodyQuestionnaireInstance.schema(req.tenantSchema)`.
 */
export class HumanBodyQuestionnaireInstance
    extends Model<HumanBodyQuestionnaireInstanceAttributes, HumanBodyQuestionnaireInstanceCreationAttributes>
    implements HumanBodyQuestionnaireInstanceAttributes {
    declare id: string;
    declare userId: string | null;
    declare patientId: string | null;
    declare evaluationId: string | null;
    declare humanBodyPointId: string | null;
    declare humanBodyQuestionnaireId: string;
}

HumanBodyQuestionnaireInstance.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        userId: { type: DataTypes.UUID, allowNull: true },
        patientId: { type: DataTypes.UUID, allowNull: true },
        evaluationId: { type: DataTypes.UUID, allowNull: true },
        // Links this completed questionnaire back to the point drawn on the body diagram,
        // exactly like HumanBodySymptom/HumanBodyArticularity, so it can be looked up and
        // shown (e.g. in the point-selected drawer) via humanBodyPointId.
        humanBodyPointId: { type: DataTypes.UUID, allowNull: true },
        humanBodyQuestionnaireId: { type: DataTypes.UUID, allowNull: false }
    },
    { sequelize, modelName: 'humanBodyQuestionnaireInstance', tableName: 'human_body_questionnaire_instances' }
);

export default HumanBodyQuestionnaireInstance;


