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
    erasable?: boolean | null;
    eventTypeId?: string | null;
    /**
     * Fattura emessa per questo appuntamento (1 fattura ↔ 1 appuntamento nel flusso storico).
     *
     * È l'unica fonte di verità per le colonne "documento fiscale" e "stato pagamento"
     * della dashboard: se valorizzato il documento è emesso e lo stato del pagamento è
     * quello della fattura collegata. Nessuno stato di pagamento viene duplicato qui.
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
            { name: 'agenda_events_patient_start_idx', fields: ['patientId', 'start'] }
        ]
    }
);

export default AgendaEvent;

