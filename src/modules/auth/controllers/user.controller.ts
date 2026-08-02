import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { getGrantedPermissions } from '../../../middleware/rbac.js';
import { hasPermission } from '../rbac/permissions.js';
import { DEFAULT_ROLE, isRoleCode } from '../rbac/roles.js';
import { sendForgotPasswordMail, signUpSendMail } from '../../../services/email.service.js';
import { licenseSecret } from './tenant.controller.js';
import { Tenant, User, Structure, UserAvailability } from '../models/index.js';

export const createUser = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getCurrentTenantId(req);
    const newUser = req.body;

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

    // Strutture in cui l'utente può operare. Se non specificate, viene assegnato a tutte
    // quelle del tenant (comportamento storico). Va estratto PRIMA della create:
    // non è una colonna di `users`.
    const requestedStructureIds: string[] | undefined = Array.isArray(newUser.structureIds)
        ? newUser.structureIds
        : undefined;
    delete newUser.structureIds;

    newUser.password = await bcrypt.hash(newUser.password, 12);

    const user: any = await User.create(newUser, { include: UserAvailability as any });

    const structures = await tenant.getStructures();
    const targetStructures = requestedStructureIds
        ? structures.filter((structure: any) => requestedStructureIds.includes(structure.id))
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
    const userToUpdate = { ...req.body.user };
    delete userToUpdate.password;

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

export const deleteUser = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.params.userId;
    const deleted = await User.destroy({ where: { id: userId } });
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
    deleteUser,
    resetPassword,
    verificationAccount,
    sendVerificationEmail,
    forgotPassword
};

