import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../../config/database.js';

export interface AnswerScaleAttributes {
    id: string;
    description: string;
    value?: number | null;
    questionScaleId: string;
}

export type AnswerScaleCreationAttributes = Optional<AnswerScaleAttributes, 'id'>;

/** Catalog data (public schema): a possible answer for a QuestionScale, with optional scoring value. */
export class AnswerScale
    extends Model<AnswerScaleAttributes, AnswerScaleCreationAttributes>
    implements AnswerScaleAttributes {
    declare id: string;
    declare description: string;
    declare value: number | null;
    declare questionScaleId: string;
}

AnswerScale.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        description: { type: DataTypes.TEXT, allowNull: false },
        value: { type: DataTypes.INTEGER, allowNull: true },
        questionScaleId: { type: DataTypes.UUID, allowNull: false }
    },
    { sequelize, modelName: 'answerScale', tableName: 'answer_scales', schema: 'public' }
);

export default AnswerScale;

