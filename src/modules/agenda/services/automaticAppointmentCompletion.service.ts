import {QueryTypes, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import AgendaEvent from '../models/agendaEvent.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import {lockPatientSettlement} from '../../patients/services/patientSettlementPolicy.service.js';
import {shouldAutoCompleteAppointment} from './appointmentCompletion.policy.js';
import {completeAssignedPackageAutomatically} from './packageAssignment.service.js';

const patientIdOf = (event: AgendaEvent): string | null => {
    const value = event.get({plain: true});
    const patientId = value.patientId ?? (value.patient as Record<string, unknown> | null)?.id;
    return typeof patientId === 'string' ? patientId : null;
};

const completionAttributes = ['id', 'start', 'end', 'duration', 'status', 'recurrence', 'recurringEventId', 'invoiceId',
    'carePackageId', 'carePackageServiceId', 'packageReservationStatus', 'patientId', 'patient', 'structureId', 'eventTypeId',
    'missedArrivalReportedAt'];
const availableAttributes = new Map<string, string[]>();
async function attributesForSchema(schema: string): Promise<string[]> {
    const cached = availableAttributes.get(schema);
    if (cached) return cached;
    const columns = await sequelize.query<{columnName: string}>(
        "SELECT column_name AS \"columnName\" FROM information_schema.columns WHERE table_schema = :schema AND table_name = 'agenda_events'",
        {replacements: {schema}, type: QueryTypes.SELECT});
    const available = new Set(columns.map(column => column.columnName));
    const attributes = completionAttributes.filter(attribute => available.has(attribute));
    // Legacy tenants may be upgraded while this process stays alive; never freeze an incomplete projection.
    if (attributes.length === completionAttributes.length) availableAttributes.set(schema, attributes);
    return attributes;
}

/** Both callers hold patient/event locks; package consumption and the attendance update share their transaction. */
export async function completeLockedUntouchedAppointment(schema: string, event: AgendaEvent, transaction: Transaction,
    options: {now?: Date; actorId?: string | null} = {}): Promise<boolean> {
    if (!shouldAutoCompleteAppointment(event.get({plain: true}), options.now)) return false;
    if (event.get('carePackageId')) {
        const invoice = await InvoiceAgendaEvent.schema(schema).findOne({where: {agendaEventId: event.id, releasedAt: null},
            attributes: ['invoiceId'], transaction});
        if (invoice) return false;
    }
    const patch = event.get('carePackageId')
        ? await completeAssignedPackageAutomatically(schema, event, transaction, options.actorId ?? null)
        : {status: 'COMPLETED'};
    await event.update(patch, {transaction});
    return true;
}

/** Scheduler entry point for tenant-owned IDs; interactive callers keep their scoped controller lookup. */
export async function completeUntouchedAppointmentById(schema: string, eventId: string,
    options: {now?: Date; actorId?: string | null} = {}): Promise<boolean> {
    const attributes = await attributesForSchema(schema);
    return sequelize.transaction(async transaction => {
        const model = AgendaEvent.schema(schema);
        const snapshot = await model.findOne({where: {id: eventId}, attributes, transaction});
        if (!snapshot) return false;
        const patientId = patientIdOf(snapshot);
        if (!patientId) return false;
        await lockPatientSettlement(schema, patientId, transaction);
        const locked = await model.findOne({where: {id: eventId}, attributes, transaction, lock: transaction.LOCK.UPDATE});
        if (!locked) return false;
        if (patientIdOf(locked) !== patientId) throw Object.assign(new Error('Il paziente della seduta è cambiato: verifica rinviata'), {statusCode: 409});
        return completeLockedUntouchedAppointment(schema, locked, transaction, options);
    });
}
