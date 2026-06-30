import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface HumanBodyQuestionnaireAttributes {
    id: string;
    title: string;
    description?: string | null;
}

export type HumanBodyQuestionnaireCreationAttributes = Optional<HumanBodyQuestionnaireAttributes, 'id'>;

/**
 * Tenant-scoped model: custom (non-standardized) questionnaires authored by a tenant.
 * Always access through `HumanBodyQuestionnaire.schema(req.tenantSchema)`.
 */
export class HumanBodyQuestionnaire
    extends Model<HumanBodyQuestionnaireAttributes, HumanBodyQuestionnaireCreationAttributes>
    implements HumanBodyQuestionnaireAttributes {
    declare id: string;
    declare title: string;
    declare description: string | null;
}

HumanBodyQuestionnaire.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        title: { type: DataTypes.STRING, allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true }
    },
    { sequelize, modelName: 'humanBodyQuestionnaire', tableName: 'human_body_questionnaires' }
);

export default HumanBodyQuestionnaire;


