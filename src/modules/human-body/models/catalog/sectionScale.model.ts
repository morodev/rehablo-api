import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../../config/database.js';

export interface SectionScaleAttributes {
    id: string;
    sectionName: string;
    scaleId: string;
}

export type SectionScaleCreationAttributes = Optional<SectionScaleAttributes, 'id'>;

/** Catalog data (public schema): a named section grouping questions within a Scale. */
export class SectionScale
    extends Model<SectionScaleAttributes, SectionScaleCreationAttributes>
    implements SectionScaleAttributes {
    declare id: string;
    declare sectionName: string;
    declare scaleId: string;
}

SectionScale.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        sectionName: { type: DataTypes.STRING, allowNull: false },
        scaleId: { type: DataTypes.UUID, allowNull: false }
    },
    { sequelize, modelName: 'sectionScale', tableName: 'section_scales', schema: 'public' }
);

export default SectionScale;

