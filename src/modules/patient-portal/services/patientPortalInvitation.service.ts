import { createHash, randomBytes } from 'node:crypto';
import { Op, Transaction } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { env } from '../../../config/env.js';
import {
    PatientPortalAccess,
    PatientPortalInvitation
} from '../../auth/models/index.js';
import Patient from '../../patients/models/patient.model.js';

export function hashPatientInviteToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}
export async function loadUsableInvitation(token: string, transaction?: Transaction) {
    if (!token) return null;
    return PatientPortalInvitation.findOne({
        where: {
            tokenHash: hashPatientInviteToken(token),
            acceptedAt: { [Op.is]: null },
            invalidatedAt: { [Op.is]: null },
            expiresAt: { [Op.gt]: new Date() }
        },
        transaction,
        lock: transaction ? transaction.LOCK.UPDATE : undefined
    });
}

export async function createInvitation(input: {
    tenantId: string;
    patientId: string;
    email: string;
    normalizedEmail: string;
    invitedByUserId: string;
}) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + env.patientPortalInviteTtlHours * 60 * 60 * 1000);

    const invitationId = await sequelize.transaction(async (transaction) => {
        await PatientPortalInvitation.update(
            { invalidatedAt: new Date() },
            {
                where: {
                    tenantId: input.tenantId,
                    patientId: input.patientId,
                    acceptedAt: { [Op.is]: null },
                    invalidatedAt: { [Op.is]: null }
                },
                transaction
            }
        );
        const invitation = await PatientPortalInvitation.create(
            {
                ...input,
                tokenHash: hashPatientInviteToken(token),
                expiresAt
            },
            { transaction }
        );
        return invitation.get('id') as string;
    });

    return { id: invitationId, token, expiresAt };
}

export async function linkInvitationToUser(
    token: string,
    userId: string,
    existingTransaction?: Transaction
): Promise<{ access: PatientPortalAccess; tenantId: string; patientId: string } | null> {
    const link = async (transaction: Transaction) => {
        const invitation = await loadUsableInvitation(token, transaction);
        if (!invitation) return null;

        const tenantId = invitation.get('tenantId') as string;
        const patientId = invitation.get('patientId') as string;
        const schema = `rehablo_${tenantId.replaceAll('-', '')}`;
        const patient = await Patient.schema(schema).findByPk(patientId, { transaction });
        if (!patient) return null;

        const conflictingSelfAccess = await PatientPortalAccess.findOne({
            where: {
                userId,
                tenantId,
                patientId: { [Op.ne]: patientId },
                relationship: 'SELF',
                status: { [Op.in]: ['ACTIVE', 'HISTORICAL'] }
            },
            transaction,
            lock: transaction.LOCK.UPDATE
        });

        if (conflictingSelfAccess) {
            throw Object.assign(
                new Error('Questo account è già collegato a un’altra anagrafica paziente dello stesso centro'),
                { statusCode: 409 }
            );
        }

        let access = await PatientPortalAccess.findOne({
            where: { tenantId, patientId, relationship: 'SELF' },
            transaction,
            lock: transaction.LOCK.UPDATE
        });

        if (access && access.get('status') !== 'REVOKED' && access.get('userId') !== userId) {
            throw Object.assign(new Error('La cartella è già collegata a un altro account'), { statusCode: 409 });
        }

        const archived = !!patient.get('archivedAt');
        const status = archived ? 'HISTORICAL' : 'ACTIVE';
        if (access) {
            await access.update({
                userId,
                status,
                acceptedAt: new Date(),
                historicalAt: archived ? new Date() : null,
                revokedAt: null,
                revokedByUserId: null
            }, { transaction });
        } else {
            access = await PatientPortalAccess.create({
                userId,
                tenantId,
                patientId,
                relationship: 'SELF',
                status,
                acceptedAt: new Date(),
                historicalAt: archived ? new Date() : null
            }, { transaction });
        }

        await invitation.update({ acceptedAt: new Date() }, { transaction });
        return { access, tenantId, patientId };
    };

    return existingTransaction ? link(existingTransaction) : sequelize.transaction(link);
}
