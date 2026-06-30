import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../../config/database.js';

export const TEST_TYPES = ['clinic', 'orthopedic'] as const;
export type TestType = (typeof TEST_TYPES)[number];

export interface TestAttributes {
    id: string;
    name: string;
    description?: string | null;
    image?: Buffer | null;
    note?: string | null;
    isPositive?: boolean | null;
    positiveText?: string | null;
    negativeText?: string | null;
    patientText?: string | null;
    operatorText?: string | null;
    type: TestType;
    districts?: string[] | null;
    isFullBody: boolean;
}

export type TestCreationAttributes = Optional<TestAttributes, 'id' | 'isFullBody'>;

/**
 * Global catalog of standardized clinical/orthopedic tests (e.g. Adson test), shared across every
 * tenant. Lives in the "public" schema, NOT in a per-tenant schema (unlike `TestInstance`, which
 * records a specific patient's test outcome and IS tenant-scoped).
 */
export class Test extends Model<TestAttributes, TestCreationAttributes> implements TestAttributes {
    declare id: string;
    declare name: string;
    declare description: string | null;
    declare image: Buffer | null;
    declare note: string | null;
    declare isPositive: boolean | null;
    declare positiveText: string | null;
    declare negativeText: string | null;
    declare patientText: string | null;
    declare operatorText: string | null;
    declare type: TestType;
    declare districts: string[] | null;
    declare isFullBody: boolean;
}

Test.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        name: { type: DataTypes.STRING, allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        image: { type: DataTypes.BLOB('medium'), allowNull: true },
        note: { type: DataTypes.STRING, allowNull: true },
        isPositive: { type: DataTypes.BOOLEAN, allowNull: true },
        positiveText: { type: DataTypes.STRING, allowNull: true },
        negativeText: { type: DataTypes.STRING, allowNull: true },
        patientText: { type: DataTypes.STRING, allowNull: true },
        operatorText: { type: DataTypes.STRING, allowNull: true },
        type: { type: DataTypes.STRING, allowNull: false, validate: { isIn: [TEST_TYPES as unknown as string[]] } },
        districts: { type: DataTypes.JSON, allowNull: true },
        isFullBody: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
    },
    {
        sequelize,
        modelName: 'test',
        tableName: 'tests',
        schema: 'public',
        hooks: {
            beforeValidate: (test: any) => {
                if (test.isFullBody) {
                    test.districts = null;
                }
            }
        }
    }
);

export default Test;

