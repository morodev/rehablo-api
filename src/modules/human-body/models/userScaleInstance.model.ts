import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface UserScaleInstanceAttributes {
    id: string;
    userId?: string | null;
    patientId?: string | null;
    evaluationId?: string | null;
    scaleId: string;
}

export type UserScaleInstanceCreationAttributes = Optional<UserScaleInstanceAttributes, 'id'>;

/**
 * Tenant-scoped model: a patient's compiled instance of a standardized (public-schema) `Scale`.
 * Always access through `UserScaleInstance.schema(req.tenantSchema)`.
 */
export class UserScaleInstance
    extends Model<UserScaleInstanceAttributes, UserScaleInstanceCreationAttributes>
    implements UserScaleInstanceAttributes {
    declare id: string;
    declare userId: string | null;
    declare patientId: string | null;
    declare evaluationId: string | null;
    declare scaleId: string;
}

UserScaleInstance.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        userId: { type: DataTypes.UUID, allowNull: true },
        patientId: { type: DataTypes.UUID, allowNull: true },
        evaluationId: { type: DataTypes.UUID, allowNull: true },
        scaleId: { type: DataTypes.UUID, allowNull: false }
    },
    { sequelize, modelName: 'userScaleInstance', tableName: 'user_scale_instances' }
);

export default UserScaleInstance;


