import { Request, Response } from 'express';
import { Op } from 'sequelize';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { getGrantedPermissions, getUserId } from '../../../middleware/rbac.js';
import { hasPermission } from '../rbac/permissions.js';
import { DEFAULT_ROLE, isRoleCode, RoleCode, ROLE_DEFINITIONS } from '../rbac/roles.js';
import { sendForgotPasswordMail, signUpSendMail } from '../../../services/email.service.js';
import { licenseSecret } from './tenant.controller.js';
import { revokeAllForUser } from '../services/refreshToken.service.js';
import { Tenant, TenantUser, User, Structure, UserAvailability } from '../models/index.js';

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
    userToCreate.password = await bcrypt.hash(newUser.password, 12);
    userToCreate.isTenant = false;
    userToCreate.isSuperAdmin = false;
    userToCreate.isActive = false;

    const structures = await tenant.getStructures();
    const allowedStructureIds = structures.map((structure: any) => structure.id as string);
    const uniqueRequestedIds = requestedStructureIds ? [...new Set(requestedStructureIds)] : undefined;
    if (uniqueRequestedIds?.some((id) => !allowedStructureIds.includes(id))) {
        return sendErrorResponse(res, 400, 'Una o più strutture non appartengono allo studio');
    }

    const user: any = await User.create(userToCreate, { include: UserAvailability as any });

    const targetStructures = role === RoleCode.OWNER
        ? structures
        : uniqueRequestedIds
          ? structures.filter((structure: any) => uniqueRequestedIds.includes(structure.id))
          : structures;

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
        structureIds: (user.structures ?? []).map((structure: any) => structure.id)
    }));

    return sendSuccessResponse(res, 200, users, 'All users found');
});

export const updateUser = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.params.userId;
    const userToUpdate = stripProtectedFields({ ...req.body.user });
    delete userToUpdate.password;

    const { membership } = await findTenantMember(req, userId);
    if (!membership) {
        return sendErrorResponse(res, 404, 'Utente non trovato in questo studio');
    }

    const [rowsUpdated] = await User.update(userToUpdate, { where: { id: userId } });
    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'User not found');
    }

    const updatedUser = await User.findByPk(userId, { attributes: { exclude: ['password'] } });

    if (Array.isArray(userToUpdate.userAvailabilities)) {
        for (const availability of userToUpdate.userAvailabilities) {
            if (availability.id) {
                await UserAvailability.update(availability, { where: { id: availability.id } });
            } else {
                await UserAvailability.create({ ...availability, userId });
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
 * Attiva / disattiva un utente.
 *
 * È l'alternativa alla cancellazione per il titolare dello studio, che non è eliminabile:
 * disattivarlo ne blocca l'accesso preservando lo storico clinico e amministrativo
 * (valutazioni, appuntamenti e fatture restano riferiti al loro autore).
 */
export const setUserActive = asyncHandler(async (req: Request, res: Response) => {
    const targetUserId = req.params.userId;
    const { active } = req.body as { active?: boolean };

    if (typeof active !== 'boolean') {
        return sendErrorResponse(res, 400, 'Il campo `active` è obbligatorio (boolean)');
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
        const activeOwners = await User.count({
            where: { id: { [Op.in]: ownerIds }, deactivatedAt: null }
        });
        if (activeOwners <= 1) {
            return sendErrorResponse(res, 409, 'Lo studio deve avere almeno un titolare attivo');
        }
    }

    await User.update({ deactivatedAt: active ? null : new Date() }, { where: { id: targetUserId } });

    // Le sessioni aperte sopravvivrebbero fino alla scadenza dell'access token: revocando
    // i refresh token la disattivazione diventa effettiva entro pochi minuti.
    if (!active) {
        await revokeAllForUser(targetUserId, 'user_deactivated');
    }

    const updatedUser = await User.findByPk(targetUserId, { attributes: { exclude: ['password'] } });

    return sendSuccessResponse(
        res,
        200,
        updatedUser,
        active ? 'Utente riattivato' : 'Utente disattivato'
    );
});

export const deleteUser = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.params.userId;

    const { membership, user } = await findTenantMember(req, userId);
    if (!membership || !user) {
        return sendErrorResponse(res, 404, 'Utente non trovato in questo studio');
    }

    // Il titolare dello studio non è eliminabile da nessuno, nemmeno da sé stesso:
    // è l'intestatario dell'abbonamento e il riferimento amministrativo del tenant.
    // Per revocarne l'accesso si usa la disattivazione (`PATCH /user/:userId/status`).
    if (user.get('isTenant')) {
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

    const deleted = await User.destroy({ where: { id: userId } });
    await revokeAllForUser(userId, 'user_deleted');

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
    await User.update({ password: hashedPassword }, { where: { email: decoded.email } });

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

    await User.update({ isActive: true }, { where: { email: decoded.email } });
    return sendSuccessResponse(res, 200, {}, 'User activated');
});

/**
 * Resends the account-verification e-mail (e.g. when the user tries to log in but the account
 * is still inactive). Ported from the legacy `rehablo-authentication` `/send-verification` route,
 * which was dropped during the monolith migration.
 */
export const sendVerificationEmail = asyncHandler(async (req: Request, res: Response) => {
    const email = req.body.email;

    const user = await User.findOne({ where: { email } });
    if (!user) {
        return sendErrorResponse(res, 409, 'Email non trovata.');
    }

    const verificationToken = jwt.sign({ email }, licenseSecret, { expiresIn: '12h' });

    // Fire-and-forget, same reasoning as forgotPassword/signup: don't let a slow/unreachable SMTP
    // delay the HTTP response.
    signUpSendMail(email, verificationToken).catch((err) => {
        console.error('[sendVerificationEmail] verification email could not be sent:', err);
    });

    return sendSuccessResponse(res, 200, {}, 'Verification email sent');
});

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
    const email = req.query.email as string;

    const user = await User.findOne({ where: { email } });
    if (!user) {
        return sendErrorResponse(res, 409, 'Email non trovata.');
    }

    const resetPasswordToken = jwt.sign({ email }, licenseSecret, { expiresIn: '12h' });

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
    setUserActive,
    deleteUser,
    resetPassword,
    verificationAccount,
    sendVerificationEmail,
    forgotPassword
};

