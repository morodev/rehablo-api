import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface AgendaEventAttributes {
    id: string;
    /** Id dell'utente proprietario del calendario: è l'owner del record ai fini RBAC. */
    calendarId?: string | null;
    /** Struttura in cui si svolge l'appuntamento: abilita lo scope `structure`. */
    structureId?: string | null;
    recurringEventId?: string | null;
    isFirstInstance?: boolean | null;
    title?: string | null;
    patient?: Record<string, unknown> | null;
    /** Riferimento interrogabile; `patient` resta lo snapshot anagrafico storico. */
    patientId?: string | null;
    description?: string | null;
    start?: string | null;
    end?: string | null;
    allDay?: boolean | null;
    recurrence?: string | null;
    duration?: string | null;
    status?: string | null;
    /** Segnalazione operativa: il paziente non si e' presentato entro il tempo di tolleranza. */
    missedArrivalReportedAt?: Date | null;
    missedArrivalReportedBy?: string | null;
    /** Chiusura della segnalazione dopo il contatto della segreteria/operatore. */
    missedArrivalResolvedAt?: Date | null;
    missedArrivalResolvedBy?: string | null;
    missedArrivalResolution?: string | null;
    /** Per NO_SHOW: PENDING = da decidere, WAIVED = scelto di non addebitare. */
    noShowBillingDecision?: string | null;
    /** Incasso operativo della seduta, indipendente dall'eventuale fattura emessa in seguito. */
    appointmentPaymentStatus?: 'unpaid' | 'partial' | 'paid' | null;
    appointmentPaidAmount?: number | null;
    appointmentPaidAt?: string | null;
    appointmentPaymentMethod?: string | null;
    appointmentPaymentNote?: string | null;
    appointmentPaymentRecordedBy?: string | null;
    /** Frozen customer price. Null on historical appointments with no agreed price recorded. */
    appointmentExpectedAmount?: number | null;
    appointmentOriginalAmount?: number | null;
    appointmentPriceAdjustment?: 'DISCOUNT' | 'COMPLIMENTARY' | null;
    appointmentPriceAdjustmentNote?: string | null;
    appointmentPriceAdjustedBy?: string | null;
    appointmentPriceAdjustedAt?: Date | null;
    appointmentNetAmount?: number | null;
    appointmentVatRate?: number | null;
    appointmentPriceRecordedAt?: Date | null;
    appointmentPaymentHistoryKnown?: boolean;
    erasable?: boolean | null;
    eventTypeId?: string | null;
    /**
     * Legacy single-appointment document reference. Cumulative documents use InvoiceAgendaEvent.
     * Payment and document state are independent; appointment compatibility columns summarize
     * only movements owned by this appointment, never the full payment of a cumulative invoice.
     */
    invoiceId?: string | null;
}

export type AgendaEventCreationAttributes = Optional<AgendaEventAttributes, 'id'>;

/** Tenant-scoped model: always access through `AgendaEvent.schema(req.tenantSchema)`. */
export class AgendaEvent
    extends Model<AgendaEventAttributes, AgendaEventCreationAttributes>
    implements AgendaEventAttributes {
    declare id: string;
    declare calendarId: string | null;
    declare structureId: string | null;
    declare recurringEventId: string | null;
    declare isFirstInstance: boolean | null;
    declare title: string | null;
    declare patient: Record<string, unknown> | null;
    declare patientId: string | null;
    declare description: string | null;
    declare start: string | null;
    declare end: string | null;
    declare allDay: boolean | null;
    declare recurrence: string | null;
    declare duration: string | null;
    declare status: string | null;
    declare missedArrivalReportedAt: Date | null;
    declare missedArrivalReportedBy: string | null;
    declare missedArrivalResolvedAt: Date | null;
    declare missedArrivalResolvedBy: string | null;
    declare missedArrivalResolution: string | null;
    declare noShowBillingDecision: string | null;
    declare appointmentPaymentStatus: 'unpaid' | 'partial' | 'paid' | null;
    declare appointmentPaidAmount: number | null;
    declare appointmentPaidAt: string | null;
    declare appointmentPaymentMethod: string | null;
    declare appointmentPaymentNote: string | null;
    declare appointmentPaymentRecordedBy: string | null;
    declare appointmentExpectedAmount: number | null;
    declare appointmentOriginalAmount: number | null;
    declare appointmentPriceAdjustment: 'DISCOUNT' | 'COMPLIMENTARY' | null;
    declare appointmentPriceAdjustmentNote: string | null;
    declare appointmentPriceAdjustedBy: string | null;
    declare appointmentPriceAdjustedAt: Date | null;
    declare appointmentNetAmount: number | null;
    declare appointmentVatRate: number | null;
    declare appointmentPriceRecordedAt: Date | null;
    declare appointmentPaymentHistoryKnown: boolean;
    declare erasable: boolean | null;
    declare eventTypeId: string | null;
    declare invoiceId: string | null;
}

AgendaEvent.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        calendarId: DataTypes.STRING,
        structureId: { type: DataTypes.UUID, allowNull: true },
        recurringEventId: { type: DataTypes.STRING, allowNull: true },
        isFirstInstance: DataTypes.BOOLEAN,
        title: DataTypes.STRING,
        patient: DataTypes.JSON,
        patientId: { type: DataTypes.UUID, allowNull: true },
        description: DataTypes.STRING,
        start: { type: DataTypes.STRING, allowNull: true },
        end: { type: DataTypes.STRING, allowNull: true },
        allDay: DataTypes.BOOLEAN,
        recurrence: DataTypes.STRING,
        duration: DataTypes.STRING,
        status: DataTypes.STRING,
        missedArrivalReportedAt: { type: DataTypes.DATE, allowNull: true },
        missedArrivalReportedBy: { type: DataTypes.UUID, allowNull: true },
        missedArrivalResolvedAt: { type: DataTypes.DATE, allowNull: true },
        missedArrivalResolvedBy: { type: DataTypes.UUID, allowNull: true },
        missedArrivalResolution: { type: DataTypes.STRING(24), allowNull: true },
        noShowBillingDecision: { type: DataTypes.STRING(16), allowNull: true },
        appointmentPaymentStatus: { type: DataTypes.STRING(16), allowNull: true, defaultValue: 'unpaid' },
        appointmentPaidAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
        appointmentPaidAt: { type: DataTypes.DATEONLY, allowNull: true },
        appointmentPaymentMethod: { type: DataTypes.STRING, allowNull: true },
        appointmentPaymentNote: { type: DataTypes.TEXT, allowNull: true },
        appointmentPaymentRecordedBy: { type: DataTypes.UUID, allowNull: true },
        appointmentExpectedAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
        appointmentOriginalAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
        appointmentPriceAdjustment: { type: DataTypes.STRING(16), allowNull: true },
        appointmentPriceAdjustmentNote: { type: DataTypes.TEXT, allowNull: true },
        appointmentPriceAdjustedBy: { type: DataTypes.UUID, allowNull: true },
        appointmentPriceAdjustedAt: { type: DataTypes.DATE, allowNull: true },
        appointmentNetAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
        appointmentVatRate: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
        appointmentPriceRecordedAt: { type: DataTypes.DATE, allowNull: true },
        appointmentPaymentHistoryKnown: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        erasable: { type: DataTypes.BOOLEAN, defaultValue: true },
        eventTypeId: { type: DataTypes.UUID, allowNull: true },
        invoiceId: {
            type: DataTypes.UUID,
            allowNull: true,
            unique: 'agenda_events_invoice_id_unique'
        }
    },
    {
        sequelize,
        modelName: 'agendaEvent',
        tableName: 'agenda_events',
        indexes: [
            { name: 'agenda_events_structure_start_status_idx', fields: ['structureId', 'start', 'status'] },
            { name: 'agenda_events_calendar_start_status_idx', fields: ['calendarId', 'start', 'status'] },
            { name: 'agenda_events_patient_start_idx', fields: ['patientId', 'start'] },
            { name: 'agenda_events_missed_arrival_idx', fields: ['structureId', 'missedArrivalReportedAt', 'missedArrivalResolvedAt'] },
            { name: 'agenda_events_payment_status_idx', fields: ['structureId', 'appointmentPaymentStatus', 'appointmentPaidAt'] }
        ]
    }
);

export default AgendaEvent;

