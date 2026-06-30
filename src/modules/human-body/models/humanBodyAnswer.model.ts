import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface HumanBodyAnswerAttributes {
    id: string;
    text: string;
    isCorrect?: boolean | null;
    humanBodyQuestionId: string;
}

export type HumanBodyAnswerCreationAttributes = Optional<HumanBodyAnswerAttributes, 'id'>;

/** Tenant-scoped model: always access through `HumanBodyAnswer.schema(req.tenantSchema)`. */
export class HumanBodyAnswer
    extends Model<HumanBodyAnswerAttributes, HumanBodyAnswerCreationAttributes>
    implements HumanBodyAnswerAttributes {
    declare id: string;
    declare text: string;
    declare isCorrect: boolean | null;
    declare humanBodyQuestionId: string;
}

HumanBodyAnswer.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        text: { type: DataTypes.TEXT, allowNull: false },
        isCorrect: { type: DataTypes.BOOLEAN, allowNull: true },
        humanBodyQuestionId: { type: DataTypes.UUID, allowNull: false }
    },
    { sequelize, modelName: 'humanBodyAnswer', tableName: 'human_body_answers' }
);

export default HumanBodyAnswer;


