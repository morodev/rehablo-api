import {Request} from 'express';
import {Op, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {getGrantedPermissions, getUserId, scopeWhere} from '../../../middleware/rbac.js';
import {getCurrentTenantId} from '../../../middleware/auth.js';
import {resolveGrantedScope} from '../../auth/rbac/permissions.js';
import {Structure, User} from '../../auth/models/index.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import Patient from '../models/patient.model.js';
import {PatientContactFollowUp} from '../models/patientContactFollowUp.model.js';
import Reminder from '../../notes/models/reminder.model.js';
import {replaceReminderAssignments, serializeReminders, validateAssignedUsers} from '../../notes/services/workItemAccess.service.js';
import {CONTACT_REMINDER_SOURCE, hasUsablePatientContact, tomorrowContactReminderAt} from '../../notes/services/patientContactReminder.policy.js';
import {completePatientContactReminders} from './patientContactCompletion.service.js';

const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const fail = (statusCode: number, message: string): never => {throw Object.assign(new Error(message), {statusCode});};
export interface PatientContactFollowUpView {hasUsableContact: boolean; suppressed: boolean; reminder: any | null; canRemind: boolean;}

async function patientContext(req: Request, transaction?: Transaction, lock = false) {
    const structureId = req.access?.structureId, userId = getUserId(req), patientId = req.params.patientId;
    if (!structureId) fail(400, 'Seleziona una sede');
    if (!uuid.test(patientId)) fail(400, 'Paziente non valido');
    const patient = await Patient.schema(req.tenantSchema!).findOne({where: {id: patientId, structureId,
        archivedAt: null, ...scopeWhere(req, {ownerField: 'userId', structureField: 'structureId', includeUnassigned: false})},
        transaction, ...(lock ? {lock: transaction!.LOCK.UPDATE} : {})});
    if (!patient) fail(404, 'Paziente non trovato');
    return {patient: patient!, structureId: structureId!, userId, patientId};
}
async function currentReminder(schema: string, key: {userId: string; patientId: string; structureId: string}, transaction?: Transaction) {
    return Reminder.schema(schema).findOne({where: {createdByUserId: key.userId, assigneeUserId: key.userId,
        patientId: key.patientId, structureId: key.structureId, sourceType: CONTACT_REMINDER_SOURCE,
        status: {[Op.in]: ['OPEN', 'SNOOZED']}}, transaction});
}
async function mayRemind(req: Request): Promise<boolean> {
    const permission = req.user?.isSuperAdmin || resolveGrantedScope(getGrantedPermissions(req), 'reminder', 'create');
    return !!permission && !!await validateAssignedUsers(req, [getUserId(req)]);
}
async function view(req: Request, context: Awaited<ReturnType<typeof patientContext>>, transaction?: Transaction): Promise<PatientContactFollowUpView> {
    const key = {userId: context.userId, patientId: context.patientId, structureId: context.structureId};
    const plain = context.patient.get({plain: true});
    await completePatientContactReminders(req.tenantSchema!, plain, transaction);
    const [preference, reminder, canRemind] = await Promise.all([
        PatientContactFollowUp.schema(req.tenantSchema!).findOne({where: key, transaction}),
        currentReminder(req.tenantSchema!, key, transaction), mayRemind(req)
    ]);
    const serialized = reminder ? (await serializeReminders(req, [reminder], {transaction}))[0] : null;
    return {hasUsableContact: hasUsablePatientContact(plain), suppressed: !!preference?.get('suppressedAt'),
        reminder: serialized, canRemind: canRemind && !hasUsablePatientContact(plain)};
}
export async function getPatientContactFollowUp(req: Request): Promise<PatientContactFollowUpView> {
    return view(req, await patientContext(req));
}
export async function setPatientContactFollowUp(req: Request): Promise<PatientContactFollowUpView> {
    const action = req.body?.action;
    if (!['suppress', 'remind', 'reset'].includes(action)) fail(422, 'Scegli una preferenza valida');
    if (action === 'remind' && !await mayRemind(req)) fail(403, 'Non puoi creare promemoria in questa sede');
    return sequelize.transaction(async transaction => {
        const context = await patientContext(req, transaction, true);
        const {patient, structureId, userId, patientId} = context, schema = req.tenantSchema!;
        const key = {userId, patientId, structureId};
        await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', {transaction,
            replacements: {key: `${schema}:patient-contact-follow-up:${structureId}:${patientId}:${userId}`}});
        const [preference] = await PatientContactFollowUp.schema(schema).findOrCreate({where: key,
            defaults: {...key, suppressedAt: null, reminderId: null}, transaction});
        if (action !== 'remind') await preference.update({suppressedAt: action === 'suppress' ? new Date() : null}, {transaction});
        else if (!hasUsablePatientContact(patient.get({plain: true}))) {
            let reminder = await currentReminder(schema, key, transaction);
            if (!reminder) {
                let event: AgendaEvent | null = null;
                if (req.body.agendaEventId != null) {
                    if (!uuid.test(req.body.agendaEventId)) fail(422, 'Appuntamento non valido');
                    const scope = req.user?.isSuperAdmin ? 'tenant' : resolveGrantedScope(getGrantedPermissions(req), 'agenda', 'read');
                    if (!scope) fail(403, 'Appuntamento non accessibile');
                    event = await AgendaEvent.schema(schema).findOne({where: {id: req.body.agendaEventId, structureId,
                        ...(scope === 'own' ? {calendarId: userId} : {})}, transaction});
                    if (!event || (event.patientId ?? event.patient?.id) !== patientId) fail(404, 'Appuntamento non trovato per questo paziente');
                }
                const [structure, operator, professional] = await Promise.all([
                    Structure.findOne({where: {id: structureId, tenantId: getCurrentTenantId(req)}, attributes: ['id', 'name'], transaction}),
                    User.findByPk(userId, {attributes: ['id', 'name', 'surname'], transaction}),
                    event?.calendarId ? User.findByPk(event.calendarId, {attributes: ['id', 'name', 'surname'], transaction}) : null
                ]);
                const patientName = [patient.name, patient.surname].filter(Boolean).join(' ').trim();
                const date = event?.start ? new Intl.DateTimeFormat('it-IT', {timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'short'}).format(new Date(event.start)) : null;
                const description = [`Paziente: ${patientName}.`, 'Aggiungere almeno un numero di telefono o un indirizzo email valido.',
                    structure?.name ? `Sede: ${structure.name}.` : null,
                    event ? `Appuntamento: ${event.title || 'Seduta'}${date ? `, ${date}` : ''}.` : null,
                    professional ? `Professionista: ${[professional.name, professional.surname].filter(Boolean).join(' ')}.` : null,
                    operator ? `Operatore: ${[operator.name, operator.surname].filter(Boolean).join(' ')}.` : null].filter(Boolean).join('\n');
                const first = tomorrowContactReminderAt();
                reminder = await Reminder.schema(schema).create({title: `Aggiungere recapiti per ${patientName}`.slice(0, 255), description,
                    dueAt: first, remindAt: first, dueAllDay: false, status: 'OPEN', priority: 'NORMAL',
                    assigneeUserId: userId, createdByUserId: userId, structureId, patientId,
                    agendaEventId: event?.id ?? null, noteId: null, sourceType: CONTACT_REMINDER_SOURCE}, {transaction});
                await replaceReminderAssignments(schema, reminder.id, [userId], userId, transaction);
            }
            await preference.update({reminderId: reminder.id, suppressedAt: null}, {transaction});
        }
        return view(req, context, transaction);
    });
}
