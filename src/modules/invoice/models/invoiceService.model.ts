import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface InvoiceServiceAttributes {
    id: string;
    InvoiceId: string;
    ServiceId: string;
    quantity?: number | null;
    servicePrice?: number | null;
    totalPrice?: number | null;
    percentageDiscount?: number | null;
    discountAmount?: number | null;
}

export type InvoiceServiceCreationAttributes = Optional<InvoiceServiceAttributes, 'id'>;

/** Join table Invoice <-> Service (tenant-scoped, use `.schema(req.tenantSchema)`). */
export class InvoiceService
    extends Model<InvoiceServiceAttributes, InvoiceServiceCreationAttributes>
    implements InvoiceServiceAttributes {
    declare id: string;
    declare InvoiceId: string;
    declare ServiceId: string;
    declare quantity: number | null;
    declare servicePrice: number | null;
    declare totalPrice: number | null;
    declare percentageDiscount: number | null;
    declare discountAmount: number | null;
}

InvoiceService.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        InvoiceId: { type: DataTypes.UUID, allowNull: false },
        ServiceId: { type: DataTypes.UUID, allowNull: false },
        quantity: DataTypes.INTEGER,
        servicePrice: DataTypes.DECIMAL(10, 2),
        totalPrice: DataTypes.DECIMAL(10, 2),
        percentageDiscount: DataTypes.INTEGER,
        discountAmount: DataTypes.DECIMAL(10, 2)
    },
    { sequelize, modelName: 'invoiceService', tableName: 'invoice_services' }
);

export default InvoiceService;

