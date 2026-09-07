import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface InvoiceAgendaEventAttributes {
    id: string;
    invoiceId: string;
    agendaEventId: string;
    /** Servizio di catalogo scelto per trasformare l'appuntamento in una riga fattura. */
    serviceId?: string | null;
    /** Fiscal cancellation releases the appointment without deleting its document audit trail. */
    releasedAt?: Date | null;
}

export type InvoiceAgendaEventCreationAttributes = Optional<InvoiceAgendaEventAttributes, 'id'>;

/**
 * Collegamento auditabile tra documenti e appuntamenti.
 *
 * `agendaEventId` è univoco: una seduta può appartenere a un solo documento. `invoiceId` non è
 * univoco perché una fattura può raggruppare più sedute. La tabella affianca i campi storici
 * `Invoice.agendaEventId`/`AgendaEvent.invoiceId` senza richiedere migrazioni distruttive.
 */
export class InvoiceAgendaEvent
    extends Model<InvoiceAgendaEventAttributes, InvoiceAgendaEventCreationAttributes>
    implements InvoiceAgendaEventAttributes {
    declare id: string;
    declare invoiceId: string;
    declare agendaEventId: string;
    declare serviceId: string | null;
    declare releasedAt: Date | null;
}

InvoiceAgendaEvent.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        invoiceId: { type: DataTypes.UUID, allowNull: false },
        agendaEventId: {
            type: DataTypes.UUID,
            allowNull: false
        },
        serviceId: { type: DataTypes.UUID, allowNull: true },
        releasedAt: { type: DataTypes.DATE, allowNull: true }
    },
    {
        sequelize,
        modelName: 'invoiceAgendaEvent',
        tableName: 'invoice_agenda_events',
        indexes: [
            { name: 'invoice_agenda_events_invoice_id_idx', fields: ['invoiceId'] },
            { name: 'invoice_agenda_events_active_event_unique', unique: true, fields: ['agendaEventId'], where: { releasedAt: null } }
        ]
    }
);

export default InvoiceAgendaEvent;
