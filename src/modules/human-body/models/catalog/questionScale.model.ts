import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../../config/database.js';

export interface QuestionScaleAttributes {
    id: string;
    description: string;
    type: string;
    scaleId: string;
    sectionId?: string | null;
}

export type QuestionScaleCreationAttributes = Optional<QuestionScaleAttributes, 'id'>;

/** Catalog data (public schema): a question belonging to a standardized Scale (optionally grouped in a section). */
export class QuestionScale
    extends Model<QuestionScaleAttributes, QuestionScaleCreationAttributes>
    implements QuestionScaleAttributes {
    declare id: string;
    declare description: string;
    declare type: string;
    declare scaleId: string;
    declare sectionId: string | null;
}

QuestionScale.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        description: { type: DataTypes.TEXT, allowNull: false },
        type: { type: DataTypes.STRING, allowNull: false },
        scaleId: { type: DataTypes.UUID, allowNull: false },
        sectionId: { type: DataTypes.UUID, allowNull: true }
    },
    { sequelize, modelName: 'questionScale', tableName: 'question_scales', schema: 'public' }
);

export default QuestionScale;

