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
    // --- Snapshot fiscale al momento dell'emissione: una fattura è un documento immutabile.
    // Se il prodotto viene rinominato, ri-prezzato o disattivato in seguito, questi campi
    // garantiscono che la fattura storica continui a mostrare nome e aliquota IVA corretti
    // dell'epoca, indipendentemente da cosa succede poi al catalogo (vedi invoice.controller.ts). ---
    productName?: string | null;
    /** Aliquota/natura IVA applicata a questa riga al momento dell'emissione (es. "22", "N4"). */
    productVat?: string | null;
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
    declare productName: string | null;
    declare productVat: string | null;
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
        discountAmount: DataTypes.DECIMAL(10, 2),
        productName: DataTypes.STRING,
        productVat: DataTypes.STRING
    },
    { sequelize, modelName: 'invoiceProduct', tableName: 'invoice_products' }
);

export default InvoiceProduct;

