import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface TestInstanceAttributes {
    id: string;
    userId?: string | null;
    patientId?: string | null;
    evaluationId?: string | null;
    testId: string;
    notes?: string | null;
    isPositive?: boolean | null;
}

export type TestInstanceCreationAttributes = Optional<TestInstanceAttributes, 'id'>;

/**
 * Tenant-scoped model: a patient's outcome for a standardized (public-schema) `Test`.
 * Always access through `TestInstance.schema(req.tenantSchema)`.
 */
export class TestInstance
    extends Model<TestInstanceAttributes, TestInstanceCreationAttributes>
    implements TestInstanceAttributes {
    declare id: string;
    declare userId: string | null;
    declare patientId: string | null;
    declare evaluationId: string | null;
    declare testId: string;
    declare notes: string | null;
    declare isPositive: boolean | null;
}

TestInstance.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        userId: { type: DataTypes.UUID, allowNull: true },
        patientId: { type: DataTypes.UUID, allowNull: true },
        evaluationId: { type: DataTypes.UUID, allowNull: true },
        testId: { type: DataTypes.UUID, allowNull: false },
        notes: { type: DataTypes.TEXT, allowNull: true },
        isPositive: { type: DataTypes.BOOLEAN, allowNull: true }
    },
    { sequelize, modelName: 'testInstance', tableName: 'test_instances' }
);

export default TestInstance;


