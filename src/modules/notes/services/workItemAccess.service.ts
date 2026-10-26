import {Request} from 'express';
import {Op, Transaction} from 'sequelize';
import {getCurrentTenantId} from '../../../middleware/auth.js';
import {getGrantedPermissions} from '../../../middleware/rbac.js';
import {resolveGrantedScope} from '../../auth/rbac/permissions.js';
import {resolveEffectiveRole, RoleCode} from '../../auth/rbac/roles.js';
import StructureUser from '../../auth/models/structureUser.model.js';
import TenantUser from '../../auth/models/tenantUser.model.js';
import User from '../../auth/models/user.model.js';
import Note from '../models/note.model.js';
import NoteAssignment from '../models/noteAssignment.model.js';
import Reminder from '../models/reminder.model.js';
import ReminderAssignment from '../models/reminderAssignment.model.js';
import ReminderAlertState from '../models/reminderAlertState.model.js';
import {contactReminderOccurrenceAt, isPatientContactReminder, sameRomeReminderDay} from './patientContactReminder.policy.js';

export interface WorkItemUserSummary {
    id: string;
    name: string | null;
    surname: string | null;
    role?: RoleCode | null;
}

const CLINICAL_NOTE_ROLES = new Set<RoleCode>([
    RoleCode.OWNER,
    RoleCode.THERAPIST,
    RoleCode.PHYSIATRIST,
    RoleCode.ORTHOPEDIST,
    RoleCode.EXTERNAL_COLLABORATOR
]);

export function normalizeAssignedUserIds(value: unknown, legacyId: unknown, fallbackId: string): string[] {
    const requested = Array.isArray(value) ? value : legacyId ? [legacyId] : [fallbackId];
    return [...new Set(requested
        .filter((id): id is string => typeof id === 'string')
        .map(id => id.trim())
        .filter(Boolean))];
}

export function isClinicalNoteRole(role: RoleCode | null | undefined): boolean {
    return !!role && CLINICAL_NOTE_ROLES.has(role);
}

export async function assignableUsers(req: Request, noteType?: string): Promise<WorkItemUserSummary[]> {
    const tenantId = getCurrentTenantId(req);
    const structureId = req.access?.structureId;
    if (!structureId) return [];

    const [structureRows, tenantRows] = await Promise.all([
        StructureUser.findAll({where: {structureId}, raw: true}),
        TenantUser.findAll({where: {tenantId, deactivatedAt: null}, raw: true})
    ]);
    const membershipByUser = new Map((tenantRows as any[]).map(row => [row.userId, row]));
    const roleByUser = new Map<string, RoleCode | null>();
    for (const row of structureRows as any[]) {
        const membership = membershipByUser.get(row.userId);
        if (!membership) continue;
        const role = resolveEffectiveRole(membership.role, row.role);
        if (!role || role === RoleCode.PATIENT) continue;
        if (noteType === 'CLINICAL' && !isClinicalNoteRole(role)) continue;
        roleByUser.set(row.userId, role);
    }

    if (!roleByUser.size) return [];
    const users = await User.findAll({
        where: {id: {[Op.in]: [...roleByUser.keys()]}, deactivatedAt: null},
        attributes: ['id', 'name', 'surname'],
        raw: true
    });
    return (users as any[])
        .map(user => ({id: user.id, name: user.name ?? null, surname: user.surname ?? null, role: roleByUser.get(user.id) ?? null}))
        .sort((a, b) => `${a.name ?? ''} ${a.surname ?? ''}`.localeCompare(`${b.name ?? ''} ${b.surname ?? ''}`, 'it'));
}

export async function validateAssignedUsers(
    req: Request,
    userIds: string[],
    noteType?: string
): Promise<WorkItemUserSummary[] | null> {
    if (!userIds.length) return null;
    const available = await assignableUsers(req, noteType);
    const byId = new Map(available.map(user => [user.id, user]));
    if (userIds.some(id => !byId.has(id))) return null;
    return userIds.map(id => byId.get(id)!);
}

export async function assignedNoteIds(schema: string, userId: string): Promise<string[]> {
    const rows = await NoteAssignment.schema(schema).findAll({where: {userId}, attributes: ['noteId'], raw: true});
    return (rows as any[]).map(row => row.noteId);
}

export async function assignedReminderIds(schema: string, userId: string): Promise<string[]> {
    const rows = await ReminderAssignment.schema(schema).findAll({where: {userId}, attributes: ['reminderId'], raw: true});
    return (rows as any[]).map(row => row.reminderId);
}

export async function visibleNoteWhere(req: Request): Promise<Record<symbol, unknown>> {
    const userId = req.access!.userId;
    const assignedIds = await assignedNoteIds(req.tenantSchema!, userId);
    const visibility = {[Op.or]: [{createdByUserId: userId}, {id: {[Op.in]: assignedIds}}]};
    const mayReadClinical = (await assignableUsers(req, 'CLINICAL')).some(user => user.id === userId);
    return mayReadClinical
        ? visibility
        : {[Op.and]: [{type: {[Op.ne]: 'CLINICAL'}}, visibility]};
}

export async function visibleReminderWhere(req: Request): Promise<Record<symbol, unknown>> {
    const userId = req.access!.userId;
    const assignedIds = await assignedReminderIds(req.tenantSchema!, userId);
    return {[Op.or]: [{createdByUserId: userId}, {id: {[Op.in]: assignedIds}}]};
}

export async function noteAssignmentIds(schema: string, noteId: string): Promise<string[]> {
    const rows = await NoteAssignment.schema(schema).findAll({where: {noteId}, attributes: ['userId'], raw: true});
    return (rows as any[]).map(row => row.userId);
}

export async function reminderAssignmentIds(schema: string, reminderId: string): Promise<string[]> {
    const rows = await ReminderAssignment.schema(schema).findAll({where: {reminderId}, attributes: ['userId'], raw: true});
    return (rows as any[]).map(row => row.userId);
}

export async function replaceNoteAssignments(
    schema: string, noteId: string, userIds: string[], assignedByUserId: string, transaction: Transaction
): Promise<void> {
    const model = NoteAssignment.schema(schema);
    await model.destroy({where: {noteId, userId: {[Op.notIn]: userIds}}, transaction});
    await model.bulkCreate(userIds.map(userId => ({noteId, userId, assignedByUserId})), {
        transaction,
        ignoreDuplicates: true
    });
}

export async function replaceReminderAssignments(
    schema: string, reminderId: string, userIds: string[], assignedByUserId: string, transaction: Transaction
): Promise<void> {
    const model = ReminderAssignment.schema(schema);
    await model.destroy({where: {reminderId, userId: {[Op.notIn]: userIds}}, transaction});
    await model.bulkCreate(userIds.map(userId => ({reminderId, userId, assignedByUserId})), {
        transaction,
        ignoreDuplicates: true
    });
}

async function userSummaries(userIds: string[]): Promise<Map<string, WorkItemUserSummary>> {
    const uniqueIds = [...new Set(userIds.filter(Boolean))];
    if (!uniqueIds.length) return new Map();
    const users = await User.findAll({
        where: {id: {[Op.in]: uniqueIds}},
        attributes: ['id', 'name', 'surname'],
        raw: true
    });
    return new Map((users as any[]).map(user => [user.id, {
        id: user.id,
        name: user.name ?? null,
        surname: user.surname ?? null
    }]));
}

function hasPermission(req: Request, resource: 'note' | 'reminder', action: 'update' | 'delete'): boolean {
    return resolveGrantedScope(getGrantedPermissions(req), resource, action) !== null || !!req.user?.isSuperAdmin;
}

export async function serializeNotes(req: Request, notes: Note[]): Promise<any[]> {
    const ids = notes.map(note => note.id);
    const rows = ids.length ? await NoteAssignment.schema(req.tenantSchema!).findAll({
        where: {noteId: {[Op.in]: ids}}, raw: true
    }) : [];
    const byItem = new Map<string, string[]>();
    for (const row of rows as any[]) {
        byItem.set(row.noteId, [...(byItem.get(row.noteId) ?? []), row.userId]);
    }
    const people = await userSummaries([
        ...(rows as any[]).map(row => row.userId),
        ...notes.flatMap(note => [note.createdByUserId, note.updatedByUserId ?? ''])
    ]);
    const currentUserId = req.access!.userId;
    return notes.map(note => {
        const assignedUserIds = byItem.get(note.id) ?? [];
        const isCreator = note.createdByUserId === currentUserId;
        const isAssigned = assignedUserIds.includes(currentUserId);
        const collaborative = note.type !== 'CLINICAL' && isAssigned;
        return {
            ...note.get({plain: true}),
            assignedUserIds,
            assignedUsers: assignedUserIds.map(id => people.get(id)).filter(Boolean),
            createdBy: people.get(note.createdByUserId) ?? null,
            updatedBy: note.updatedByUserId ? people.get(note.updatedByUserId) ?? null : null,
            capabilities: {
                canEdit: (isCreator || collaborative) && hasPermission(req, 'note', 'update'),
                canManageAssignments: isCreator && hasPermission(req, 'note', 'update'),
                canDelete: isCreator && hasPermission(req, 'note', 'delete')
            }
        };
    });
}

export async function serializeReminders(req: Request, reminders: Reminder[], options: {transaction?: Transaction; reference?: Date} = {}): Promise<any[]> {
    const ids = reminders.map(reminder => reminder.id);
    const rows = ids.length ? await ReminderAssignment.schema(req.tenantSchema!).findAll({
        where: {reminderId: {[Op.in]: ids}}, raw: true, transaction: options.transaction
    }) : [];
    const byItem = new Map<string, string[]>();
    for (const row of rows as any[]) {
        byItem.set(row.reminderId, [...(byItem.get(row.reminderId) ?? []), row.userId]);
    }
    const people = await userSummaries([
        ...(rows as any[]).map(row => row.userId),
        ...reminders.flatMap(reminder => [reminder.createdByUserId, reminder.updatedByUserId ?? ''])
    ]);
    const currentUserId = req.access!.userId;
    const automaticIds = reminders.filter(isPatientContactReminder).map(row => row.id);
    const states = automaticIds.length ? await ReminderAlertState.schema(req.tenantSchema!).findAll({where: {reminderId: {[Op.in]: automaticIds}, userId: currentUserId}, transaction: options.transaction}) : [];
    const statesById = new Map(states.map(state => [state.reminderId, state]));
    return reminders.map(reminder => {
        const assignedUserIds = byItem.get(reminder.id) ?? [];
        const isCreator = reminder.createdByUserId === currentUserId;
        const isAssigned = assignedUserIds.includes(currentUserId);
        const canUpdate = hasPermission(req, 'reminder', 'update');
        const automatic = isPatientContactReminder(reminder);
        const state = statesById.get(reminder.id), reference = options.reference ?? new Date();
        let occurrence = contactReminderOccurrenceAt(reminder, reference);
        if (automatic && ['OPEN', 'SNOOZED'].includes(reminder.status)) {
            if (state?.snoozedUntil) occurrence = state.snoozedUntil;
            else if (state?.scheduledFor && state.deliveredAt && sameRomeReminderDay(state.deliveredAt, reference)) occurrence = state.scheduledFor;
        }
        return {
            ...reminder.get({plain: true}),
            occurrenceAt: occurrence?.toISOString() ?? null,
            assignedUserIds,
            assignedUsers: assignedUserIds.map(id => people.get(id)).filter(Boolean),
            createdBy: people.get(reminder.createdByUserId) ?? null,
            updatedBy: reminder.updatedByUserId ? people.get(reminder.updatedByUserId) ?? null : null,
            capabilities: {
                canEdit: (isCreator || isAssigned) && canUpdate,
                canManageAssignments: !automatic && isCreator && canUpdate,
                canDelete: isCreator && hasPermission(req, 'reminder', 'delete'),
                canComplete: (isCreator || isAssigned) && canUpdate,
                canSnooze: isAssigned && canUpdate
            }
        };
    });
}
