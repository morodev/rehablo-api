import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface HumanBodyPointAttributes {
    id: string;
    patientId: string;
    userId: string;
    cxCoordinate: number;
    cyCoordinate: number;
    rDimension: number;
    bodyPart: string;
    fillColor: string;
    idSvg: string;
}

export type HumanBodyPointCreationAttributes = Optional<HumanBodyPointAttributes, 'id'>;

/** Tenant-scoped model: always access through `HumanBodyPoint.schema(req.tenantSchema)`. */
export class HumanBodyPoint
    extends Model<HumanBodyPointAttributes, HumanBodyPointCreationAttributes>
    implements HumanBodyPointAttributes {
    declare id: string;
    declare patientId: string;
    declare userId: string;
    declare cxCoordinate: number;
    declare cyCoordinate: number;
    declare rDimension: number;
    declare bodyPart: string;
    declare fillColor: string;
    declare idSvg: string;
}

HumanBodyPoint.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        patientId: { type: DataTypes.UUID, allowNull: false },
        userId: { type: DataTypes.UUID, allowNull: false },
        cxCoordinate: { type: DataTypes.DOUBLE, allowNull: false },
        cyCoordinate: { type: DataTypes.DOUBLE, allowNull: false },
        rDimension: { type: DataTypes.INTEGER, allowNull: false },
        bodyPart: { type: DataTypes.STRING, allowNull: false },
        fillColor: { type: DataTypes.STRING, allowNull: false },
        idSvg: { type: DataTypes.STRING, allowNull: false }
    },
    { sequelize, modelName: 'humanBodyPoint', tableName: 'human_body_points' }
);

export default HumanBodyPoint;

