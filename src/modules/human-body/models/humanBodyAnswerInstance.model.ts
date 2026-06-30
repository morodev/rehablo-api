import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface HumanBodyAnswerInstanceAttributes {
    id: string;
    humanBodyQuestionnaireInstanceId: string;
    humanBodyQuestionId: string;
    humanBodyAnswerId?: string | null;
    customAnswer?: string | null;
}

export type HumanBodyAnswerInstanceCreationAttributes = Optional<HumanBodyAnswerInstanceAttributes, 'id'>;

/**
 * Tenant-scoped model: a single answer given within a `HumanBodyQuestionnaireInstance`.
 * Always access through `HumanBodyAnswerInstance.schema(req.tenantSchema)`.
 *
 * NOTE: the legacy controller (`saveQuestionnaireInstance`) had a copy-paste bug from the scale
 * module and tried to bulk-create rows with `userScaleInstanceId`/`questionScaleId`/`answerScaleId`
 * fields that don't even exist on this model. Fixed here to use the correct field names.
 */
export class HumanBodyAnswerInstance
    extends Model<HumanBodyAnswerInstanceAttributes, HumanBodyAnswerInstanceCreationAttributes>
    implements HumanBodyAnswerInstanceAttributes {
    declare id: string;
    declare humanBodyQuestionnaireInstanceId: string;
    declare humanBodyQuestionId: string;
    declare humanBodyAnswerId: string | null;
    declare customAnswer: string | null;
}

HumanBodyAnswerInstance.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        humanBodyQuestionnaireInstanceId: { type: DataTypes.UUID, allowNull: false },
        humanBodyQuestionId: { type: DataTypes.UUID, allowNull: false },
        humanBodyAnswerId: { type: DataTypes.UUID, allowNull: true },
        customAnswer: { type: DataTypes.TEXT, allowNull: true }
    },
    { sequelize, modelName: 'humanBodyAnswerInstance', tableName: 'human_body_answer_instances' }
);

export default HumanBodyAnswerInstance;


