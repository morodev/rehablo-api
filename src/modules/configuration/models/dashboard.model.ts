import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface DashboardAttributes {
    id: string;
    patientId: string;
    userId: string;
    options: Record<string, unknown>;
    sharedWith?: string[] | null;
}

export type DashboardCreationAttributes = Optional<DashboardAttributes, 'id'>;

/** Tenant-scoped model: always access through `Dashboard.schema(req.tenantSchema)`. */
export class Dashboard extends Model<DashboardAttributes, DashboardCreationAttributes> implements DashboardAttributes {
    declare id: string;
    declare patientId: string;
    declare userId: string;
    declare options: Record<string, unknown>;
    declare sharedWith: string[] | null;
}

Dashboard.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        patientId: { type: DataTypes.UUID, allowNull: false },
        userId: { type: DataTypes.UUID, allowNull: false },
        options: { type: DataTypes.JSON, allowNull: false },
        sharedWith: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: true }
    },
    { sequelize, modelName: 'dashboard', tableName: 'dashboards' }
);

export default Dashboard;

