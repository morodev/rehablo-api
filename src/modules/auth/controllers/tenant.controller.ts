import { Request, Response } from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import Stripe from 'stripe';
import { validationResult } from 'express-validator';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { env } from '../../../config/env.js';
import { signUpSendMail } from '../../../services/email.service.js';
import { sequelize } from '../../../config/database.js';
import { TENANT_OWNER_ROLE } from '../rbac/roles.js';
import { isTaxRegimeCode } from '../../invoice/utils/fiscalRegime.js';
import { Tenant, User, Structure, StructureAvailability, UserAvailability } from '../models/index.js';
import { localStorageAdapter } from '../../measurements/storage/localStorageAdapter.js';

export const stripe = env.stripeSecretKey ? new Stripe(env.stripeSecretKey) : (null as unknown as Stripe);

/** Secret used for short-lived tokens (license/verification/reset), separate from the main session JWT secret. */
export const licenseSecret = env.jwtSecret + '::license';

const ALLOWED_LOGO_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']);

export const logoUploadMiddleware = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 }
}).single('file');

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
                isSuperAdmin: true,
                // Chi arriva dalla registrazione È il tenant: ha creato lui lo studio.
                // Il flag lo distingue dagli utenti invitati successivamente e lo rende
                // non eliminabile (vedi `deleteUser`).
                isTenant: true
            },
            { transaction }
        );

        // Il ruolo NON è una colonna di `users`: vive sulla membership `tenant_users`, che
        // senza questo `through` ricadrebbe sul default (`THERAPIST`). Il titolare si sarebbe
        // così ritrovato senza accesso a fatturazione, gestione utenti e dati azienda.
        await tenant.addUser(createdUser, { through: { role: TENANT_OWNER_ROLE }, transaction });

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

    delete req.body.logoStoragePath;
    delete req.body.logoMimeType;
    delete req.body.logoOriginalName;
    delete req.body.logoSizeBytes;

    // Il regime fiscale pilota IVA, ritenuta, natura e diciture di OGNI documento emesso: un codice
    // inventato produrrebbe fatture sbagliate a catena. Si accettano solo i codici della tabella
    // `RegimeFiscale` della FatturaPA (vedi src/modules/invoice/utils/fiscalRegime.ts).
    if (req.body?.taxRegime !== undefined && req.body.taxRegime !== null && req.body.taxRegime !== '') {
        const normalized = `${req.body.taxRegime}`.trim().toUpperCase();
        if (!isTaxRegimeCode(normalized)) {
            return sendErrorResponse(res, 422, `Regime fiscale non valido: ${req.body.taxRegime}`);
        }
        req.body.taxRegime = normalized;
    }

    const [, updated] = await Tenant.update(req.body, { where: { id }, returning: true });
    return sendSuccessResponse(res, 200, updated, 'Tenant updated');
});

function canAccessTenant(req: Request, tenantId: string): boolean {
    return req.user?.tenants?.some((tenant) => tenant.id === tenantId) ?? false;
}

export const uploadTenantLogo = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.tenantId;

    if (!canAccessTenant(req, id)) {
        return sendErrorResponse(res, 403, 'Tenant non accessibile');
    }

    if (!req.file) {
        return sendErrorResponse(res, 400, 'Il campo "file" (multipart/form-data) Ã¨ obbligatorio');
    }

    if (!ALLOWED_LOGO_MIME_TYPES.has(req.file.mimetype)) {
        return sendErrorResponse(res, 422, 'Formato logo non supportato. Usa PNG, JPG, SVG o WebP.');
    }

    const tenant = await Tenant.findByPk(id);
    if (!tenant) {
        return sendErrorResponse(res, 404, `Tenant with id: ${id} not found`);
    }

    const saved = await localStorageAdapter.save(id, req.file.buffer, req.file.originalname);
    await tenant.update({
        logoStoragePath: saved.storagePath,
        logoMimeType: req.file.mimetype,
        logoOriginalName: req.file.originalname,
        logoSizeBytes: saved.sizeBytes
    });

    return sendSuccessResponse(res, 200, tenant, 'Logo aziendale caricato');
});

export const getTenantLogo = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.tenantId;

    if (!canAccessTenant(req, id)) {
        return sendErrorResponse(res, 403, 'Tenant non accessibile');
    }

    const tenant = await Tenant.findByPk(id);
    if (!tenant?.logoStoragePath) {
        return sendErrorResponse(res, 404, 'Logo aziendale non presente');
    }

    const buffer = await localStorageAdapter.read(tenant.logoStoragePath);
    res.setHeader('Content-Type', tenant.logoMimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${tenant.logoOriginalName || 'logo'}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.send(buffer);
});

export const removeTenantLogo = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.tenantId;

    if (!canAccessTenant(req, id)) {
        return sendErrorResponse(res, 403, 'Tenant non accessibile');
    }

    const tenant = await Tenant.findByPk(id);
    if (!tenant) {
        return sendErrorResponse(res, 404, `Tenant with id: ${id} not found`);
    }

    await tenant.update({
        logoStoragePath: null,
        logoMimeType: null,
        logoOriginalName: null,
        logoSizeBytes: null
    });

    return sendSuccessResponse(res, 200, tenant, 'Logo aziendale rimosso');
});

export const findTenantById = asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.tenantId;
    console.log('=== findTenantById called ===');
    console.log('Requested tenant ID:', id);
    console.log('User from JWT:', req.user);
    
    let tenant = await Tenant.findByPk(id);
    console.log('Tenant found:', !!tenant);
    
    if (tenant) {
        console.log('Tenant data:', { id: tenant.id, businessName: tenant.businessName });
        return sendSuccessResponse(res, 200, tenant, `Tenant with id: ${id} found`);
    }
    
    // If not found, log all tenants to debug
    console.warn(`Tenant ${id} not found. Checking all tenants in database...`);
    const allTenants = await Tenant.findAll();
    console.log('All tenants in DB:', allTenants.map(t => ({ id: t.id, businessName: t.businessName })));
    
    // Check if user has a tenant association
    if (req.user?.tenants && req.user.tenants.length > 0) {
        console.log('User tenants from JWT:', req.user.tenants);
    }
    
    return sendErrorResponse(res, 404, `Tenant with id: ${id} not found`);
});

export default {
    createTenant,
    updateTenant,
    uploadTenantLogo,
    getTenantLogo,
    removeTenantLogo,
    findTenantById,
    logoUploadMiddleware
};


