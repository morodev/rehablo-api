import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface HumanBodyArticularityAttributes {
    id: string;
    humanBodyPointId: string;
    articularity: string;
    movement: string;
    bodyPart: string;
    bodySubPart?: string | null;
    passiveValue?: number | null;
    activeValue?: number | null;
    passivePain?: boolean | null;
    activePain?: boolean | null;
    passiveValuePain?: number | null;
    activeValuePain?: number | null;
    valueStrength?: number | null;
    strengthPain?: boolean | null;
    valueStrengthPain?: number | null;
    date: Date;
    patientId: string;
    userId: string;
}

export type HumanBodyArticularityCreationAttributes = Optional<HumanBodyArticularityAttributes, 'id'>;

/** Tenant-scoped model: always access through `HumanBodyArticularity.schema(req.tenantSchema)`. */
export class HumanBodyArticularity
    extends Model<HumanBodyArticularityAttributes, HumanBodyArticularityCreationAttributes>
    implements HumanBodyArticularityAttributes {
    declare id: string;
    declare humanBodyPointId: string;
    declare articularity: string;
    declare movement: string;
    declare bodyPart: string;
    declare bodySubPart: string | null;
    declare passiveValue: number | null;
    declare activeValue: number | null;
    declare passivePain: boolean | null;
    declare activePain: boolean | null;
    declare passiveValuePain: number | null;
    declare activeValuePain: number | null;
    declare valueStrength: number | null;
    declare strengthPain: boolean | null;
    declare valueStrengthPain: number | null;
    declare date: Date;
    declare patientId: string;
    declare userId: string;
}

const optInt = { type: DataTypes.INTEGER, allowNull: true };
const optBool = { type: DataTypes.BOOLEAN, allowNull: true };

HumanBodyArticularity.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        humanBodyPointId: { type: DataTypes.UUID, allowNull: false },
        articularity: { type: DataTypes.STRING, allowNull: false },
        movement: { type: DataTypes.STRING, allowNull: false },
        bodyPart: { type: DataTypes.STRING, allowNull: false },
        bodySubPart: { type: DataTypes.STRING, allowNull: true },
        passiveValue: optInt,
        activeValue: optInt,
        passivePain: optBool,
        activePain: optBool,
        passiveValuePain: optInt,
        activeValuePain: optInt,
        valueStrength: optInt,
        strengthPain: optBool,
        valueStrengthPain: optInt,
        date: { type: DataTypes.DATE, allowNull: false },
        patientId: { type: DataTypes.UUID, allowNull: false },
        userId: { type: DataTypes.UUID, allowNull: false }
    },
    { sequelize, modelName: 'humanBodyArticularity', tableName: 'human_body_articularities' }
);

export default HumanBodyArticularity;

