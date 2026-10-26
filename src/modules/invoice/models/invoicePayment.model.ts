import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import {
    InvoicePaymentCreateOptions, mirrorInvoicePaymentToTreasury,
    mirrorVoidedInvoicePaymentToTreasury
} from '../../administration/services/invoicePaymentTreasury.service.js';

export const INVOICE_PAYMENT_STATUSES = ['POSTED', 'VOID', 'CREDIT'] as const;
export type InvoicePaymentStatus = (typeof INVOICE_PAYMENT_STATUSES)[number];

export const INVOICE_PAYMENT_SOURCES = ['USER', 'LEGACY_IMPORT', 'APPOINTMENT', 'PACKAGE', 'PACKAGE_PURCHASE', 'CREDIT', 'OPENING_BALANCE'] as const;
export type InvoicePaymentSource = (typeof INVOICE_PAYMENT_SOURCES)[number];

export interface InvoicePaymentAttributes {
    id: string;
    invoiceId?: string | null;
    carePackageId?: string | null;
    /** Seduta che ha originato il movimento, valorizzata solo per gli incassi pre-fattura. */
    agendaEventId?: string | null;
    amount: number;
    /** Unknown dates remain null for imported receipts and preceding opening coverage. */
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
    declare carePackageId: string | null;
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
        carePackageId: { type: DataTypes.UUID, allowNull: true },
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
            { name: 'invoice_payments_package_status_idx', fields: ['carePackageId', 'status'] },
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

const isCashPayment = (source: string) => !['PACKAGE', 'CREDIT', 'OPENING_BALANCE', 'LEGACY_IMPORT'].includes(source);
function validHistoricalDate(value: unknown): boolean {
    if (!value) return false;
    const parsed = new Date(value as string);
    if (!Number.isFinite(parsed.getTime())) return false;
    const day = parsed.toISOString().slice(0, 10);
    return (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value) || day === value.slice(0,10))
        && day <= new Date().toLocaleDateString('en-CA', {timeZone:'Europe/Rome'});
}
InvoicePayment.addHook('beforeCreate', 'requireCashTransaction', (payment, options) => {
    const row = payment as InvoicePayment;
    if (row.status === 'POSTED' && isCashPayment(row.source) && !options.transaction)
        throw new Error('Un incasso deve essere registrato nella stessa transazione della prima nota');
});
InvoicePayment.addHook('beforeBulkCreate', 'requireIndividualCashHooks', (payments, options) => {
    if (payments.some(row => isCashPayment((row as InvoicePayment).source)) && (!options.transaction || !options.individualHooks))
        throw new Error('Gli incassi richiedono transazione e registrazione contabile individuale');
});
InvoicePayment.addHook('beforeUpdate', 'preserveCashLedger', (payment, options) => {
    const row = payment as InvoicePayment;
    if (['amount', 'source', 'agendaEventId', 'carePackageId'].some(field => row.changed(field as any)))
        throw new Error('Importo e origine del pagamento sono immutabili');
    if (row.changed('paidAt') && (!(options as {completeHistoricalDate?: boolean}).completeHistoricalDate || !options.transaction
        || row.previous('paidAt') != null || !['USER', 'APPOINTMENT', 'LEGACY_IMPORT'].includes(row.source) || !validHistoricalDate(row.paidAt)))
        throw new Error('La data del movimento è immutabile; completa solo una data storica mancante nella transazione autorizzata');
    if (row.changed('status') && (isCashPayment(row.source) || row.source === 'LEGACY_IMPORT')) {
        if (!options.transaction) throw new Error('Lo storno richiede la stessa transazione della prima nota');
        if (row.previous('status') !== 'POSTED' || !['VOID', 'CREDIT'].includes(row.status))
            throw new Error('Un incasso annullato non può essere ripristinato');
    }
});
InvoicePayment.addHook('beforeBulkUpdate', 'preserveIndividualCashUpdates', options => {
    if (['status', 'amount', 'paidAt', 'source', 'agendaEventId', 'carePackageId'].some(field => Object.hasOwn((options as any).attributes ?? {}, field))
        && !options.individualHooks) throw new Error('I movimenti economici devono essere aggiornati individualmente');
});

// Mantiene la nuova prima nota allineata a ogni percorso di incasso esistente
// (fattura, agenda e migrazione appuntamenti) senza duplicare logica nei controller.
InvoicePayment.addHook('afterCreate', 'mirrorTreasuryMovement', async (payment, options) => {
    const typed = payment as InvoicePayment;
    // Package, credit and opening coverage settle a visit without a new cash receipt.
    if (typed.status !== 'POSTED' || ['PACKAGE', 'CREDIT', 'OPENING_BALANCE', 'LEGACY_IMPORT'].includes(typed.source)) return;
    await mirrorInvoicePaymentToTreasury(modelSchema(typed), typed.get({ plain: true }) as any, options.transaction ?? undefined,
        (options as InvoicePaymentCreateOptions).treasuryContext);
});

InvoicePayment.addHook('afterUpdate', 'mirrorTreasuryVoid', async (payment, options) => {
    const typed = payment as InvoicePayment;
    if (!typed.changed('status') || typed.status !== 'VOID' || typed.previous('status') !== 'POSTED') return;
    if (['PACKAGE', 'CREDIT', 'OPENING_BALANCE'].includes(typed.source)) return;
    await mirrorVoidedInvoicePaymentToTreasury(
        modelSchema(typed), typed.get({ plain: true }) as any, options.transaction ?? undefined
    );
});

export default InvoicePayment;
