import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface HumanBodyStrengthAttributes {
    id: string;
    humanBodyPointId: string;
    bodyPart: string;
    bodySubPart?: string | null;
    valueStrength: number;
    strengthPain?: boolean | null;
    valueStrengthPain?: number | null;
    date: Date;
    patientId: string;
    userId: string;
}

export type HumanBodyStrengthCreationAttributes = Optional<HumanBodyStrengthAttributes, 'id'>;

/** Tenant-scoped model: always access through `HumanBodyStrength.schema(req.tenantSchema)`. */
export class HumanBodyStrength
    extends Model<HumanBodyStrengthAttributes, HumanBodyStrengthCreationAttributes>
    implements HumanBodyStrengthAttributes {
    declare id: string;
    declare humanBodyPointId: string;
    declare bodyPart: string;
    declare bodySubPart: string | null;
    declare valueStrength: number;
    declare strengthPain: boolean | null;
    declare valueStrengthPain: number | null;
    declare date: Date;
    declare patientId: string;
    declare userId: string;
}

HumanBodyStrength.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        humanBodyPointId: { type: DataTypes.UUID, allowNull: false },
        bodyPart: { type: DataTypes.STRING, allowNull: false },
        bodySubPart: { type: DataTypes.STRING, allowNull: true },
        valueStrength: { type: DataTypes.INTEGER, allowNull: false },
        strengthPain: { type: DataTypes.BOOLEAN, allowNull: true },
        valueStrengthPain: { type: DataTypes.INTEGER, allowNull: true },
        date: { type: DataTypes.DATE, allowNull: false },
        patientId: { type: DataTypes.UUID, allowNull: false },
        userId: { type: DataTypes.UUID, allowNull: false }
    },
    { sequelize, modelName: 'humanBodyStrength', tableName: 'human_body_strengths' }
);

export default HumanBodyStrength;

