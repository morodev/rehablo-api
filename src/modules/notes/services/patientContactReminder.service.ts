import {Op, Transaction} from 'sequelize';
import Tenant from '../../auth/models/tenant.model.js';
import Patient from '../../patients/models/patient.model.js';
import Reminder from '../models/reminder.model.js';
import {completePatientContactReminders} from '../../patients/services/patientContactCompletion.service.js';
import {CONTACT_REMINDER_SOURCE, hasUsablePatientContact, isPatientContactReminder} from './patientContactReminder.policy.js';

/** Also catches contact writes made outside the ordinary patient editor. */
export async function reconcilePatientContactReminders(schema: string, reminders: Reminder[], transaction?: Transaction): Promise<void> {
    const automatic = reminders.filter(row => isPatientContactReminder(row) && ['OPEN', 'SNOOZED'].includes(row.status));
    const ids = [...new Set(automatic.map(row => row.patientId).filter(Boolean))] as string[];
    if (!ids.length) return;
    const patients = await Patient.schema(schema).findAll({where: {id: {[Op.in]: ids}}, transaction,
        attributes: ['id', 'emails', 'phoneNumbers', 'archivedAt']});
    const byId = new Map(patients.map(patient => [patient.id, patient.get({plain: true})]));
    for (const reminder of automatic) {
        const patient = byId.get(reminder.patientId!);
        if (patient && !patient.archivedAt && !hasUsablePatientContact(patient)) continue;
        if (patient) await completePatientContactReminders(schema, patient, transaction);
        const status = !patient || patient.archivedAt ? 'CANCELLED' : 'DONE';
        await reminder.update({status, completedAt: new Date(), snoozedUntil: null}, {transaction});
    }
}
export async function sweepPatientContactReminders(): Promise<void> {
    const tenants = await Tenant.findAll({attributes: ['id']});
    for (const tenant of tenants) {
        const schema = 'rehablo_' + tenant.id.replaceAll('-', '');
        try {
            const reminders = await Reminder.schema(schema).findAll({where: {sourceType: CONTACT_REMINDER_SOURCE, status: {[Op.in]: ['OPEN', 'SNOOZED']}}});
            await reconcilePatientContactReminders(schema, reminders);
        } catch (error) {console.error('[contact-reminders] reconciliation failed', {tenantId: tenant.id, error});}
    }
}
export function startPatientContactReminderSweep(): NodeJS.Timeout {
    let running = false;
    const run = async () => {if (running) return; running = true; try {await sweepPatientContactReminders();} catch (error) {console.error('[contact-reminders] reconciliation failed', error);} finally {running = false;}};
    void run(); const timer = setInterval(() => void run(), 60_000); timer.unref(); return timer;
}
