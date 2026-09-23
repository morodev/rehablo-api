import { Request, Response } from 'express';
import { Op } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { Tenant } from '../../auth/models/index.js';
import Patient from '../../patients/models/patient.model.js';
import { CarePackage, PackageConsumption, PatientCredit, Quote } from '../../administration/models/administration.model.js';
import { QuoteDelivery } from '../../administration/models/quoteDelivery.model.js';
import { documentHash, quoteDocument } from '../../administration/services/quoteDocument.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import { PatientCreditMovement } from '../../administration/models/patientCreditMovement.model.js';
import PatientPortalAudit from '../models/patientPortalAudit.model.js';

const patientId = (req: Request) => String(req.user!.pid);
const page = (req: Request) => {
    const limit = Number(req.query.limit);
    const offset = Number(req.query.offset);
    return {
        limit: Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20,
        offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
    };
};
const plain = (row: any) => row.get({ plain: true });

async function audit(req: Request, action: string, resource: string, resourceId?: string) {
    await PatientPortalAudit.schema(req.tenantSchema!).create({
        accessId: String(req.user!.patientAccessId), userId: String(req.user!.sub ?? req.user!.id),
        patientId: patientId(req), action, resource, resourceId: resourceId ?? null,
        outcome: 'SUCCESS', ipAddress: (req.ip ?? '').slice(0, 45), userAgent: req.get('user-agent')?.slice(0, 255) ?? null
    });
}

async function latestDelivery(req: Request, quoteId: string) {
    return QuoteDelivery.schema(req.tenantSchema!).findOne({
        where: { quoteId, patientId: patientId(req), status: 'SENT', revokedAt: null },
        order: [['sentAt', 'DESC'], ['createdAt', 'DESC']]
    });
}

export const quotes = asyncHandler(async (req: Request, res: Response) => {
    const pagination = page(req);
    const delivered = await QuoteDelivery.schema(req.tenantSchema!).findAll({
        where: { patientId: patientId(req), status: 'SENT', revokedAt: null }, attributes: ['quoteId']
    });
    const quoteIds = [...new Set(delivered.map(row => String(row.get('quoteId'))))];
    const { rows, count } = await Quote.schema(req.tenantSchema!).findAndCountAll({
        where: { patientId: patientId(req), id: { [Op.in]: quoteIds } },
        order: [['issuedAt', 'DESC'], ['createdAt', 'DESC']], ...pagination
    });
    const items = await Promise.all(rows.map(async quote => {
        const delivery = await latestDelivery(req, String(quote.get('id')));
        return { id: quote.get('id'), status: quote.get('status'), issuedAt: quote.get('issuedAt'),
            total: quote.get('total'), number: quote.get('number'), year: quote.get('year'),
            decisionAt: quote.get('acceptedAt') ?? quote.get('rejectedAt') ?? null,
            deliveryId: delivery?.get('id'), decisionAvailable: Boolean(delivery && quote.get('status') === 'SENT'
                && new Date(delivery.get('expiresAt') as string).getTime() > Date.now()
                && String(quote.get('expiresAt')) >= new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date())) };
    }));
    await audit(req, 'READ', 'quotes');
    return sendSuccessResponse(res, 200, { items, total: count, ...pagination });
});

export const quoteDetail = asyncHandler(async (req: Request, res: Response) => {
    const delivery = await QuoteDelivery.schema(req.tenantSchema!).findOne({
        where: { id: req.params.deliveryId, patientId: patientId(req), status: 'SENT', revokedAt: null }
    });
    if (!delivery) return sendErrorResponse(res, 404, 'Preventivo non disponibile');
    const quote = await Quote.schema(req.tenantSchema!).findOne({ where: { id: delivery.get('quoteId'), patientId: patientId(req) } });
    if (!quote) return sendErrorResponse(res, 404, 'Preventivo non disponibile');
    await audit(req, 'READ', 'quote', String(quote.get('id')));
    return sendSuccessResponse(res, 200, { document: delivery.get('snapshot'), status: quote.get('status'),
        decisionAvailable: quote.get('status') === 'SENT' && new Date(delivery.get('expiresAt') as string).getTime() > Date.now() });
});

export const decideQuote = (decision: 'ACCEPTED' | 'REJECTED') => asyncHandler(async (req: Request, res: Response) => {
    if (req.patientPortalAccess?.get('status') !== 'ACTIVE') return sendErrorResponse(res, 403, 'La cartella storica è di sola lettura');
    const result = await sequelize.transaction(async transaction => {
        const quote = await Quote.schema(req.tenantSchema!).findOne({
            where: { id: req.params.quoteId, patientId: patientId(req) }, transaction, lock: transaction.LOCK.UPDATE
        });
        if (!quote) return { error: 404 as const, message: 'Preventivo non disponibile' };
        if (quote.get('status') !== 'SENT') return { error: 409 as const, message: 'Il preventivo non è più decidibile' };
        const delivery = await QuoteDelivery.schema(req.tenantSchema!).findOne({
            where: { id: req.params.deliveryId, quoteId: quote.get('id'), patientId: patientId(req), status: 'SENT',
                revokedAt: null, expiresAt: { [Op.gt]: new Date() } }, transaction
        });
        if (!delivery) return { error: 409 as const, message: 'Invio scaduto o revocato' };
        const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
        if (String(quote.get('expiresAt')) < today) return { error: 409 as const, message: 'Preventivo scaduto' };
        const [patient, tenant] = await Promise.all([
            Patient.schema(req.tenantSchema!).findByPk(patientId(req), { transaction }),
            Tenant.findByPk(String(req.user!.tid), { transaction })
        ]);
        if (!patient || !tenant || documentHash(quoteDocument(plain(quote), plain(patient), plain(tenant))) !== delivery.get('snapshotHash')) {
            return { error: 409 as const, message: 'La versione inviata è cambiata: chiedi un nuovo invio' };
        }
        await quote.update({ status: decision, ...(decision === 'ACCEPTED' ? { acceptedAt: new Date() } : { rejectedAt: new Date() }) }, { transaction });
        return { status: decision, quoteId: quote.get('id'), decisionAt: decision === 'ACCEPTED'
            ? quote.get('acceptedAt') : quote.get('rejectedAt') };
    });
    if ('error' in result) return sendErrorResponse(res, result.error ?? 409, result.message ?? 'Preventivo non disponibile');
    await audit(req, decision, 'quote', String(result.quoteId));
    return sendSuccessResponse(res, 200, result, decision === 'ACCEPTED' ? 'Preventivo accettato' : 'Preventivo rifiutato');
});

export const packages = asyncHandler(async (req: Request, res: Response) => {
    const pagination = page(req);
    const { rows, count } = await CarePackage.schema(req.tenantSchema!).findAndCountAll({
        where: { patientId: patientId(req) }, order: [['createdAt', 'DESC']], ...pagination
    });
    const ids = rows.map(row => row.get('id'));
    const consumptions = ids.length ? await PackageConsumption.schema(req.tenantSchema!).findAll({
        where: { packageId: { [Op.in]: ids }, status: 'POSTED' }, order: [['consumedAt', 'DESC']]
    }) : [];
    const events = consumptions.map(row => row.get('agendaEventId')).filter((id): id is string => typeof id === 'string');
    const appointments = events.length ? await AgendaEvent.schema(req.tenantSchema!).findAll({
        where: { id: { [Op.in]: events }, patientId: patientId(req) }, attributes: ['id', 'start', 'title']
    }) : [];
    const eventMap = new Map(appointments.map(row => [String(row.get('id')), { start: row.get('start'), title: row.get('title') }]));
    const items = rows.map(row => ({ id: row.get('id'), name: row.get('name'), status: row.get('status'),
        purchasedUnits: row.get('purchasedUnits'), remainingUnits: row.get('remainingUnits'),
        totalPrice: row.get('totalPrice'),
        lines: (Array.isArray(row.get('lines')) ? row.get('lines') as Array<Record<string, unknown>> : []).map(line => ({
            description: String(line['description'] ?? ''), quantity: Number(line['quantity'] ?? 0),
            unitPrice: Number(line['unitPrice'] ?? 0), total: Number(line['total'] ?? 0)
        })), createdAt: row.get('createdAt'),
        consumptions: consumptions.filter(c => c.get('packageId') === row.get('id')).map(c => ({
            id: c.get('id'), units: c.get('units'), consumedAt: c.get('consumedAt'),
            appointment: eventMap.get(String(c.get('agendaEventId'))) ?? null
        })) }));
    await audit(req, 'READ', 'packages');
    return sendSuccessResponse(res, 200, { items, total: count, ...pagination });
});

export const credits = asyncHandler(async (req: Request, res: Response) => {
    const pagination = page(req);
    const Credit = PatientCredit.schema(req.tenantSchema!);
    const where = { patientId: patientId(req) };
    const [{ rows, count }, balance] = await Promise.all([
        Credit.findAndCountAll({ where, order: [['createdAt', 'DESC']], ...pagination }),
        Credit.sum('remainingAmount', { where: { patientId: patientId(req), status: 'ACTIVE',
            sourceType: { [Op.in]: ['TREASURY_ADVANCE', 'VOID_CREDIT'] }, sourceId: { [Op.not]: null } } })
    ]);
    const movements = rows.length ? await PatientCreditMovement.schema(req.tenantSchema!).findAll({
        where: { creditId: { [Op.in]: rows.map(row => row.get('id')) } }, order: [['createdAt', 'DESC']]
    }) : [];
    const items = rows.map(row => ({ id: row.get('id'), amount: row.get('amount'),
        remainingAmount: row.get('remainingAmount'), sourceType: row.get('sourceType'),
        sourceLinked: Boolean(row.get('sourceId')) && ['TREASURY_ADVANCE', 'VOID_CREDIT'].includes(String(row.get('sourceType'))),
        createdAt: row.get('createdAt'),
        movements: movements.filter(item => item.get('creditId') === row.get('id')).map(item => ({
            id: item.get('id'), type: item.get('type'), amount: item.get('amount'), createdAt: item.get('createdAt')
        })) }));
    await audit(req, 'READ', 'credits');
    return sendSuccessResponse(res, 200, { items, total: count, ...pagination,
        balance: Number(balance ?? 0) });
});
