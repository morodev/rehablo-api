import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface ProductAttributes {
    id: string;
    type: string;
    name?: string | null;
    code?: string | null;
    unit?: string | null;
    productVat?: string | null;
    sellingPrice?: number | null;
    purchaseCost?: number | null;
    categoryId?: number | null;
    description?: string | null;
}

export type ProductCreationAttributes = Optional<ProductAttributes, 'id' | 'type'>;

/** Tenant-scoped model: always access through `Product.schema(req.tenantSchema)`. */
export class Product extends Model<ProductAttributes, ProductCreationAttributes> implements ProductAttributes {
    declare id: string;
    declare type: string;
    declare name: string | null;
    declare code: string | null;
    declare unit: string | null;
    declare productVat: string | null;
    declare sellingPrice: number | null;
    declare purchaseCost: number | null;
    declare categoryId: number | null;
    declare description: string | null;
}

Product.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        type: { type: DataTypes.STRING, defaultValue: 'PRODUCT' },
        name: DataTypes.STRING,
        code: { type: DataTypes.STRING, unique: true },
        unit: DataTypes.STRING,
        productVat: DataTypes.STRING,
        sellingPrice: DataTypes.DECIMAL(10, 2),
        purchaseCost: DataTypes.DECIMAL(10, 2),
        categoryId: DataTypes.INTEGER,
        description: DataTypes.STRING
    },
    { sequelize, modelName: 'product', tableName: 'products' }
);

export default Product;

