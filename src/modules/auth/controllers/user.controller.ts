import { Request, Response } from 'express';
import { Op } from 'sequelize';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { sequelize } from '../../../config/database.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { getGrantedPermissions, getUserId } from '../../../middleware/rbac.js';
import { hasPermission } from '../rbac/permissions.js';
import { DEFAULT_ROLE, isRoleCode, RoleCode, ROLE_DEFINITIONS } from '../rbac/roles.js';
import { sendForgotPasswordMail, signUpSendMail } from '../../../services/email.service.js';
import { licenseSecret } from './tenant.controller.js';
import { revokeAllForUser, revokeForTenantMembership } from '../services/refreshToken.service.js';
import { Tenant, TenantUser, User, Structure, StructureUser, UserAvailability } from '../models/index.js';
import { USER_AVAILABILITY_MODES } from '../models/user.model.js';
import { validateUserStructureSelection } from '../services/userStructurePolicy.service.js';
import { findUserByIdentityEmail } from '../services/identity.service.js';
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

function isAvailabilityMode(value: unknown): boolean {
    return typeof value === 'string'
        && (USER_AVAILABILITY_MODES as readonly string[]).includes(value);
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


export const createUser = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getCurrentTenantId(req);
    const newUser = { ...req.body };

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

    // Strutture in cui l'utente può operare. Se non specificate, viene assegnato a tutte
    // quelle del tenant (comportamento storico). Va estratto PRIMA della create:
    // non è una colonna di `users`.
    const requestedStructureIds: string[] | undefined = Array.isArray(newUser.structureIds)
        ? newUser.structureIds
        : undefined;
    delete newUser.structureIds;

    // Un utente invitato non è mai il titolare dello studio né un super admin: il titolare
    // nasce esclusivamente dalla registrazione (vedi `createTenant`).
    const userToCreate = stripProtectedFields(newUser);
    if (userToCreate.availabilityMode !== undefined && !isAvailabilityMode(userToCreate.availabilityMode)) {
        return sendErrorResponse(res, 400, 'Modalità disponibilità non valida');
    }
    userToCreate.password = await bcrypt.hash(newUser.password, 12);
    userToCreate.isTenant = false;
    userToCreate.isSuperAdmin = false;
    userToCreate.isActive = false;

    const structures = await tenant.getStructures();
    const allowedStructureIds = structures.map((structure: any) => structure.id as string);
    const uniqueRequestedIds = requestedStructureIds ? [...new Set(requestedStructureIds)] : undefined;
    const selectedStructureIds = role === RoleCode.OWNER
        ? allowedStructureIds
        : uniqueRequestedIds
          ?? (role === RoleCode.SECRETARY || allowedStructureIds.length === 1
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

    const user: any = await User.create(userToCreate, { include: UserAvailability as any });

    const targetStructures = role === RoleCode.OWNER
        ? structures
        : structures.filter((structure: any) => selectedStructureIds.includes(structure.id));

    // Nessun ruolo sulla struttura: `null` significa "eredita quello del tenant".
    await Promise.all(targetStructures.map((structure: any) => structure.addUser(user)));
    await tenant.addUser(user, { through: { role } });

    const verificationToken = jwt.sign({ email: user.get('email') }, licenseSecret, { expiresIn: '12h' });

    // Fire-and-forget, consistent with createTenant: a misconfigured/unreachable SMTP must NOT
    // roll back user creation NOR slow down the HTTP response (nodemailer can take several
    // seconds to time out against a bad/unreachable host). The verification link is also logged
    // to the console in non-production environments (see email.service.ts) as a fallback.
    signUpSendMail(user.get('email'), verificationToken).catch((err) => {
        console.error('[createUser] verification email could not be sent:', err);
    });

    return sendSuccessResponse(res, 201, user, 'User for tenant created');
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
                include: [{ model: UserAvailability }, { model: Structure }]
            }
        ],
        order: [[User, UserAvailability, 'day', 'ASC']]
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
        structureIds: (user.structures ?? []).map((structure: any) => structure.id)
    }));

    return sendSuccessResponse(res, 200, users, 'All users found');
});

export const updateUser = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.params.userId;
    const userToUpdate = stripProtectedFields({ ...req.body.user });
    const userAvailabilities = Array.isArray(userToUpdate.userAvailabilities)
        ? userToUpdate.userAvailabilities
        : null;
    delete userToUpdate.userAvailabilities;
    delete userToUpdate.password;

    if (userToUpdate.availabilityMode !== undefined && !isAvailabilityMode(userToUpdate.availabilityMode)) {
        return sendErrorResponse(res, 400, 'Modalità disponibilità non valida');
    }

    const { membership } = await findTenantMember(req, userId);
    if (!membership) {
        return sendErrorResponse(res, 404, 'Utente non trovato in questo studio');
    }

    const [rowsUpdated] = await User.update(userToUpdate, { where: { id: userId } });
    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'User not found');
    }

    const updatedUser = await User.findByPk(userId, { attributes: { exclude: ['password'] } });

    if (userAvailabilities) {
        for (const availability of userAvailabilities) {
            const { id, userId: _ignoredUserId, ...availabilityValues } = availability;
            if (id) {
                await UserAvailability.update(availabilityValues, { where: { id, userId } });
            } else {
                await UserAvailability.create({ ...availabilityValues, userId });
            }
        }
    }

    return sendSuccessResponse(res, 200, updatedUser, 'User updated');
});

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

export const updateUserCalendarVisibility = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.params.userId;
    if (!canEditUserPreferences(req, userId)) {
        return sendErrorResponse(res, 403, 'forbidden');
    }
    await User.update({ calendarVisible: req.body.calendarVisible }, { where: { id: userId } });
    const updatedUser = await User.findByPk(userId, { attributes: { exclude: ['password'] } });
    return sendSuccessResponse(res, 200, updatedUser, 'User updated');
});

export const updateUserCalendarColor = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.params.userId;
    if (!canEditUserPreferences(req, userId)) {
        return sendErrorResponse(res, 403, 'forbidden');
    }
    await User.update({ calendarColor: req.body.calendarColor }, { where: { id: userId } });
    const updatedUser = await User.findByPk(userId, { attributes: { exclude: ['password'] } });
    return sendSuccessResponse(res, 200, updatedUser, 'User updated');
});

/**
 * Prepara la disattivazione senza modificare dati: la UI usa il risultato per mostrare
 * la scelta dell'operatore sostitutivo soltanto quando esistono appuntamenti futuri.
 */
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
export const setUserActive = asyncHandler(async (req: Request, res: Response) => {
    const targetUserId = req.params.userId;
    const { active, replacementUserId, deferReassignment } = req.body as {
        active?: boolean;
        replacementUserId?: string | null;
        deferReassignment?: boolean;
    };

    if (typeof active !== 'boolean') {
        return sendErrorResponse(res, 400, 'Il campo `active` è obbligatorio (boolean)');
    }
    if (replacementUserId && deferReassignment) {
        return sendErrorResponse(
            res,
            400,
            'Scegli se riassegnare subito oppure gestire gli appuntamenti in seguito'
        );
    }

    // Nessuno può disattivare sé stesso: si chiuderebbe fuori dall'applicazione.
    if (targetUserId === getUserId(req)) {
        return sendErrorResponse(res, 403, 'Non puoi disattivare il tuo account');
    }

    const { tenantId, membership, user } = await findTenantMember(req, targetUserId);
    if (!membership || !user) {
        return sendErrorResponse(res, 404, 'Utente non trovato in questo studio');
    }

    // Lo studio deve conservare almeno un titolare operativo, altrimenti nessuno potrebbe
    // più gestire utenti, fatturazione e dati azienda.
    if (!active && membership.get('role') === RoleCode.OWNER) {
        const ownerMemberships = await TenantUser.findAll({
            where: { tenantId, role: RoleCode.OWNER },
            attributes: ['userId']
        });
        const ownerIds = ownerMemberships.map((row) => row.get('userId') as string);
        const activeOwners = await TenantUser.count({
            where: { tenantId, userId: { [Op.in]: ownerIds }, deactivatedAt: null }
        });
        if (activeOwners <= 1) {
            return sendErrorResponse(res, 409, 'Lo studio deve avere almeno un titolare attivo');
        }
    }

    if (!active && !replacementUserId) {
        const impact = await getOperatorDeactivationImpact(
            tenantId,
            req.tenantSchema!,
            targetUserId
        );
        if (impact.hasFutureAppointments && deferReassignment !== true) {
            return sendErrorResponse(
                res,
                409,
                'Scegli se riassegnare subito gli appuntamenti futuri oppure gestirli in seguito',
                { code: 'FUTURE_APPOINTMENTS_REQUIRE_REASSIGNMENT', impact }
            );
        }
    }

    try {
        await sequelize.transaction(async (transaction) => {
            const lockedMembership = await TenantUser.findOne({
                where: { tenantId, userId: targetUserId },
                transaction,
                lock: transaction.LOCK.UPDATE
            });
            if (!lockedMembership) {
                throw new Error('La membership da aggiornare non esiste piu');
            }

            if (!active && replacementUserId) {
                await reassignFutureAppointments(
                    tenantId,
                    req.tenantSchema!,
                    targetUserId,
                    replacementUserId,
                    transaction
                );
            }

            await lockedMembership.update(
                { deactivatedAt: active ? null : new Date() },
                { transaction }
            );

            if (active && user.get('deactivatedAt')) {
                // Gli account sospesi prima dell'introduzione di TenantUser conservavano
                // anche il vecchio blocco globale. Senza questa bonifica il rapporto con lo
                // studio tornava attivo, ma il login continuava a rispondere
                // "Account non disponibile".
                await User.update(
                    { deactivatedAt: null },
                    { where: { id: targetUserId }, transaction }
                );
            }
        });
    } catch (error) {
        if (error instanceof FutureAppointmentsRequireReplacementError) {
            return sendErrorResponse(
                res,
                409,
                error.message,
                { code: 'FUTURE_APPOINTMENTS_REQUIRE_REASSIGNMENT', impact: error.impact }
            );
        }
        if (error instanceof InvalidReplacementOperatorError) {
            return sendErrorResponse(
                res,
                409,
                error.message,
                { code: 'INVALID_REPLACEMENT_OPERATOR' }
            );
        }
        throw error;
    }

    // Le sessioni aperte sopravvivrebbero fino alla scadenza dell'access token: revocando
    // i refresh token la disattivazione diventa effettiva entro pochi minuti.
    if (!active) {
        await revokeForTenantMembership(targetUserId, tenantId, 'tenant_membership_deactivated');
    }

    const [updatedIdentity, updatedMembership] = await Promise.all([
        User.findByPk(targetUserId, { attributes: { exclude: ['password'] } }),
        TenantUser.findOne({ where: { tenantId, userId: targetUserId } })
    ]);
    const updatedUser = updatedIdentity
        ? { ...updatedIdentity.get({ plain: true }), deactivatedAt: updatedMembership?.deactivatedAt ?? null }
        : null;

    return sendSuccessResponse(
        res,
        200,
        updatedUser,
        active ? 'Utente riattivato' : 'Utente disattivato'
    );
});

export const deleteUser = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.params.userId;

    const { tenantId, membership, user } = await findTenantMember(req, userId);
    if (!membership || !user) {
        return sendErrorResponse(res, 404, 'Utente non trovato in questo studio');
    }

    // Il titolare dello studio non è eliminabile da nessuno, nemmeno da sé stesso:
    // è l'intestatario dell'abbonamento e il riferimento amministrativo del tenant.
    // Per revocarne l'accesso si usa la disattivazione (`PATCH /user/:userId/status`).
    if (membership.get('role') === RoleCode.OWNER) {
        return sendErrorResponse(
            res,
            409,
            'Il titolare dello studio non può essere eliminato. Puoi disattivarlo.'
        );
    }

    // Cancellare il proprio account dalla gestione team è quasi sempre un errore:
    // lascerebbe lo studio senza l'amministratore che ha avviato l'operazione.
    if (userId === getUserId(req)) {
        return sendErrorResponse(res, 403, 'Non puoi eliminare il tuo account');
    }

    const structures = await Structure.findAll({ where: { tenantId }, attributes: ['id'] });
    const structureIds = structures.map((structure) => structure.get('id') as string);
    if (structureIds.length) {
        await StructureUser.destroy({
            where: { userId, structureId: { [Op.in]: structureIds } }
        });
    }
    const deleted = await TenantUser.destroy({ where: { tenantId, userId } });
    await revokeForTenantMembership(userId, tenantId, 'tenant_membership_deleted');

    return sendSuccessResponse(res, 200, { deleted }, 'User removed');
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
    const resetPasswordToken = req.params.resetPasswordToken;

    let decoded: any;
    try {
        decoded = jwt.verify(resetPasswordToken, licenseSecret);
    } catch {
        return sendErrorResponse(res, 400, 'Invalid or expired token');
    }

    const hashedPassword = await bcrypt.hash(req.body.password, 12);
    const user = decoded.sub
        ? await User.findByPk(decoded.sub)
        : await findUserByIdentityEmail(decoded.email);
    if (!user) return sendErrorResponse(res, 400, 'Invalid or expired token');

    await user.update({ password: hashedPassword });
    await revokeAllForUser(user.get('id') as string, 'password_changed');

    return sendSuccessResponse(res, 204, {}, 'Password changed');
});

export const verificationAccount = asyncHandler(async (req: Request, res: Response) => {
    const verificationToken = req.params.verificationToken;

    let decoded: any;
    try {
        decoded = jwt.verify(verificationToken, licenseSecret);
    } catch {
        return sendErrorResponse(res, 400, 'Invalid or expired token');
    }

    const user = decoded.sub
        ? await User.findByPk(decoded.sub)
        : await findUserByIdentityEmail(decoded.email);
    if (!user) return sendErrorResponse(res, 400, 'Invalid or expired token');
    await user.update({ isActive: true });
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

    const verificationToken = jwt.sign({ sub: user.get('id'), email }, licenseSecret, { expiresIn: '12h' });

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

    const resetPasswordToken = jwt.sign({ sub: user.get('id'), email }, licenseSecret, { expiresIn: '12h' });

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
    updateUserCalendarVisibility,
    updateUserCalendarColor,
    getUserDeactivationImpact,
    setUserActive,
    deleteUser,
    resetPassword,
    verificationAccount,
    sendVerificationEmail,
    forgotPassword
};

