import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import {
    InvoicePaymentCreateOptions, mirrorInvoicePaymentToTreasury,
    mirrorVoidedInvoicePaymentToTreasury
} from '../../administration/services/invoicePaymentTreasury.service.js';

export const INVOICE_PAYMENT_STATUSES = ['POSTED', 'VOID', 'CREDIT'] as const;
export type InvoicePaymentStatus = (typeof INVOICE_PAYMENT_STATUSES)[number];

export const INVOICE_PAYMENT_SOURCES = ['USER', 'LEGACY_IMPORT', 'APPOINTMENT', 'PACKAGE', 'CREDIT'] as const;
export type InvoicePaymentSource = (typeof INVOICE_PAYMENT_SOURCES)[number];

export interface InvoicePaymentAttributes {
    id: string;
    invoiceId?: string | null;
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
    declare invoiceId: string | null;
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
        invoiceId: { type: DataTypes.UUID, allowNull: true },
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
            { name: 'invoice_payments_agenda_event_status_idx', fields: ['agendaEventId', 'status'] }
        ]
    }
);

function modelSchema(payment: InvoicePayment): unknown {
    const table = (payment.constructor as typeof InvoicePayment).getTableName();
    return typeof table === 'object' ? table.schema : null;
}

// Mantiene la nuova prima nota allineata a ogni percorso di incasso esistente
// (fattura, agenda e migrazione appuntamenti) senza duplicare logica nei controller.
InvoicePayment.addHook('afterCreate', 'mirrorTreasuryMovement', async (payment, options) => {
    const typed = payment as InvoicePayment;
    // Package coverage settles a visit but is not a new cash receipt.
    if (typed.status !== 'POSTED' || typed.source === 'PACKAGE' || typed.source === 'CREDIT') return;
    await mirrorInvoicePaymentToTreasury(modelSchema(typed), typed.get({ plain: true }) as any, options.transaction ?? undefined,
        (options as InvoicePaymentCreateOptions).treasuryContext);
});

InvoicePayment.addHook('afterUpdate', 'mirrorTreasuryVoid', async (payment, options) => {
    const typed = payment as InvoicePayment;
    if (!typed.changed('status') || typed.status !== 'VOID' || typed.previous('status') !== 'POSTED') return;
    if (typed.source === 'PACKAGE' || typed.source === 'CREDIT') return;
    await mirrorVoidedInvoicePaymentToTreasury(
        modelSchema(typed), typed.get({ plain: true }) as any, options.transaction ?? undefined
    );
});

export default InvoicePayment;
