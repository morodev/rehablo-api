import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface UserAnswerAttributes {
    id: string;
    userScaleInstanceId: string;
    questionScaleId: string;
    answerScaleId?: string | null;
    customAnswer?: string | null;
}

export type UserAnswerCreationAttributes = Optional<UserAnswerAttributes, 'id'>;

/**
 * Tenant-scoped model: a single answer given within a `UserScaleInstance`, referencing the
 * standardized (public-schema) `QuestionScale`/`AnswerScale` catalog.
 * Always access through `UserAnswer.schema(req.tenantSchema)`.
 */
export class UserAnswer
    extends Model<UserAnswerAttributes, UserAnswerCreationAttributes>
    implements UserAnswerAttributes {
    declare id: string;
    declare userScaleInstanceId: string;
    declare questionScaleId: string;
    declare answerScaleId: string | null;
    declare customAnswer: string | null;
}

UserAnswer.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        userScaleInstanceId: { type: DataTypes.UUID, allowNull: false },
        questionScaleId: { type: DataTypes.UUID, allowNull: false },
        answerScaleId: { type: DataTypes.UUID, allowNull: true },
        customAnswer: { type: DataTypes.TEXT, allowNull: true }
    },
    { sequelize, modelName: 'userAnswer', tableName: 'user_answers' }
);

export default UserAnswer;


