import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../../config/database.js';

export interface ScaleAttributes {
    id: string;
    name: string;
    description?: string | null;
    image?: Buffer | null;
    districts?: string[] | null;
    isFullBody: boolean;
    category?: string | null;
    score?: Record<string, unknown> | null;
    interpretation?: Record<string, unknown> | null;
}

export type ScaleCreationAttributes = Optional<ScaleAttributes, 'id' | 'isFullBody'>;

/**
 * Global catalog of standardized clinical scales (e.g. OMPQ, Oswestry...), shared across every
 * tenant. Lives in the "public" schema, NOT in a per-tenant schema (unlike `UserScaleInstance`,
 * which records a specific patient's compiled answers and IS tenant-scoped).
 */
export class Scale extends Model<ScaleAttributes, ScaleCreationAttributes> implements ScaleAttributes {
    declare id: string;
    declare name: string;
    declare description: string | null;
    declare image: Buffer | null;
    declare districts: string[] | null;
    declare isFullBody: boolean;
    declare category: string | null;
    declare score: Record<string, unknown> | null;
    declare interpretation: Record<string, unknown> | null;
}

Scale.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        name: { type: DataTypes.STRING, allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        image: { type: DataTypes.BLOB('medium'), allowNull: true },
        districts: { type: DataTypes.JSON, allowNull: true },
        isFullBody: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        category: { type: DataTypes.STRING, allowNull: true },
        score: { type: DataTypes.JSON, allowNull: true },
        interpretation: { type: DataTypes.JSON, allowNull: true }
    },
    {
        sequelize,
        modelName: 'scale',
        tableName: 'scales',
        schema: 'public',
        hooks: {
            beforeValidate: (scale: any) => {
                if (scale.isFullBody) {
                    scale.districts = null;
                }
            }
        }
    }
);

export default Scale;

