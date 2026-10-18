import {assertBillingCapacity} from '../../billing/services/billingAccess.service.js';
import { updateCalendarPreferences } from './calendarPreference.controller.js';
import { defaultCalendarEnabled, hasCalendarFields, projectStructureCalendar, projectStructureCalendars, saveStructureCalendar } from '../services/structureCalendar.service.js';
import { Request, Response } from 'express';
import { Op, Transaction } from 'sequelize';
import bcrypt from 'bcryptjs';
import { sequelize } from '../../../config/database.js';
import {applyTeamMembershipChange, getTeamOffboardingImpact, parseTeamChange, runTeamMutation, sendTeamOffboardingError} from '../services/teamOffboarding.service.js';
import {acquireTenantActivityGate} from '../../../utils/tenantActivityGate.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { getGrantedPermissions, getSelectedStructureId, getUserId } from '../../../middleware/rbac.js';
import { hasPermission } from '../rbac/permissions.js';
import { DEFAULT_ROLE, isRoleCode, RoleCode, ROLE_DEFINITIONS } from '../rbac/roles.js';
import { sendForgotPasswordMail, signUpSendMail } from '../../../services/email.service.js';
import { AccountActionTokenError, consumeAccountActionToken, issueAccountActionToken } from '../services/accountActionToken.service.js';
import { revokeAllForUser, revokeForTenantMembership } from '../services/refreshToken.service.js';
import {
    Tenant,
    TenantUser,
    User,
    Structure,
    StructureUser,
    UserEmail
} from '../models/index.js';
import { validateUserStructureSelection } from '../services/userStructurePolicy.service.js';
import { findUserByIdentityEmail } from '../services/identity.service.js';
import { normalizeIdentityEmail } from '../models/userEmail.model.js';
import {
    AvailabilityValidationError,
} from '../services/userAvailabilityPolicy.service.js';
import {
    findTeamMemberEmailConflict,
    isEmailUniqueConstraintError,
    registeredEmailConflict,
    TeamMemberEmailConflict
} from '../services/teamMemberEmailConflict.service.js';
import {
    FutureAppointmentsRequireReplacementError,
    getOperatorDeactivationImpact,
    InvalidReplacementOperatorError,
    reassignFutureAppointments
} from '../../agenda/services/operatorReassignment.service.js';

/**
 * Campi che non possono MAI arrivare dal client: determinano privilegi (super admin,
 * titolarità dello studio) o stato dell'account (verifica email, sospensione), e vanno
 * modificati solo dai flussi dedicati.
 */
const PROTECTED_USER_FIELDS = [
    'id',
    'authVersion',
    'isSuperAdmin',
    'isTenant',
    'isActive',
    'isPremium',
    'deactivatedAt',
    'createdAt',
    'updatedAt'
] as const;

function stripProtectedFields<T extends Record<string, any>>(payload: T): T {
    const sanitized = { ...payload };
    for (const field of PROTECTED_USER_FIELDS) {
        delete sanitized[field];
    }
    return sanitized;
}

/**
 * Carica l'utente bersaglio verificando che appartenga allo studio di chi effettua la
 * richiesta: senza questo controllo un amministratore potrebbe agire, conoscendone l'id,
 * su utenti di altri tenant.
 */
async function findTenantMember(req: Request, targetUserId: string) {
    const tenantId = getCurrentTenantId(req);
    const membership = await TenantUser.findOne({ where: { tenantId, userId: targetUserId } });
    if (!membership) return { tenantId, membership: null, user: null };

    const user = await User.findByPk(targetUserId, { attributes: { exclude: ['password'] } });
    return { tenantId, membership, user };
}

function validReplacementUserId(value: unknown): boolean {
    return value === undefined || value === null || (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
}

class TeamProfileError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
    }
}

function sendTeamMemberEmailConflict(res: Response, conflict: TeamMemberEmailConflict) {
    return sendErrorResponse(res, 409, conflict.message, {code: conflict.code, field: conflict.field});
}

const TEAM_PROFILE_FIELDS = [
    'name',
    'surname',
    'email',
    'calendarColor'
] as const;

async function serializeTeamMember(tenantId: string, userId: string, structureId: string | null) {
    const [user, membership, tenantStructures, assignments] = await Promise.all([
        User.findByPk(userId, { attributes: { exclude: ['password'] } }),
        TenantUser.findOne({ where: {tenantId, userId} }),
        Structure.findAll({where: {tenantId}, attributes: ['id']}),
        StructureUser.findAll({where: {userId}, attributes: ['structureId']})
    ]);
    if (!user || !membership) return null;

    const allowedIds = new Set(tenantStructures.map((structure) => structure.get('id') as string));
    return projectStructureCalendar({
        ...user.get({plain: true}),
        role: membership.get('role'),
        deactivatedAt: membership.get('deactivatedAt') ?? user.get('deactivatedAt') ?? null,
        structureIds: assignments
            .map((assignment) => assignment.get('structureId') as string)
            .filter((id) => allowedIds.has(id))
    }, tenantId, structureId);
}

async function syncTeamMemberStructures(
    userId: string,
    allowedIds: readonly string[],
    requestedIds: readonly string[],
    transaction: Transaction,
    role: RoleCode
): Promise<void> {
    const current = await StructureUser.findAll({
        where: {userId, structureId: {[Op.in]: [...allowedIds]}},
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    const currentIds = current.map((assignment) => assignment.get('structureId') as string);
    const requested = new Set(requestedIds);
    const toRemove = currentIds.filter((id) => !requested.has(id));
    const toAdd = requestedIds.filter((id) => !currentIds.includes(id));

    if (toRemove.length) {
        await StructureUser.destroy({
            where: {userId, structureId: {[Op.in]: toRemove}},
            transaction
        });
    }
    if (toAdd.length) {
        await StructureUser.bulkCreate(
            toAdd.map((structureId) => ({userId, structureId, role: null, calendarEnabled: defaultCalendarEnabled(role)})),
            {transaction}
        );
    }
}


export const createUser = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getCurrentTenantId(req);
    const newUser = { ...req.body };
    const calendarPayload = Object.fromEntries(['calendarEnabled', 'availabilityMode', 'userAvailabilities']
        .filter(key => Object.prototype.hasOwnProperty.call(newUser, key)).map(key => [key, newUser[key]]));
    for (const key of Object.keys(calendarPayload)) delete newUser[key];
    const selectedStructureId = getSelectedStructureId(req);

    const tenant: any = await Tenant.findByPk(tenantId, { include: Structure });
    if (!tenant) {
        return sendErrorResponse(res, 404, 'Tenant not found');
    }

    // Il ruolo non è una colonna di `users`: vive sulla membership `tenant_users`.
    const requestedRole = newUser.role;
    delete newUser.role;
    if (requestedRole !== undefined && !isRoleCode(requestedRole)) {
        return sendErrorResponse(res, 400, 'Ruolo non valido');
    }
    const role = isRoleCode(requestedRole) ? requestedRole : DEFAULT_ROLE;
    if (!ROLE_DEFINITIONS[role].assignable) {
        return sendErrorResponse(res, 400, 'Ruolo non assegnabile');
    }

    const normalizedEmail = normalizeIdentityEmail(newUser.email);
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return sendErrorResponse(res, 400, 'Email non valida', {code: 'INVALID_EMAIL', field: 'email'});
    }
    newUser.email = normalizedEmail;

    const existingEmailConflict = await findTeamMemberEmailConflict(tenantId, normalizedEmail);
    if (existingEmailConflict) {
        return sendTeamMemberEmailConflict(res, existingEmailConflict);
    }

    // Strutture in cui l'utente può operare. Se non specificate, viene assegnato a tutte
    // quelle del tenant (comportamento storico). Va estratto PRIMA della create:
    // non è una colonna di `users`.
    const requestedStructureIds: string[] | undefined = Array.isArray(newUser.structureIds)
        ? newUser.structureIds
        : undefined;
    delete newUser.structureIds;

    // Un utente invitato non è mai il titolare dello studio né un super admin: il titolare
    // nasce esclusivamente dalla registrazione (vedi `createTenant`).
    const structures = await tenant.getStructures();
    const allowedStructureIds = structures.map((structure: any) => structure.id as string);
    const uniqueRequestedIds = requestedStructureIds ? [...new Set(requestedStructureIds)] : undefined;
    const selectedStructureIds = role === RoleCode.OWNER
        ? allowedStructureIds
        : uniqueRequestedIds
          ?? ((role === RoleCode.SECRETARY || role === RoleCode.ADMIN_SECRETARY) || allowedStructureIds.length === 1
              ? allowedStructureIds
              : []);
    const structureSelectionError = validateUserStructureSelection(
        role,
        selectedStructureIds,
        allowedStructureIds
    );
    if (structureSelectionError) {
        return sendErrorResponse(res, 400, structureSelectionError);
    }

    const targetStructures = role === RoleCode.OWNER
        ? structures
        : structures.filter((structure: any) => selectedStructureIds.includes(structure.id));
    if (hasCalendarFields(calendarPayload) && (!selectedStructureId || !selectedStructureIds.includes(selectedStructureId))) {
        return sendErrorResponse(res, 400, 'La configurazione agenda richiede una sede selezionata assegnata al membro');
    }

    const userToCreate = stripProtectedFields(newUser);
    userToCreate.password = await bcrypt.hash(newUser.password, 12);
    userToCreate.isTenant = false;
    userToCreate.isSuperAdmin = false;
    userToCreate.isActive = false;
    userToCreate.authVersion = 0;

    let user: any;
    let verificationToken: string;
    try {
        user = await sequelize.transaction(async (transaction) => {
            await acquireTenantActivityGate(tenantId, transaction, 'shared');
            await assertBillingCapacity(tenantId, 'users', transaction);
            const created = await User.create(userToCreate, {transaction});
            await StructureUser.bulkCreate(targetStructures.map((structure: any) => ({
                userId: created.get('id') as string, structureId: structure.id,
                role: null, calendarEnabled: defaultCalendarEnabled(role), availabilityMode: 'INHERIT_STRUCTURE'
            })), {transaction});
            await tenant.addUser(created, {through: {role}, transaction});
            if (selectedStructureId && hasCalendarFields(calendarPayload)) {
                await saveStructureCalendar(created.get('id') as string, selectedStructureId, calendarPayload, transaction);
            }
            verificationToken = await issueAccountActionToken(created.get('id'), created.get('email'), 'verify_email', transaction);
            return created;
        });
    } catch (error) {
        if (error instanceof AvailabilityValidationError) return sendErrorResponse(res, 400, error.message);
        if (isEmailUniqueConstraintError(error)) {
            // Copre due richieste concorrenti che superano entrambe il pre-controllo.
            const conflict = await findTeamMemberEmailConflict(tenantId, normalizedEmail)
                ?? registeredEmailConflict();
            return sendTeamMemberEmailConflict(res, conflict);
        }
        throw error;
    }


    // Fire-and-forget, consistent with createTenant: a misconfigured/unreachable SMTP must NOT
    // roll back user creation NOR slow down the HTTP response (nodemailer can take several
    // seconds to time out against a bad/unreachable host). The verification link is also logged
    // to the console in non-production environments (see email.service.ts) as a fallback.
    signUpSendMail(user.get('email'), verificationToken!).catch((err) => {
        console.error('[createUser] verification email could not be sent:', err);
    });

    const createdTeamMember = await serializeTeamMember(tenantId, user.get('id') as string, selectedStructureId);
    return sendSuccessResponse(res, 201, createdTeamMember, 'User for tenant created');
});

export const findAllUsersTenantByTenantId = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getCurrentTenantId(req);

    const tenant: any = await Tenant.findByPk(tenantId, {
        include: [
            { model: Structure },
            {
                model: User,
                attributes: { exclude: ['password'] },
                // Le strutture assegnate servono alla UI di gestione team per mostrare
                // e modificare dove ciascun utente può operare.
                include: [{ model: Structure }]
            }
        ]
    });

    if (!tenant) {
        return sendErrorResponse(res, 404, 'Tenant not found');
    }

    // Il ruolo vive sulla join `tenant_users`: lo si espone anche in forma piatta come
    // `role`, così la UI di gestione utenti non deve conoscere la struttura della join.
    const users = (tenant.users ?? []).map((user: any) => ({
        ...user.get({ plain: true }),
        role: user.tenantUser?.role ?? null,
        // La UI deve riflettere lo stesso stato effettivo usato dal login. In caso di
        // account legacy il rapporto con il centro puo' essere attivo mentre sulla
        // vecchia identita' globale e' ancora presente il blocco: nasconderlo farebbe
        // comparire "Account attivo" anche se l'accesso viene poi rifiutato.
        deactivatedAt: user.tenantUser?.deactivatedAt ?? user.deactivatedAt ?? null,
        structureIds: (user.structures ?? []).filter((structure: any) => structure.tenantId === tenantId).map((structure: any) => structure.id)
    }));

    return sendSuccessResponse(res, 200, await projectStructureCalendars(users, tenantId, getSelectedStructureId(req)), 'All users found');
});

/** Legacy callers share the transactional Team validation and selected-structure scope. */
export const updateUser = (req: Request, res: Response, next: import('express').NextFunction): void => {
    // The legacy profile endpoint never grants role or structure administration.
    req.body = {user: req.body.user, replacementUserId: req.body.replacementUserId, deferReassignment: req.body.deferReassignment};
    updateTeamMemberProfile(req, res, next);
};

/**
 * Le preferenze di calendario sono self-service: ognuno modifica le proprie.
 * Modificare quelle di un altro utente richiede il permesso `user:update`.
 */
function canEditUserPreferences(req: Request, targetUserId: string): boolean {
    const currentUserId = (req.user?.sub as string) ?? (req.user?.id as string);
    if (currentUserId === targetUserId) return true;
    if (req.user?.isSuperAdmin) return true;
    return hasPermission(getGrantedPermissions(req), 'user', 'update');
}

/** Legacy route now stores the viewer's preference without changing the target user. */
export const updateUserCalendarVisibility = (req: Request, res: Response, next: import('express').NextFunction): void => {
    req.body = { calendarId: req.params.userId, visible: req.body.calendarVisible };
    updateCalendarPreferences(req, res, next);
};

export const updateUserCalendarColor = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.params.userId;
    const tenantId = req.user?.tid ?? req.user?.tenants?.[0]?.id;
    if (!tenantId || req.user?.actor === 'patient' || !canEditUserPreferences(req, userId)) {
        return sendErrorResponse(res, 403, 'forbidden');
    }
    const targetMembership = await TenantUser.findOne({ where: { tenantId, userId, deactivatedAt: null } });
    if (!targetMembership) return sendErrorResponse(res, 403, 'Utente non accessibile nel centro corrente');
    await User.update({ calendarColor: req.body.calendarColor }, { where: { id: userId } });
    const updatedUser = await User.findByPk(userId, { attributes: { exclude: ['password'] } });
    const projected = updatedUser ? await projectStructureCalendar(updatedUser.get({plain: true}), getCurrentTenantId(req), getSelectedStructureId(req)) : null;
    return sendSuccessResponse(res, 200, projected, 'User updated');
});

/**
 * Salvataggio amministrativo atomico del membro del team.
 * Profilo, ruolo, sedi e disponibilita vengono confermati nella stessa transazione.
 */
export const updateTeamMemberProfile = asyncHandler(async (req: Request, res: Response) => {
    const targetUserId = req.params.userId;
    const tenantId = getCurrentTenantId(req);
    const body = req.body as {
        user?: Record<string, any>;
        role?: string;
        structureIds?: string[];
        replacementUserId?: string | null;
        deferReassignment?: boolean;
    };
    if (!validReplacementUserId(body.replacementUserId) || (body.deferReassignment !== undefined && typeof body.deferReassignment !== 'boolean')) {
        return sendErrorResponse(res, 400, 'Scelta di riassegnazione non valida');
    }
    let roleChanged = false;
    const selectedStructureId = getSelectedStructureId(req);
    if (body.replacementUserId && body.deferReassignment) {
        return sendErrorResponse(res, 400, 'Scegli se riassegnare ora oppure gestire gli appuntamenti in seguito');
    }

    try {
        const change = parseTeamChange({kind: 'profile', ...(body.role !== undefined ? {role: body.role} : {}),
            ...(body.structureIds !== undefined ? {structureIds: body.structureIds} : {})});
        await runTeamMutation(req, targetUserId, change, async (transaction, prepared) => {
            const [membership, targetUser, tenantStructures, currentAssignments] = await Promise.all([
                TenantUser.findOne({
                    where: {tenantId, userId: targetUserId},
                    transaction,
                    lock: transaction.LOCK.UPDATE
                }),
                User.findByPk(targetUserId, {transaction, lock: transaction.LOCK.UPDATE}),
                Structure.findAll({where: {tenantId}, attributes: ['id'], transaction}),
                StructureUser.findAll({where: {userId: targetUserId}, transaction})
            ]);
            if (!membership || !targetUser) {
                throw new TeamProfileError(404, 'Utente non trovato in questo studio');
            }

            const currentRole = membership.get('role') as RoleCode;
            const nextRoleValue = body.role ?? currentRole;
            if (!isRoleCode(nextRoleValue) || !ROLE_DEFINITIONS[nextRoleValue].assignable) {
                throw new TeamProfileError(400, 'Ruolo non valido o non assegnabile');
            }
            const nextRole = nextRoleValue as RoleCode;
            roleChanged = nextRole !== currentRole;

            if (roleChanged && targetUserId === getUserId(req)) {
                throw new TeamProfileError(403, 'Non puoi modificare il tuo ruolo');
            }
            if (targetUser.get('isTenant') && nextRole !== RoleCode.OWNER) {
                throw new TeamProfileError(409, 'Il ruolo del titolare dello studio non puo essere modificato');
            }

            const allowedIds = tenantStructures.map((structure) => structure.get('id') as string);
            const currentIds = currentAssignments
                .map((assignment) => assignment.get('structureId') as string)
                .filter((id) => allowedIds.includes(id));
            const requestedIds = nextRole === RoleCode.OWNER
                ? allowedIds
                : Array.isArray(body.structureIds)
                    ? [...new Set(body.structureIds)]
                    : currentIds;
            const structureError = validateUserStructureSelection(nextRole, requestedIds, allowedIds);
            if (structureError) throw new TeamProfileError(400, structureError);

            if (currentRole === RoleCode.OWNER && nextRole !== RoleCode.OWNER) {
                const owners = await TenantUser.count({where: {tenantId, role: RoleCode.OWNER}, transaction});
                if (owners <= 1) {
                    throw new TeamProfileError(409, 'Lo studio deve avere almeno un titolare');
                }
            }

            const rawUser = body.user && typeof body.user === 'object' ? body.user : null;
            const profile: Record<string, any> = {};
            if (rawUser) {
                for (const field of TEAM_PROFILE_FIELDS) {
                    if (Object.prototype.hasOwnProperty.call(rawUser, field)) {
                        profile[field] = rawUser[field];
                    }
                }
            }

            if (Object.prototype.hasOwnProperty.call(profile, 'email')) {
                const email = normalizeIdentityEmail(profile.email);
                if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    throw new TeamProfileError(400, 'Email non valida');
                }
                const [emailOwner, userWithEmail] = await Promise.all([
                    UserEmail.findOne({where: {normalizedEmail: email}, transaction}),
                    User.findOne({where: {email}, transaction})
                ]);
                if (
                    (emailOwner && emailOwner.get('userId') !== targetUserId) ||
                    (userWithEmail && userWithEmail.get('id') !== targetUserId)
                ) {
                    throw new TeamProfileError(409, 'Email gia in uso da un altro utente');
                }
                profile.email = email;
            }

            if (rawUser && hasCalendarFields(rawUser)) {
                if (!selectedStructureId || !allowedIds.includes(selectedStructureId) || !requestedIds.includes(selectedStructureId)) {
                    throw new TeamProfileError(400, 'La configurazione agenda richiede una sede selezionata assegnata al membro');
                }
                // Lock both calendars in the same order as appointment writers/reassignment.
                // Concurrent transfers in opposite directions must not lock source then target.
                await StructureUser.findAll({
                    where: {structureId: selectedStructureId, userId: {[Op.in]: [targetUserId, ...(body.replacementUserId ? [body.replacementUserId] : [])]}},
                    order: [['userId', 'ASC'], ['structureId', 'ASC']], transaction, lock: transaction.LOCK.UPDATE
                });
                const agenda = await StructureUser.findOne({
                    where: {userId: targetUserId, structureId: selectedStructureId}, transaction, lock: transaction.LOCK.UPDATE
                });
                // The membership offboarding already validated and applied its per-site agenda decision.
                const agendaResolved = prepared.affectedStructureIds.includes(selectedStructureId);
                if (agenda?.calendarEnabled && rawUser.calendarEnabled === false && !agendaResolved) {
                    const cutoff = new Date();
                    if (body.replacementUserId) {
                        await reassignFutureAppointments(tenantId, req.tenantSchema!, targetUserId, body.replacementUserId, transaction, cutoff, selectedStructureId);
                    } else if (body.deferReassignment !== true) {
                        const impact = await getOperatorDeactivationImpact(tenantId, req.tenantSchema!, targetUserId, cutoff, selectedStructureId, transaction);
                        if (impact.hasFutureAppointments) throw new FutureAppointmentsRequireReplacementError(impact);
                    }
                }
            }

            if (Object.keys(profile).length) {
                await targetUser.update(profile, {transaction});
            }

            if (profile.email) {
                const primaryEmail = await UserEmail.findOne({
                    where: {userId: targetUserId, isPrimary: true},
                    transaction,
                    lock: transaction.LOCK.UPDATE
                });
                if (primaryEmail) {
                    await primaryEmail.update({
                        email: profile.email,
                        normalizedEmail: profile.email
                    }, {transaction});
                } else {
                    await UserEmail.create({
                        userId: targetUserId,
                        email: profile.email,
                        normalizedEmail: profile.email,
                        isPrimary: true,
                        verifiedAt: targetUser.get('isActive') ? new Date() : null
                    }, {transaction});
                }
            }

            if (roleChanged) {
                await membership.update({role: nextRole}, {transaction});
            }
            if (requestedIds.length !== currentIds.length || requestedIds.some(id => !currentIds.includes(id))) {
                await syncTeamMemberStructures(targetUserId, allowedIds, requestedIds, transaction, nextRole);
            }

            if (rawUser && hasCalendarFields(rawUser) && selectedStructureId) {
                await saveStructureCalendar(targetUserId, selectedStructureId, rawUser, transaction);
            }
            if (roleChanged && nextRole === RoleCode.OWNER) await StructureUser.update({role: null}, {where: {
                userId: targetUserId, structureId: {[Op.in]: allowedIds}}, transaction});
            return {userId: targetUserId};
        });
    } catch (error) {
        if (sendTeamOffboardingError(res, error)) return;
        if (error instanceof FutureAppointmentsRequireReplacementError) {
            return sendErrorResponse(res, 409, error.message, {code: 'FUTURE_APPOINTMENTS_REQUIRE_REASSIGNMENT', impact: error.impact});
        }
        if (error instanceof InvalidReplacementOperatorError) {
            return sendErrorResponse(res, 409, error.message, {code: 'INVALID_REPLACEMENT_OPERATOR'});
        }
        if (error instanceof TeamProfileError || error instanceof AvailabilityValidationError) {
            const status = error instanceof TeamProfileError ? error.status : 400;
            return sendErrorResponse(res, status, error.message);
        }
        throw error;
    }

    if (roleChanged) {
        await revokeAllForUser(targetUserId, 'role_changed');
    }
    const updated = await serializeTeamMember(tenantId, targetUserId, selectedStructureId);
    return sendSuccessResponse(res, 200, updated, 'Membro del team aggiornato');
});

/**
 * Prepara la disattivazione senza modificare dati: la UI usa il risultato per mostrare
 * la scelta dell'operatore sostitutivo soltanto quando esistono appuntamenti futuri.
 */
export const getUserCalendarDeactivationImpact = asyncHandler(async (req: Request, res: Response) => {
    const structureId = getSelectedStructureId(req);
    const { tenantId, membership } = await findTenantMember(req, req.params.userId);
    if (!membership) return sendErrorResponse(res, 404, 'Utente non trovato in questo studio');
    const selected = structureId ? await Structure.findOne({where: {id: structureId, tenantId}}) : null;
    const assignment = selected ? await StructureUser.findOne({where: {userId: req.params.userId, structureId: structureId!}}) : null;
    if (!assignment) return sendErrorResponse(res, 400, 'La sede selezionata non assegnata al membro');
    const impact = await getOperatorDeactivationImpact(tenantId, req.tenantSchema!, req.params.userId, new Date(), structureId!);
    return sendSuccessResponse(res, 200, impact, 'Impatto disabilitazione agenda');
});

export const getUserDeactivationImpact = asyncHandler(async (req: Request, res: Response) => {
    const targetUserId = req.params.userId;
    const { tenantId, membership } = await findTenantMember(req, targetUserId);
    if (!membership) {
        return sendErrorResponse(res, 404, 'Utente non trovato in questo studio');
    }

    const impact = await getOperatorDeactivationImpact(
        tenantId,
        req.tenantSchema!,
        targetUserId
    );
    return sendSuccessResponse(res, 200, impact, 'Impatto disattivazione calcolato');
});

/**
 * Attiva / disattiva un utente.
 *
 * È l'alternativa alla cancellazione per il titolare dello studio, che non è eliminabile:
 * disattivarlo ne blocca l'accesso preservando lo storico clinico e amministrativo
 * (valutazioni, appuntamenti e fatture restano riferiti al loro autore).
 */
export const getUserOffboardingImpact = asyncHandler(async (req: Request, res: Response) => {
    try {
        const impact = await getTeamOffboardingImpact(req, req.params.userId, parseTeamChange(req.body?.change));
        return sendSuccessResponse(res, 200, impact, 'Impatto modifica team');
    } catch (error) {
        if (sendTeamOffboardingError(res, error)) return;
        throw error;
    }
});

export const setUserActive = asyncHandler(async (req: Request, res: Response) => {
    const targetUserId = req.params.userId;
    try {
        const change = parseTeamChange({kind: 'status', active: req.body.active});
        const result = await runTeamMutation(req, targetUserId, change, applyTeamMembershipChange);
        if (result.replayed) res.setHeader('X-Operation-Replayed', 'true');
        if (!req.body.active) await revokeForTenantMembership(targetUserId, getCurrentTenantId(req), 'tenant_membership_deactivated');
        const updated = await serializeTeamMember(getCurrentTenantId(req), targetUserId, getSelectedStructureId(req));
        return sendSuccessResponse(res, 200, updated, req.body.active ? 'Utente riattivato' : 'Utente disattivato');
    } catch (error) {
        if (sendTeamOffboardingError(res, error)) return;
        if (error instanceof FutureAppointmentsRequireReplacementError) return sendErrorResponse(res, 409, error.message, {code: 'FUTURE_APPOINTMENTS_REQUIRE_REASSIGNMENT', impact: error.impact});
        if (error instanceof InvalidReplacementOperatorError) return sendErrorResponse(res, 409, error.message, {code: 'INVALID_REPLACEMENT_OPERATOR'});
        throw error;
    }
});

export const deleteUser = asyncHandler(async (req: Request, res: Response) => {
    try {
        const result = await runTeamMutation(req, req.params.userId, {kind: 'remove'}, applyTeamMembershipChange);
        if (result.replayed) res.setHeader('X-Operation-Replayed', 'true');
        await revokeForTenantMembership(req.params.userId, getCurrentTenantId(req), 'tenant_membership_deleted');
        return sendSuccessResponse(res, 200, {deleted: result.data.deleted}, 'Membro rimosso');
    } catch (error) {
        if (sendTeamOffboardingError(res, error)) return;
        if (error instanceof FutureAppointmentsRequireReplacementError) return sendErrorResponse(res, 409, error.message, {code: 'FUTURE_APPOINTMENTS_REQUIRE_REASSIGNMENT', impact: error.impact});
        if (error instanceof InvalidReplacementOperatorError) return sendErrorResponse(res, 409, error.message, {code: 'INVALID_REPLACEMENT_OPERATOR'});
        throw error;
    }
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
    if (typeof req.body?.password !== 'string' || !req.body.password) return sendErrorResponse(res, 400, 'Password richiesta');
    const hashedPassword = await bcrypt.hash(req.body.password, 12);
    try { await consumeAccountActionToken(req.params.resetPasswordToken, 'reset_password', hashedPassword); }
    catch (error) {
        if (error instanceof AccountActionTokenError) return sendErrorResponse(res, 400, error.message, { code: error.code });
        throw error;
    }
    return sendSuccessResponse(res, 204, {}, 'Password changed');
});

export const verificationAccount = asyncHandler(async (req: Request, res: Response) => {
    try { await consumeAccountActionToken(req.params.verificationToken, 'verify_email'); }
    catch (error) {
        if (error instanceof AccountActionTokenError) return sendErrorResponse(res, 400, error.message, { code: error.code });
        throw error;
    }
    return sendSuccessResponse(res, 200, {}, 'User activated');
});

/**
 * Resends the account-verification e-mail (e.g. when the user tries to log in but the account
 * is still inactive). Ported from the legacy `rehablo-authentication` `/send-verification` route,
 * which was dropped during the monolith migration.
 */
export const sendVerificationEmail = asyncHandler(async (req: Request, res: Response) => {
    const email = req.body.email;

    const user = await findUserByIdentityEmail(email);
    if (!user) {
        return sendErrorResponse(res, 409, 'Email non trovata.');
    }

    const verificationToken = await issueAccountActionToken(user.get('id'), email, 'verify_email');

    // Fire-and-forget, same reasoning as forgotPassword/signup: don't let a slow/unreachable SMTP
    // delay the HTTP response.
    signUpSendMail(email, verificationToken).catch((err) => {
        console.error('[sendVerificationEmail] verification email could not be sent:', err);
    });

    return sendSuccessResponse(res, 200, {}, 'Verification email sent');
});

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
    const email = req.query.email as string;

    const user = await findUserByIdentityEmail(email);
    if (!user) {
        return sendErrorResponse(res, 409, 'Email non trovata.');
    }

    const resetPasswordToken = await issueAccountActionToken(user.get('id'), email, 'reset_password');

    // Fire-and-forget, same reasoning as signup: don't let a slow/unreachable SMTP delay the
    // HTTP response (nodemailer can take several seconds to time out).
    sendForgotPasswordMail(email, resetPasswordToken).catch((err) => {
        console.error('[forgotPassword] reset email could not be sent:', err);
    });

    return sendSuccessResponse(res, 200, {}, 'Email inviata');
});

export default {
    createUser,
    findAllUsersTenantByTenantId,
    updateUser,
    updateTeamMemberProfile,
    updateUserCalendarVisibility,
    updateUserCalendarColor,
    getUserDeactivationImpact,
    getUserOffboardingImpact,
    getUserCalendarDeactivationImpact,
    setUserActive,
    deleteUser,
    resetPassword,
    verificationAccount,
    sendVerificationEmail,
    forgotPassword
};
