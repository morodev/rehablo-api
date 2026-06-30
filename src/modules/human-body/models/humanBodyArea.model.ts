import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface HumanBodyAreaAttributes {
    id: string;
    patientId: string;
    userId: string;
    idArea?: string | null;
    bodyPart: string;
    fillColor: string;
    idSvg: string;
}

export type HumanBodyAreaCreationAttributes = Optional<HumanBodyAreaAttributes, 'id'>;

/** Tenant-scoped model: always access through `HumanBodyArea.schema(req.tenantSchema)`. */
export class HumanBodyArea
    extends Model<HumanBodyAreaAttributes, HumanBodyAreaCreationAttributes>
    implements HumanBodyAreaAttributes {
    declare id: string;
    declare patientId: string;
    declare userId: string;
    declare idArea: string | null;
    declare bodyPart: string;
    declare fillColor: string;
    declare idSvg: string;
}

HumanBodyArea.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        patientId: { type: DataTypes.UUID, allowNull: false },
        userId: { type: DataTypes.UUID, allowNull: false },
        idArea: { type: DataTypes.UUID, unique: true },
        bodyPart: { type: DataTypes.STRING, allowNull: false },
        fillColor: { type: DataTypes.STRING, allowNull: false },
        idSvg: { type: DataTypes.TEXT, allowNull: false }
    },
    { sequelize, modelName: 'humanBodyArea', tableName: 'human_body_areas' }
);

export default HumanBodyArea;

