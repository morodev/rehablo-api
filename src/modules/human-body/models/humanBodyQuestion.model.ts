import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface HumanBodyQuestionAttributes {
    id: string;
    text: string;
    type: string;
    humanBodyQuestionnaireId: string;
}

export type HumanBodyQuestionCreationAttributes = Optional<HumanBodyQuestionAttributes, 'id'>;

/** Tenant-scoped model: always access through `HumanBodyQuestion.schema(req.tenantSchema)`. */
export class HumanBodyQuestion
    extends Model<HumanBodyQuestionAttributes, HumanBodyQuestionCreationAttributes>
    implements HumanBodyQuestionAttributes {
    declare id: string;
    declare text: string;
    declare type: string;
    declare humanBodyQuestionnaireId: string;
}

HumanBodyQuestion.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        text: { type: DataTypes.TEXT, allowNull: false },
        type: { type: DataTypes.STRING, allowNull: false },
        humanBodyQuestionnaireId: { type: DataTypes.UUID, allowNull: false }
    },
    { sequelize, modelName: 'humanBodyQuestion', tableName: 'human_body_questions' }
);

export default HumanBodyQuestion;


