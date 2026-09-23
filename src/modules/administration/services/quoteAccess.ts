import { Request } from 'express';
import { Model, Op, Transaction } from 'sequelize';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { patientScopeWhere, scopeWhere } from '../../../middleware/rbac.js';
import Patient from '../../patients/models/patient.model.js';
import { Structure } from '../../auth/models/index.js';
import { quoteDateError } from './quoteDocument.js';

export class QuoteFlowError extends Error {
    constructor(readonly statusCode: number, message: string, readonly details?: unknown) { super(message); }
}

export function validQuoteUuid(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
}

export function quoteScopeWhere(req: Request): Record<PropertyKey, unknown> {
    // Tenant isolation is provided by the selected schema. An empty patient scope inside
    // Op.or would be discarded by Sequelize, incorrectly leaving only patientId IS NULL.
    if (req.access?.scope === 'tenant') return {};
    return { [Op.and]: [
        scopeWhere(req, { structureField: 'structureId', ownerField: 'createdByUserId' }),
        // Legacy drafts may have no patient yet. Keep their existing ownership/sede boundary
        // so operators can repair them; sharing still requires an accessible selected patient.
        { [Op.or]: [{ patientId: null }, patientScopeWhere(req, req.tenantSchema!, 'patientId')] }
    ] };
}

export async function accessibleQuotePatient(req: Request, patientId: unknown, transaction?: Transaction): Promise<Patient> {
    if (!validQuoteUuid(patientId)) throw new QuoteFlowError(422, 'Seleziona un paziente valido');
    const patient = await Patient.schema(req.tenantSchema!).findOne({
        where: { [Op.and]: [{ id: patientId }, patientScopeWhere(req, req.tenantSchema!, 'id')] }, transaction
    });
    if (!patient) throw new QuoteFlowError(404, 'Paziente non disponibile');
    return patient;
}

export async function validateQuoteDraft(req: Request, payload: Record<string, unknown>, existing?: Model, transaction?: Transaction): Promise<void> {
    const previous = existing?.get({ plain: true }) as Record<string, unknown> | undefined;
    const merged = { ...previous, ...payload };
    const dates = quoteDateError(merged.issuedAt, merged.expiresAt);
    if (dates) throw new QuoteFlowError(422, dates);
    await accessibleQuotePatient(req, merged.patientId, transaction);
    if (!validQuoteUuid(merged.structureId)) throw new QuoteFlowError(422, 'Seleziona una sede valida');
    const structure = await Structure.findOne({ where: { id: merged.structureId, tenantId: getCurrentTenantId(req) }, transaction });
    if (!structure) throw new QuoteFlowError(404, 'Sede non disponibile');
    if (payload.status !== undefined && payload.status !== (previous?.status ?? 'DRAFT')) {
        throw new QuoteFlowError(409, 'Lo stato cambia tramite le azioni del preventivo, non durante il salvataggio');
    }
    if (payload.acceptedAt !== undefined || payload.rejectedAt !== undefined) {
        throw new QuoteFlowError(409, 'Usa le azioni di accettazione o rifiuto del preventivo');
    }
    payload.status = previous?.status ?? 'DRAFT';
    if (previous) {
        payload.number = previous.number;
        payload.year = previous.year;
        payload.createdByUserId = previous.createdByUserId;
    }
}
