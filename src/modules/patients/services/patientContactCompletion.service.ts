import {Op, Transaction} from 'sequelize';
import Reminder from '../../notes/models/reminder.model.js';
import {CONTACT_REMINDER_SOURCE, hasUsablePatientContact} from '../../notes/services/patientContactReminder.policy.js';

/** Called by patient model hooks, including invoice/quote contact writers in their transaction. */
export async function completePatientContactReminders(schema: string, patient: Record<string, any>, transaction?: Transaction): Promise<void> {
    if (!/^rehablo_[a-f0-9]{32}$/i.test(schema) || !patient.id || (!patient.archivedAt && !hasUsablePatientContact(patient))) return;
    await Reminder.schema(schema).update({status: patient.archivedAt ? 'CANCELLED' : 'DONE', completedAt: new Date(), snoozedUntil: null}, {
        where: {patientId: patient.id, sourceType: CONTACT_REMINDER_SOURCE, status: {[Op.in]: ['OPEN', 'SNOOZED']}}, transaction
    });
}
