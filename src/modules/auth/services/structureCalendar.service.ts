import { Op, Transaction } from 'sequelize';
import StructureUser from '../models/structureUser.model.js';
import StructureUserAvailability from '../models/structureUserAvailability.model.js';
import StructureAvailability from '../models/structureAvailability.model.js';
import Structure from '../models/structure.model.js';
import { resolveEffectiveRole, RoleCode } from '../rbac/roles.js';
import { AvailabilityValidationError, emptyAvailabilitySchedule, isAvailabilityMode, normalizeAvailabilitySchedule } from './userAvailabilityPolicy.service.js';

export function defaultCalendarEnabled(role: RoleCode): boolean {
    return role !== RoleCode.OWNER && role !== RoleCode.SECRETARY;
}
export function hasCalendarFields(value: Record<string, any>): boolean {
    return ['calendarEnabled', 'availabilityMode', 'userAvailabilities'].some(key => Object.prototype.hasOwnProperty.call(value, key));
}
export async function projectStructureCalendar(user: Record<string, any>, tenantId: string | null, structureId: string | null): Promise<Record<string, any>> {
    const [projected] = await projectStructureCalendars([user], tenantId, structureId);
    return projected;
}
export async function projectStructureCalendars(users: Record<string, any>[], tenantId: string | null, structureId: string | null): Promise<Record<string, any>[]> {
    const validStructure = tenantId && structureId ? await Structure.findOne({ where: { id: structureId, tenantId }, attributes: ['id'] }) : null;
    const ids = users.map(user => user.id).filter(Boolean);
    const [memberships, rows] = validStructure && ids.length ? await Promise.all([
        StructureUser.findAll({ where: { structureId: structureId!, userId: { [Op.in]: ids } } }),
        StructureUserAvailability.findAll({ where: { structureId: structureId!, userId: { [Op.in]: ids } }, order: [['day', 'ASC']] })
    ]) : [[], []];
    const byUser = new Map(memberships.map(member => [member.userId, member]));
    return users.map(user => {
        const member = byUser.get(user.id);
        const schedule = rows.filter(row => row.userId === user.id).map(row => row.get({ plain: true }));
        return { ...user,
            calendarRole: resolveEffectiveRole(user.role, member?.role),
            calendarEnabled: member?.calendarEnabled ?? false,
            availabilityMode: member?.availabilityMode ?? 'INHERIT_STRUCTURE',
            userAvailabilities: member ? (schedule.length ? schedule : emptyAvailabilitySchedule()) : [] };
    });
}

/** Saves only the selected structure. Omitted fields preserve the saved configuration. */
export async function saveStructureCalendar(userId: string, structureId: string, payload: Record<string, any>, transaction: Transaction): Promise<void> {
    const membership = await StructureUser.findOne({ where: { userId, structureId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!membership) throw new AvailabilityValidationError('Utente non assegnato alla sede selezionata');
    if (payload.calendarEnabled !== undefined && typeof payload.calendarEnabled !== 'boolean') {
        throw new AvailabilityValidationError('Abilitazione agenda non valida');
    }
    const enabled = payload.calendarEnabled ?? membership.calendarEnabled;
    const mode = enabled ? payload.availabilityMode ?? membership.availabilityMode : membership.availabilityMode;
    if (!isAvailabilityMode(mode)) throw new AvailabilityValidationError('Modalita disponibilita non valida');
    let normalized: ReturnType<typeof normalizeAvailabilitySchedule> | null = null;
    // Disabling only stops new assignments; the saved schedule survives reactivation.
    if (enabled && mode === 'CUSTOM') {
        const schedule = payload.userAvailabilities ?? (await StructureUserAvailability.findAll({ where: { userId, structureId }, transaction, order: [['day', 'ASC']] })).map(row => row.get({ plain: true }));
        const opening = (await StructureAvailability.findAll({ where: { structureId }, transaction })).map(row => row.get({ plain: true }));
        normalized = normalizeAvailabilitySchedule(schedule, mode, opening);
    }
    await membership.update({ calendarEnabled: enabled, availabilityMode: mode }, { transaction });
    if (normalized) {
        await StructureUserAvailability.destroy({ where: { userId, structureId }, transaction });
        await StructureUserAvailability.bulkCreate(normalized.map(day => ({ ...day, userId, structureId })), { transaction });
    }
}
