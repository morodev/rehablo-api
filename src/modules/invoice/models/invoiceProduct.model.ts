import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface InvoiceProductAttributes {
    id: string;
    InvoiceId: string;
    ProductId: string;
    quantity?: number | null;
    productPrice?: number | null;
    totalPrice?: number | null;
    percentageDiscount?: number | null;
    discountAmount?: number | null;
}

export type InvoiceProductCreationAttributes = Optional<InvoiceProductAttributes, 'id'>;

/** Join table Invoice <-> Product (tenant-scoped, use `.schema(req.tenantSchema)`). */
export class InvoiceProduct
    extends Model<InvoiceProductAttributes, InvoiceProductCreationAttributes>
    implements InvoiceProductAttributes {
    declare id: string;
    declare InvoiceId: string;
    declare ProductId: string;
    declare quantity: number | null;
    declare productPrice: number | null;
    declare totalPrice: number | null;
    declare percentageDiscount: number | null;
    declare discountAmount: number | null;
}

InvoiceProduct.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        InvoiceId: { type: DataTypes.UUID, allowNull: false },
        ProductId: { type: DataTypes.UUID, allowNull: false },
        quantity: DataTypes.INTEGER,
        productPrice: DataTypes.DECIMAL(10, 2),
        totalPrice: DataTypes.DECIMAL(10, 2),
        percentageDiscount: DataTypes.INTEGER,
        discountAmount: DataTypes.DECIMAL(10, 2)
    },
    { sequelize, modelName: 'invoiceProduct', tableName: 'invoice_products' }
);

export default InvoiceProduct;

