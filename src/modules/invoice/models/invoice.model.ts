import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface InvoiceAttributes {
    id: string;
    emissionDate?: Date | null;
    invoiceNet?: number | null;
    invoiceTotal?: number | null;
    sellingPrice?: number | null;
    discSellingPrice?: number | null;
    invoiceVAT?: number | null;
    patientID?: string | null;
    isCashPro: boolean;
    cashPro?: string | null;
    isRivals: boolean;
    rivals?: number | null;
    isTaxWithholding: boolean;
    taxWithholding?: number | null;
    isStamp: boolean;
    stampAmount?: number | null;
    paymentMethod?: string | null;
    discountType?: string | null;
    discountAmount?: number | null;
    status?: string | null;
    paymentTerms?: Date | null;
}

export type InvoiceCreationAttributes = Optional<
    InvoiceAttributes,
    'id' | 'isCashPro' | 'isRivals' | 'isTaxWithholding' | 'isStamp'
>;

/**
 * Unified invoice model: merges the richer fiscal fields from the former "rehablo-invoice" (v2)
 * service (INPS rivalsa, ritenuta d'acconto, marca da bollo, discounts) with the relational
 * approach (real Product/Service associations via InvoiceProducts/InvoiceServices) of the former
 * "rehablo-invoice-service" (v1).
 *
 * Tenant-scoped model: always access through `Invoice.schema(req.tenantSchema)`.
 */
export class Invoice extends Model<InvoiceAttributes, InvoiceCreationAttributes> implements InvoiceAttributes {
    declare id: string;
    declare emissionDate: Date | null;
    declare invoiceNet: number | null;
    declare invoiceTotal: number | null;
    declare sellingPrice: number | null;
    declare discSellingPrice: number | null;
    declare invoiceVAT: number | null;
    declare patientID: string | null;
    declare isCashPro: boolean;
    declare cashPro: string | null;
    declare isRivals: boolean;
    declare rivals: number | null;
    declare isTaxWithholding: boolean;
    declare taxWithholding: number | null;
    declare isStamp: boolean;
    declare stampAmount: number | null;
    declare paymentMethod: string | null;
    declare discountType: string | null;
    declare discountAmount: number | null;
    declare status: string | null;
    declare paymentTerms: Date | null;
}

Invoice.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        emissionDate: DataTypes.DATEONLY,
        invoiceNet: DataTypes.DECIMAL(10, 2),
        invoiceTotal: DataTypes.DECIMAL(10, 2),
        sellingPrice: DataTypes.DECIMAL(10, 2),
        discSellingPrice: DataTypes.DECIMAL(10, 2),
        invoiceVAT: DataTypes.DECIMAL(10, 2),
        patientID: DataTypes.UUID,
        isCashPro: { type: DataTypes.BOOLEAN, defaultValue: false },
        cashPro: DataTypes.STRING,
        isRivals: { type: DataTypes.BOOLEAN, defaultValue: false },
        rivals: DataTypes.INTEGER,
        isTaxWithholding: { type: DataTypes.BOOLEAN, defaultValue: false },
        taxWithholding: DataTypes.INTEGER,
        isStamp: { type: DataTypes.BOOLEAN, defaultValue: false },
        stampAmount: DataTypes.DECIMAL(10, 2),
        paymentMethod: DataTypes.STRING,
        discountType: DataTypes.STRING,
        discountAmount: DataTypes.DECIMAL(10, 2),
        status: DataTypes.STRING,
        paymentTerms: DataTypes.DATEONLY
    },
    { sequelize, modelName: 'invoice', tableName: 'invoices' }
);

export default Invoice;

