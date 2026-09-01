import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { Op } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { getUserId, scopeWhere } from '../../../middleware/rbac.js';
import {
    PatientPortalAccess,
    PatientPortalInvitation,
    Tenant,
    User
} from '../../auth/models/index.js';
import { normalizeIdentityEmail } from '../../auth/models/userEmail.model.js';
import { attachVerifiedEmailAlias, findUserByIdentityEmail } from '../../auth/services/identity.service.js';
import { revokeForPatientAccess } from '../../auth/services/refreshToken.service.js';
import Patient from '../../patients/models/patient.model.js';
import { sendPatientPortalInvitationMail } from '../../../services/email.service.js';
import { sequelize } from '../../../config/database.js';
import {
    createInvitation,
    linkInvitationToUser,
    loadUsableInvitation
} from '../services/patientPortalInvitation.service.js';

const PATIENT_SCOPE_FIELDS = { ownerField: 'userId', structureField: 'structureId' };

async function hasOtherUsableSelfAccess(userId: string, tenantId: string, patientId: string): Promise<boolean> {
    return Boolean(await PatientPortalAccess.findOne({
        where: {
            userId,
            tenantId,
            patientId: { [Op.ne]: patientId },
            relationship: 'SELF',
            status: { [Op.in]: ['ACTIVE', 'HISTORICAL'] }
        },
        attributes: ['id']
    }));
}

function maskedEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    return `${local.slice(0, 1)}***@${domain}`;
}

export const invitePatient = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getCurrentTenantId(req);
    const patientId = req.params.patientId;
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const normalizedEmail = normalizeIdentityEmail(email);
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
        return sendErrorResponse(res, 400, 'Inserisci un indirizzo email valido');
    }

    const patient = await Patient.schema(req.tenantSchema!).findOne({
        where: {
            id: patientId,
            archivedAt: null,
            ...scopeWhere(req, PATIENT_SCOPE_FIELDS)
        }
    });
    if (!patient) return sendErrorResponse(res, 404, 'Paziente non trovato');

    const registeredEmails = (patient.get('emails') as Array<Record<string, unknown>> ?? [])
        .map((entry) => normalizeIdentityEmail(entry?.email))
        .filter(Boolean);
    if (!registeredEmails.includes(normalizedEmail)) {
        return sendErrorResponse(
            res,
            409,
            'Prima di inviare l’invito salva questo indirizzo nell’anagrafica del paziente'
        );
    }

    const recipient = await findUserByIdentityEmail(normalizedEmail);
    if (recipient && await hasOtherUsableSelfAccess(
        recipient.get('id') as string,
        tenantId,
        patientId
    )) {
        return sendErrorResponse(
            res,
            409,
            'Questo account è già collegato a un’altra anagrafica paziente dello stesso centro'
        );
    }

    const existingAccess = await PatientPortalAccess.findOne({
        where: { tenantId, patientId, relationship: 'SELF' }
    });
    if (existingAccess && existingAccess.get('status') !== 'REVOKED') {
        return sendErrorResponse(res, 409, 'Il paziente dispone già di un accesso al portale');
    }

    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) return sendErrorResponse(res, 404, 'Centro non trovato');

    const invitation = await createInvitation({
        tenantId,
        patientId,
        email,
        normalizedEmail,
        invitedByUserId: getUserId(req)
    });

    try {
        await sendPatientPortalInvitationMail(
            email,
            invitation.token,
            (tenant.get('businessName') as string | null) || 'Centro Rehablo'
        );
    } catch (error) {
        console.error('[patient-portal] invio invito fallito', error);
        await PatientPortalInvitation.update(
            { invalidatedAt: new Date() },
            { where: { id: invitation.id, acceptedAt: { [Op.is]: null } } }
        );
        return sendErrorResponse(
            res,
            502,
            'Non è stato possibile inviare l’invito via email. Riprova tra poco.'
        );
    }

    return sendSuccessResponse(res, 202, {
        status: 'PENDING',
        email,
        expiresAt: invitation.expiresAt
    }, 'Invito inviato');
});

export const getPatientPortalAccess = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getCurrentTenantId(req);
    const patientId = req.params.patientId;
    const patient = await Patient.schema(req.tenantSchema!).findOne({
        where: { id: patientId, ...scopeWhere(req, PATIENT_SCOPE_FIELDS) },
        attributes: ['id']
    });
    if (!patient) return sendErrorResponse(res, 404, 'Paziente non trovato');

    const [access, invitation] = await Promise.all([
        PatientPortalAccess.findOne({ where: { tenantId, patientId, relationship: 'SELF' } }),
        PatientPortalInvitation.findOne({
            where: {
                tenantId,
                patientId,
                acceptedAt: { [Op.is]: null },
                invalidatedAt: { [Op.is]: null },
                expiresAt: { [Op.gt]: new Date() }
            },
            order: [['createdAt', 'DESC']]
        })
    ]);

    return sendSuccessResponse(res, 200, access ? {
        status: access.get('status'),
        acceptedAt: access.get('acceptedAt'),
        historicalAt: access.get('historicalAt'),
        revokedAt: access.get('revokedAt'),
        lastAccessAt: access.get('lastAccessAt')
    } : invitation ? {
        status: 'PENDING',
        email: invitation.get('email'),
        expiresAt: invitation.get('expiresAt')
    } : { status: 'NOT_INVITED' }, 'Stato accesso portale');
});

export const updatePatientPortalAccess = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = getCurrentTenantId(req);
    const patientId = req.params.patientId;
    const status = req.body?.status;
    if (!['ACTIVE', 'HISTORICAL', 'REVOKED'].includes(status)) {
        return sendErrorResponse(res, 400, 'Stato portale non valido');
    }

    const patient = await Patient.schema(req.tenantSchema!).findOne({
        where: { id: patientId, ...scopeWhere(req, PATIENT_SCOPE_FIELDS) },
        attributes: ['id', 'archivedAt']
    });
    if (!patient) return sendErrorResponse(res, 404, 'Paziente non trovato');
    if (status === 'ACTIVE' && patient.get('archivedAt')) {
        return sendErrorResponse(res, 409, 'Un paziente archiviato può avere solo accesso storico');
    }

    const access = await PatientPortalAccess.findOne({
        where: { tenantId, patientId, relationship: 'SELF' }
    });
    if (!access) return sendErrorResponse(res, 404, 'Accesso portale non trovato');
    if (status !== 'REVOKED' && await hasOtherUsableSelfAccess(
        access.get('userId') as string,
        tenantId,
        patientId
    )) {
        return sendErrorResponse(
            res,
            409,
            'Questo account è già collegato a un’altra anagrafica paziente dello stesso centro'
        );
    }

    await access.update({
        status,
        historicalAt: status === 'HISTORICAL' ? new Date() : null,
        revokedAt: status === 'REVOKED' ? new Date() : null,
        revokedByUserId: status === 'REVOKED' ? getUserId(req) : null
    });
    if (status === 'REVOKED') {
        await revokeForPatientAccess(access.get('id') as string, 'patient_access_revoked');
    }
    return sendSuccessResponse(res, 200, access, 'Accesso portale aggiornato');
});

export const invitationInfo = asyncHandler(async (req: Request, res: Response) => {
    const invitation = await loadUsableInvitation(req.params.token);
    if (!invitation) return sendErrorResponse(res, 404, 'Invito non valido o scaduto');
    const tenant = await Tenant.findByPk(invitation.get('tenantId') as string);
    return sendSuccessResponse(res, 200, {
        centerName: (tenant?.get('businessName') as string | null) || 'Centro Rehablo',
        email: maskedEmail(invitation.get('email') as string),
        expiresAt: invitation.get('expiresAt')
    }, 'Invito valido');
});

export const acceptWithNewAccount = asyncHandler(async (req: Request, res: Response) => {
    const invitation = await loadUsableInvitation(req.params.token);
    if (!invitation) return sendErrorResponse(res, 404, 'Invito non valido o scaduto');
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < 10) {
        return sendErrorResponse(res, 400, 'La password deve contenere almeno 10 caratteri');
    }

    const email = invitation.get('email') as string;
    if (await findUserByIdentityEmail(email)) {
        return sendErrorResponse(res, 409, 'Esiste già un account: accedi per collegare il centro');
    }

    const tenantId = invitation.get('tenantId') as string;
    const patientId = invitation.get('patientId') as string;
    const schema = `rehablo_${tenantId.replaceAll('-', '')}`;
    const patient = await Patient.schema(schema).findByPk(patientId);
    if (!patient) return sendErrorResponse(res, 404, 'Paziente non trovato');

    await sequelize.transaction(async (transaction) => {
        const user = await User.create({
            name: patient.get('name') as string,
            surname: patient.get('surname') as string | null,
            email: normalizeIdentityEmail(email),
            password: await bcrypt.hash(password, 12),
            isActive: true,
            isTenant: false,
            isSuperAdmin: false
        }, { transaction });
        const result = await linkInvitationToUser(
            req.params.token,
            user.get('id') as string,
            transaction
        );
        if (!result) {
            throw Object.assign(new Error('Invito già utilizzato'), { statusCode: 409 });
        }
    });
    return sendSuccessResponse(res, 201, { accepted: true }, 'Account creato e centro collegato');
});

export const acceptWithExistingAccount = asyncHandler(async (req: Request, res: Response) => {
    const invitation = await loadUsableInvitation(req.params.token);
    if (!invitation) return sendErrorResponse(res, 404, 'Invito non valido o scaduto');

    const user = await findUserByIdentityEmail(req.body?.email);
    const password = req.body?.password;
    if (!user || typeof password !== 'string' || !(await bcrypt.compare(password, user.get('password') as string))) {
        return sendErrorResponse(res, 401, 'Email o password errati');
    }
    if (!user.get('isActive') || user.get('deactivatedAt')) {
        return sendErrorResponse(res, 403, 'Account non disponibile');
    }

    const aliasResult = await attachVerifiedEmailAlias(
        user.get('id') as string,
        invitation.get('email') as string
    );
    if (aliasResult === 'conflict') {
        return sendErrorResponse(res, 409, 'L’email dell’invito appartiene a un altro account');
    }

    const result = await linkInvitationToUser(req.params.token, user.get('id') as string);
    if (!result) return sendErrorResponse(res, 409, 'Invito già utilizzato');
    return sendSuccessResponse(res, 200, { accepted: true }, 'Centro collegato all’account');
});

export default {
    invitePatient,
    getPatientPortalAccess,
    updatePatientPortalAccess,
    invitationInfo,
    acceptWithNewAccount,
    acceptWithExistingAccount
};
