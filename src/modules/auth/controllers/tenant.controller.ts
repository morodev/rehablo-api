import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import Stripe from 'stripe';
import { validationResult } from 'express-validator';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { env } from '../../../config/env.js';
import { signUpSendMail } from '../../../services/email.service.js';
import { sequelize } from '../../../config/database.js';
import { Tenant, User, Structure, StructureAvailability, UserAvailability } from '../models/index.js';

export const stripe = env.stripeSecretKey ? new Stripe(env.stripeSecretKey) : (null as unknown as Stripe);

/** Secret used for short-lived tokens (license/verification/reset), separate from the main session JWT secret. */
export const licenseSecret = env.jwtSecret + '::license';

export const createTenant = asyncHandler(async (req: Request, res: Response) => {
    req.body = {
        ...req.body,
        userQuantity: 1,
        maxUserQuantity: 1,
        structureQuantity: 1,
        maxStructureQuantity: 1,
        MBQuantity: 100,
        isActive: false
    };

    const { users, userQuantity, maxUserQuantity, structureQuantity, maxStructureQuantity, MBQuantity } = req.body;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendErrorResponse(res, 422, 'Validation failed.', errors.array());
    }

    const existingUser = await User.findOne({ where: { email: users[0].email } });
    if (existingUser) {
        return sendErrorResponse(res, 409, 'Email già registrata. Utilizza una mail differente.');
    }

    const payloadToken = { userQuantity, maxUserQuantity, structureQuantity, maxStructureQuantity, MBQuantity, isPremium: false };
    const licenseToken = jwt.sign(payloadToken, licenseSecret, { expiresIn: '90d' });

    const hashedPassword = await bcrypt.hash(users[0].password, 12);

    let stripeCustomerId = 'no-stripe';
    if (stripe) {
        const stripeUser = await stripe.customers.create({ email: users[0].email });
        stripeCustomerId = stripeUser.id;
    }

    // Everything below must be all-or-nothing: if any step fails (including a transient
    // error unrelated to the email itself), nothing should be persisted, otherwise a retry
    // with the same email would incorrectly fail with "Email already registered".
    const { tenant, createdUser } = await sequelize.transaction(async (transaction) => {
        const tenant: any = await Tenant.create(
            {
                userQuantity,
                maxUserQuantity,
                structureQuantity,
                maxStructureQuantity,
                MBQuantity,
                license: licenseToken,
                isPremium: false,
                idStripe: stripeCustomerId
            } as any,
            { transaction }
        );

        const createdUser = await User.create(
            {
                ...users[0],
                password: hashedPassword,
                isActive: false,
                isSuperAdmin: true
            },
            { transaction }
        );

        await tenant.addUser(createdUser, { transaction });

        const newStructure = await Structure.create(
            { tenantId: tenant.id, name: `Studio di ${createdUser.get('email')}` },
            { transaction }
        );

        const userAvailabilities = Array.from({ length: 7 }, (_, i) => ({
            day: i,
            enabled: false,
            userId: createdUser.get('id') as string
        }));

        const structureAvailabilities = Array.from({ length: 7 }, (_, i) => ({
            day: i,
            enabled: i < 5,
            open: i < 5 ? '08:00:00' : null,
            close: i < 5 ? '20:00:00' : null,
            structureId: newStructure.get('id') as string
        }));

        await Promise.all([
            UserAvailability.bulkCreate(userAvailabilities as any, { transaction }),
            StructureAvailability.bulkCreate(structureAvailabilities as any, { transaction }),
            (newStructure as any).addUser(createdUser, { transaction })
        ]);

        return { tenant, createdUser };
    });

    // Fire-and-forget: the verification email must NOT roll back tenant creation NOR slow down
    // the HTTP response if SMTP is misconfigured or temporarily unavailable/slow (nodemailer can
    // take several seconds to time out). The user can always request a new verification link
    // later (e.g. via a "resend verification email" endpoint).
    const verificationToken = jwt.sign({ email: createdUser.get('email') }, licenseSecret, { expiresIn: '12h' });
    signUpSendMail(createdUser.get('email') as string, verificationToken).catch((err) => {
        console.error('[createTenant] verification email could not be sent:', err);
    });

    return sendSuccessResponse(res, 201, { tenantId: tenant.id }, 'Tenant created');
});

export const updateTenant = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.tenantId;
    const [, updated] = await Tenant.update(req.body, { where: { id }, returning: true });
    return sendSuccessResponse(res, 200, updated, 'Tenant updated');
});

export const findTenantById = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.tenantId;
    const tenant = await Tenant.findByPk(id);
    if (!tenant) {
        return sendErrorResponse(res, 404, `Tenant with id: ${id} not found`);
    }
    return sendSuccessResponse(res, 200, tenant, `Tenant with id: ${id} found`);
});

export default { createTenant, updateTenant, findTenantById };


