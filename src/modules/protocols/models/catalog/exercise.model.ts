import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../../config/database.js';

export type ExerciseCategory =
    | 'MOBILIZATION'
    | 'STRENGTHENING'
    | 'STRETCHING'
    | 'PROPRIOCEPTION'
    | 'CARDIO'
    | 'BALANCE'
    | 'OTHER';

export interface ExerciseAttributes {
    id: string;
    name: string;
    description?: string | null;
    instructions?: string | null;
    videoUrl?: string | null;
    imageUrl?: string | null;
    category: ExerciseCategory;
    bodyDistricts?: string[] | null;
    equipment?: string[] | null;
}

export type ExerciseCreationAttributes = Optional<
    ExerciseAttributes,
    'id' | 'category' | 'bodyDistricts' | 'equipment'
>;

/**
 * Global catalog of reusable rehabilitation exercises (mobilization, strengthening, stretching...),
 * shared across every tenant. Lives in the "public" schema, exactly like `Scale`/`Test` in the
 * human-body module: it's the "dictionary" that protocol templates draw from.
 */
export class Exercise extends Model<ExerciseAttributes, ExerciseCreationAttributes> implements ExerciseAttributes {
    declare id: string;
    declare name: string;
    declare description: string | null;
    declare instructions: string | null;
    declare videoUrl: string | null;
    declare imageUrl: string | null;
    declare category: ExerciseCategory;
    declare bodyDistricts: string[] | null;
    declare equipment: string[] | null;
}

Exercise.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        name: { type: DataTypes.STRING, allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        instructions: { type: DataTypes.TEXT, allowNull: true },
        videoUrl: { type: DataTypes.STRING, allowNull: true },
        imageUrl: { type: DataTypes.STRING, allowNull: true },
        category: {
            type: DataTypes.ENUM(
                'MOBILIZATION',
                'STRENGTHENING',
                'STRETCHING',
                'PROPRIOCEPTION',
                'CARDIO',
                'BALANCE',
                'OTHER'
            ),
            allowNull: false,
            defaultValue: 'OTHER'
        },
        bodyDistricts: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: true, defaultValue: [] },
        equipment: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: true, defaultValue: [] }
    },
    { sequelize, modelName: 'exercise', tableName: 'exercises', schema: 'public' }
);

export default Exercise;

