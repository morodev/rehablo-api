import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export const INVOICE_PAYMENT_STATUSES = ['POSTED', 'VOID'] as const;
export type InvoicePaymentStatus = (typeof INVOICE_PAYMENT_STATUSES)[number];

export const INVOICE_PAYMENT_SOURCES = ['USER', 'LEGACY_IMPORT', 'APPOINTMENT'] as const;
export type InvoicePaymentSource = (typeof INVOICE_PAYMENT_SOURCES)[number];

export interface InvoicePaymentAttributes {
    id: string;
    invoiceId: string;
    /** Seduta che ha originato il movimento, valorizzata solo per gli incassi pre-fattura. */
    agendaEventId?: string | null;
    amount: number;
    /** Nullable only for payments imported from the old paid/unpaid flag. */
    paidAt?: Date | null;
    method?: string | null;
    note?: string | null;
    source: InvoicePaymentSource;
    status: InvoicePaymentStatus;
    createdByUserId?: string | null;
    voidedAt?: Date | null;
    voidedByUserId?: string | null;
    voidReason?: string | null;
}

export type InvoicePaymentCreationAttributes = Optional<
    InvoicePaymentAttributes,
    | 'id'
    | 'agendaEventId'
    | 'paidAt'
    | 'method'
    | 'note'
    | 'source'
    | 'status'
    | 'createdByUserId'
    | 'voidedAt'
    | 'voidedByUserId'
    | 'voidReason'
>;

/** Tenant-scoped accounting movement. Posted movements are immutable; corrections are voided. */
export class InvoicePayment
    extends Model<InvoicePaymentAttributes, InvoicePaymentCreationAttributes>
    implements InvoicePaymentAttributes {
    declare id: string;
    declare invoiceId: string;
    declare agendaEventId: string | null;
    declare amount: number;
    declare paidAt: Date | null;
    declare method: string | null;
    declare note: string | null;
    declare source: InvoicePaymentSource;
    declare status: InvoicePaymentStatus;
    declare createdByUserId: string | null;
    declare voidedAt: Date | null;
    declare voidedByUserId: string | null;
    declare voidReason: string | null;
}

InvoicePayment.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        invoiceId: { type: DataTypes.UUID, allowNull: false },
        agendaEventId: { type: DataTypes.UUID, allowNull: true },
        amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
        paidAt: { type: DataTypes.DATEONLY, allowNull: true },
        method: { type: DataTypes.STRING, allowNull: true },
        note: { type: DataTypes.TEXT, allowNull: true },
        source: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'USER' },
        status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'POSTED' },
        createdByUserId: { type: DataTypes.UUID, allowNull: true },
        voidedAt: { type: DataTypes.DATE, allowNull: true },
        voidedByUserId: { type: DataTypes.UUID, allowNull: true },
        voidReason: { type: DataTypes.TEXT, allowNull: true }
    },
    {
        sequelize,
        modelName: 'invoicePayment',
        tableName: 'invoice_payments',
        indexes: [
            { name: 'invoice_payments_invoice_status_idx', fields: ['invoiceId', 'status'] },
            { name: 'invoice_payments_paid_at_idx', fields: ['paidAt'] },
            { name: 'invoice_payments_agenda_event_unique', unique: true, fields: ['agendaEventId'] }
        ]
    }
);

export default InvoicePayment;
