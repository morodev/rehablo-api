import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface ServiceAttributes {
    id: string;
    type: string;
    name?: string | null;
    code?: string | null;
    productVat?: string | null;
    sellingPrice?: number | null;
    /** FK verso `Category` (vedi category.model.ts). UUID, coerente col resto dello schema. */
    categoryId?: string | null;
    description?: string | null;
    /** Soft-delete: vedi commento analogo su `product.model.ts`. */
    isActive: boolean;
}

export type ServiceCreationAttributes = Optional<ServiceAttributes, 'id' | 'type' | 'isActive'>;

/** Tenant-scoped model: always access through `Service.schema(req.tenantSchema)`. */
export class Service extends Model<ServiceAttributes, ServiceCreationAttributes> implements ServiceAttributes {
    declare id: string;
    declare type: string;
    declare name: string | null;
    declare code: string | null;
    declare productVat: string | null;
    declare sellingPrice: number | null;
    declare categoryId: string | null;
    declare description: string | null;
    declare isActive: boolean;
}

Service.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        type: { type: DataTypes.STRING, defaultValue: 'SERVICE' },
        name: DataTypes.STRING,
        code: { type: DataTypes.STRING, unique: true },
        productVat: DataTypes.STRING,
        sellingPrice: DataTypes.DECIMAL(10, 2),
        categoryId: DataTypes.UUID,
        description: DataTypes.STRING,
        isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
    },
    { sequelize, modelName: 'service', tableName: 'services' }
);

export default Service;

