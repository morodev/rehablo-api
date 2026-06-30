import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface TenantAttributes {
    id: string;
    businessName?: string | null;
    VATNumber?: string | null;
    license: string;
    isActive: boolean;
    idStripe: string;
    isPremium: boolean;
    userQuantity: number;
    maxUserQuantity: number;
    structureQuantity: number;
    maxStructureQuantity: number;
    MBQuantity: number;
}

export type TenantCreationAttributes = Optional<
    TenantAttributes,
    'id' | 'isActive' | 'isPremium' | 'userQuantity' | 'structureQuantity' | 'MBQuantity'
>;

export class Tenant extends Model<TenantAttributes, TenantCreationAttributes> implements TenantAttributes {
    declare id: string;
    declare businessName: string | null;
    declare VATNumber: string | null;
    declare license: string;
    declare isActive: boolean;
    declare idStripe: string;
    declare isPremium: boolean;
    declare userQuantity: number;
    declare maxUserQuantity: number;
    declare structureQuantity: number;
    declare maxStructureQuantity: number;
    declare MBQuantity: number;
}

Tenant.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        businessName: { type: DataTypes.STRING, allowNull: true, unique: true },
        VATNumber: { type: DataTypes.STRING, allowNull: true, unique: true },
        license: { type: DataTypes.TEXT, allowNull: false },
        isActive: { type: DataTypes.BOOLEAN, defaultValue: false },
        idStripe: { type: DataTypes.STRING, allowNull: false },
        isPremium: { type: DataTypes.BOOLEAN, defaultValue: false },
        userQuantity: { type: DataTypes.INTEGER, defaultValue: 1 },
        maxUserQuantity: { type: DataTypes.INTEGER, allowNull: false },
        structureQuantity: { type: DataTypes.INTEGER, defaultValue: 1 },
        maxStructureQuantity: { type: DataTypes.INTEGER, allowNull: false },
        MBQuantity: { type: DataTypes.INTEGER, defaultValue: 100 }
    },
    { sequelize, modelName: 'tenant', tableName: 'tenants' }
);

export default Tenant;

