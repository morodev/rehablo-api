import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface HumanBodySymptomAttributes {
    id: string;
    humanBodyPointId: string;
    evaluationId?: string | null;
    symptom: string;
    bodyPart: string;
    bodySubPart?: string | null;
    value: number;
    morningValue?: number | null;
    afternoonValue?: number | null;
    eveningValue?: number | null;
    nightValue?: number | null;
    date: Date;
    patientId: string;
    userId: string;
}

export type HumanBodySymptomCreationAttributes = Optional<HumanBodySymptomAttributes, 'id'>;

/** Tenant-scoped model: always access through `HumanBodySymptom.schema(req.tenantSchema)`. */
export class HumanBodySymptom
    extends Model<HumanBodySymptomAttributes, HumanBodySymptomCreationAttributes>
    implements HumanBodySymptomAttributes {
    declare id: string;
    declare humanBodyPointId: string;
    declare evaluationId: string | null;
    declare symptom: string;
    declare bodyPart: string;
    declare bodySubPart: string | null;
    declare value: number;
    declare morningValue: number | null;
    declare afternoonValue: number | null;
    declare eveningValue: number | null;
    declare nightValue: number | null;
    declare date: Date;
    declare patientId: string;
    declare userId: string;
}

HumanBodySymptom.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        humanBodyPointId: { type: DataTypes.UUID, allowNull: false },
        evaluationId: { type: DataTypes.UUID, allowNull: true },
        symptom: { type: DataTypes.STRING, allowNull: false },
        bodyPart: { type: DataTypes.STRING, allowNull: false },
        bodySubPart: { type: DataTypes.STRING, allowNull: true },
        value: { type: DataTypes.INTEGER, allowNull: false },
        morningValue: { type: DataTypes.INTEGER, allowNull: true },
        afternoonValue: { type: DataTypes.INTEGER, allowNull: true },
        eveningValue: { type: DataTypes.INTEGER, allowNull: true },
        nightValue: { type: DataTypes.INTEGER, allowNull: true },
        date: { type: DataTypes.DATE, allowNull: false },
        patientId: { type: DataTypes.UUID, allowNull: false },
        userId: { type: DataTypes.UUID, allowNull: false }
    },
    { sequelize, modelName: 'humanBodySymptom', tableName: 'human_body_symptoms' }
);

export default HumanBodySymptom;

