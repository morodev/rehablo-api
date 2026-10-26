import {contributionPolicy} from '../../invoice/utils/socialSecurity.js';
import Tenant from '../../auth/models/tenant.model.js';
import {Request} from 'express';
import {Op} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {getCurrentTenantId} from '../../../middleware/auth.js';
import {getSelectedStructureId, getUserId} from '../../../middleware/rbac.js';
import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendSuccessResponse} from '../../../utils/response.js';
import {Structure} from '../../auth/models/index.js';
import Patient from '../../patients/models/patient.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import {syncInvoicePaymentStatus} from '../../invoice/services/payment.service.js';
import {saveInvoice} from '../../invoice/controllers/invoice.controller.js';
import {lockPatientSettlement} from '../../patients/services/patientSettlementPolicy.service.js';
import {CarePackage, FinancialAccount, PackageConsumption, PackageTemplate, PaymentMethod} from '../models/index.js';
import {treasuryError} from '../services/treasuryValidation.service.js';
import {readFinancialOptions} from '../services/financialAccountResolver.service.js';
import {lockPackageOperation, normalizePackageReceipt, packageAccessRequest, packageIdempotency,
    packagePatient, packagePatientWhere, packageSelectedStructure, packageService, packageToday, packageUuid, recordPackageReceipt, scopedCarePackage} from '../services/carePackage.service.js';

import {decorateCarePackages} from '../services/carePackageProjection.service.js';
import {configurePackageBooking} from '../services/packageBooking.service.js';
import {packageOriginReadWhere, scopedReadableCarePackage} from '../services/carePackage.service.js';

const plain = (row: {get: (options: any) => any}) => row.get({plain: true}) as Record<string, any>;
function paging(req: Request) {return {page: Math.max(1, Math.trunc(Number(req.query.page)) || 1),
    limit: Math.max(1, Math.min(100, Math.trunc(Number(req.query.limit)) || 20))};}
function templateWhere(req: Request, action: 'read' | 'create' | 'update' = 'read') {
    const scoped = packageAccessRequest(req, action === 'read' ? 'care_package' : 'price_list', action);
    void scoped;
    return {structureId: packageSelectedStructure(req)};
}
export const listPackageTemplates = asyncHandler(async (req, res) => {
    const {page, limit} = paging(req), q = String(req.query.q ?? '').trim().slice(0, 150);
    const where = {...templateWhere(req), ...(req.query.isActive !== undefined ? {isActive: req.query.isActive === 'true'} : {}),
        ...(q ? {[Op.or]: [{name: {[Op.iLike]: `%${q}%`}}, {serviceName: {[Op.iLike]: `%${q}%`}}]} : {})};
    const result = await PackageTemplate.schema(req.tenantSchema!).findAndCountAll({where, limit, offset: (page - 1) * limit, order: [['name', 'ASC'], ['id', 'ASC']]});
    return sendSuccessResponse(res, 200, {items: result.rows.map(plain), total: result.count, page, limit});
});
export const getPackageTemplate = asyncHandler(async (req, res) => {
    const row = await PackageTemplate.schema(req.tenantSchema!).findOne({where: {id: packageUuid(req.params.id), ...templateWhere(req)}});
    if (!row) treasuryError('Modello di pacchetto non trovato', 404);
    return sendSuccessResponse(res, 200, plain(row));
});
export const savePackageTemplate = asyncHandler(async (req, res) => {
    const body = req.body ?? {}, action = req.params.id ? 'update' : 'create';
    const scoped = packageAccessRequest(req, 'price_list', action);
    if (scoped.access!.scope === 'own') treasuryError('La gestione del catalogo richiede accesso alla sede', 403);
    const result = await sequelize.transaction(async transaction => {
        const current = req.params.id ? await PackageTemplate.schema(req.tenantSchema!).findOne({where: {id: packageUuid(req.params.id),
            ...templateWhere(req, action)}, transaction, lock: transaction.LOCK.UPDATE}) : null;
        if (req.params.id && !current) treasuryError('Modello di pacchetto non trovato', 404);
        const source = {...(current ? plain(current) : {}), ...body};
        const structureId = current?.get('structureId') ?? packageSelectedStructure(req);
        if (body.structureId && body.structureId !== structureId) treasuryError('Il modello appartiene alla sede selezionata', 403);
        packageUuid(structureId, 'Sede');
        if (!await Structure.findOne({where: {id: structureId, tenantId: getCurrentTenantId(req)}, transaction})) treasuryError('Sede non disponibile', 404);
        const name = String(source.name ?? '').trim(), sessionCount = Number(source.sessionCount), totalPrice = Number(source.totalPrice);
        const validityDays = source.validityDays == null || source.validityDays === '' ? null : Number(source.validityDays);
        if (!name || name.length > 160 || !Number.isSafeInteger(sessionCount) || sessionCount < 1 || sessionCount > 10000
            || !Number.isFinite(totalPrice) || totalPrice <= 0 || totalPrice > 99999999 || Math.abs(totalPrice * 100 - Math.round(totalPrice * 100)) > 1e-6
            || (validityDays !== null && (!Number.isSafeInteger(validityDays) || validityDays < 1 || validityDays > 36500))) treasuryError('Nome, numero sedute, prezzo o validità non validi', 422);
        if (source.isActive !== undefined && typeof source.isActive !== 'boolean') treasuryError('Stato del modello non valido');
        const service = await packageService(req, source.serviceId, String(structureId), transaction);
        const data = {structureId, name, serviceId: service.id, serviceName: service.name || 'Prestazione', sessionCount,
            totalPrice, validityDays, isActive: source.isActive ?? true};
        return current ? current.update(data, {transaction}) : PackageTemplate.schema(req.tenantSchema!).create(data, {transaction});
    });
    return sendSuccessResponse(res, req.params.id ? 200 : 201, plain(result));
});

export const listCarePackages = asyncHandler(async (req, res) => {
    const {page, limit} = paging(req), legacy = req.query.legacy === 'true';
    const origin = req.query.origin;
    if (origin !== undefined && (typeof origin !== 'string' || !['all', 'catalog', 'quote', 'other'].includes(origin))) treasuryError('Origine del pacchetto non valida', 422);
    const unified = origin !== undefined;
    const packageId = (legacy || unified) && req.query.packageId !== undefined ? packageUuid(req.query.packageId, 'Pacchetto') : null;
    const q = String(req.query.q ?? '').trim().slice(0, 150);
    const matchingPatients = q ? await Patient.schema(req.tenantSchema!).findAll({where: {
        [Op.or]: [{name: {[Op.iLike]: `%${q}%`}}, {surname: {[Op.iLike]: `%${q}%`}}]}, attributes: ['id']}) : [];
    const statusFilter = (!legacy || unified) && req.query.status === 'EXPIRED' ? {status: 'ACTIVE', expiresAt: {[Op.lt]: packageToday()}}
        : (!legacy || unified) && req.query.status === 'ACTIVE' ? {status: 'ACTIVE', [Op.or]: [{expiresAt: null}, {expiresAt: {[Op.gte]: packageToday()}}]}
        : req.query.status ? {status: String(req.query.status)} : {};
    const originFilter = origin === 'quote' ? {quoteId: {[Op.ne]: null}} : origin === 'catalog' ? {quoteId: null, templateId: {[Op.ne]: null}}
        : origin === 'other' ? {quoteId: null, templateId: null} : {};
    const where = {[Op.and]: [packageOriginReadWhere(req, unified ? 'all' : legacy ? 'legacy' : 'catalog'),
        originFilter,
        ...(packageId ? [{id: packageId}] : []),
        ...(req.query.patientId ? [{patientId: packageUuid(req.query.patientId, 'Paziente')}] : []),
        statusFilter,
        ...(q ? [{[Op.or]: [{name: {[Op.iLike]: `%${q}%`}}, {patientId: {[Op.in]: matchingPatients.map(row => String(row.get('id')))}}]}] : [])]};
    const result = await CarePackage.schema(req.tenantSchema!).findAndCountAll({where, limit, offset: (page - 1) * limit, order: [['createdAt', 'DESC'], ['id', 'ASC']]});
    return sendSuccessResponse(res, 200, {items: await decorateCarePackages(req, result.rows.map(plain)), total: result.count, page, limit});
});
export async function carePackageDetail(req: Request, id: string) {
    const pack = await scopedReadableCarePackage(req, id);
    const [[detail], payments, appointments, consumptions] = await Promise.all([
        decorateCarePackages(req, [plain(pack)], {setupOptions: true}),
        InvoicePayment.schema(req.tenantSchema!).findAll({where: {carePackageId: id}, order: [['createdAt', 'DESC']]}),
        AgendaEvent.schema(req.tenantSchema!).findAll({where: {carePackageId: id}, attributes: ['id', 'start', 'end', 'title', 'status', 'carePackageId', 'packageReservationStatus'], order: [['start', 'ASC']]}),
        PackageConsumption.schema(req.tenantSchema!).findAll({where: {packageId: id}, order: [['consumedAt', 'DESC']]})
    ]);
    return {...detail, payments: payments.map(plain), appointments: appointments.map(plain), consumptions: consumptions.map(plain)};
}
export const getCarePackage = asyncHandler(async (req, res) => sendSuccessResponse(res, 200, await carePackageDetail(req, packageUuid(req.params.id))));
export const createCarePackage = asyncHandler(async (req, res) => {
    const body = req.body ?? {}, templateId = packageUuid(body.templateId, 'Modello'), patientId = packageUuid(body.patientId, 'Paziente');
    const payment = body.payment ? normalizePackageReceipt(body.payment) : null, key = packageIdempotency(req);
    const fingerprint = JSON.stringify({templateId, patientId, payment, expectedTemplateUpdatedAt: body.expectedTemplateUpdatedAt ?? null});
    const result = await sequelize.transaction(async transaction => {
        await lockPackageOperation(req.tenantSchema!, key, transaction);
        const patient = await packagePatient(req, patientId, 'care_package', 'create', transaction);
        await lockPatientSettlement(req.tenantSchema!, patientId, transaction);
        const existing = await CarePackage.schema(req.tenantSchema!).findOne({where: {idempotencyKey: key}, transaction});
        if (existing) {
            if ((existing.get('purchaseSnapshot') as any)?.requestFingerprint !== fingerprint || existing.get('patientId') !== patientId) treasuryError('Identificativo operazione già usato con dati diversi', 409);
            return {id: String(existing.get('id')), reused: true};
        }
        const template = await PackageTemplate.schema(req.tenantSchema!).findOne({where: {id: templateId, structureId: patient.get('structureId'), isActive: true}, transaction, lock: transaction.LOCK.UPDATE});
        if (!template) treasuryError('Pacchetto non disponibile nella sede del paziente', 404);
        if (body.expectedTemplateUpdatedAt && (typeof body.expectedTemplateUpdatedAt !== 'string'
            || Date.parse(body.expectedTemplateUpdatedAt) !== new Date(template.get('updatedAt') as string).getTime())) {
            treasuryError('Il pacchetto è stato modificato: ricarica le condizioni prima di confermare', 409);
        }
        const service = await packageService(req, template.get('serviceId'), String(patient.get('structureId')), transaction);
        const contributionTenant = await Tenant.findByPk(req.user!.tenants[0].id, {transaction});
        const contribution = contributionPolicy(contributionTenant?.socialSecurityFund, contributionTenant?.socialSecurityPricingMode ?? 'EXCLUDED', contributionTenant?.socialSecurityRate ?? 4);
        const purchasedAt = packageToday(), validityDays = template.get('validityDays');
        const expiry = new Date(purchasedAt + 'T12:00:00Z');
        if (validityDays) expiry.setUTCDate(expiry.getUTCDate() + Number(validityDays));
        const pack = await CarePackage.schema(req.tenantSchema!).create({structureId: patient.get('structureId'), patientId,
            templateId, serviceId: service.id, serviceName: service.name, purchasedAt, name: template.get('name'),
            purchasedUnits: template.get('sessionCount'), remainingUnits: template.get('sessionCount'), totalPrice: template.get('totalPrice'),
            status: 'ACTIVE', expiresAt: validityDays ? expiry.toISOString().slice(0, 10) : null, idempotencyKey: key,
            purchaseSnapshot: {socialSecurity: {...contribution, mode: contribution.mode === 'NONE' ? 'NONE' : 'INCLUDED'}, ...plain(template), serviceName: service.name, serviceVat: service.productVat, requestFingerprint: fingerprint},
            lines: [{itemType: 'SERVICE', itemId: service.id, description: service.name, quantity: template.get('sessionCount')}]}, {transaction});
        if (payment) await recordPackageReceipt(req, pack, payment, `package-purchase-${key}`, transaction);
        return {id: String(pack.get('id')), reused: false};
    });
    return sendSuccessResponse(res, result.reused ? 200 : 201, await carePackageDetail(req, result.id));
});
export const createPackagePayment = asyncHandler(async (req, res) => {
    const id = packageUuid(req.params.id), input = normalizePackageReceipt(req.body), key = packageIdempotency(req);
    const snapshot = await scopedCarePackage(req, id);
    await sequelize.transaction(async transaction => {
        await lockPackageOperation(req.tenantSchema!, key, transaction);
        await lockPatientSettlement(req.tenantSchema!, String(snapshot.get('patientId')), transaction);
        const pack = await scopedCarePackage(req, id, transaction, true);
        await recordPackageReceipt(req, pack, input, key, transaction);
    });
    return sendSuccessResponse(res, 200, await carePackageDetail(req, id));
});
export const packagePaymentOptions = asyncHandler(async (req, res) => {
    const patient = await packagePatient(req, req.query.patientId, 'payment', 'create');
    await packagePatient(req, req.query.patientId);
    const options = await readFinancialOptions(req.tenantSchema!, String(patient.get('structureId')));
    return sendSuccessResponse(res, 200, {...options, methods: options.paymentMethods});
});
export const voidPackagePayment = asyncHandler(async (req, res) => {
    const id = packageUuid(req.params.id), paymentId = packageUuid(req.params.paymentId, 'Incasso');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason || reason.length > 1000) treasuryError('Indica il motivo dell’annullamento (massimo 1000 caratteri)');
    const snapshot = await scopedCarePackage(req, id);
    await packagePatient(req, snapshot.get('patientId'), 'payment_reversal', 'create');
    await sequelize.transaction(async transaction => {
        await lockPatientSettlement(req.tenantSchema!, String(snapshot.get('patientId')), transaction);
        const pack = await scopedCarePackage(req, id, transaction, true);
        const payment = await InvoicePayment.schema(req.tenantSchema!).findOne({where: {id: paymentId, carePackageId: id}, transaction, lock: transaction.LOCK.UPDATE});
        if (!payment) treasuryError('Incasso del pacchetto non trovato', 404);
        if (payment.source !== 'PACKAGE_PURCHASE') treasuryError('Questa copertura non è un incasso del pacchetto', 409);
        if (payment.status === 'VOID') return;
        if (payment.status !== 'POSTED') treasuryError('Questo incasso non può essere annullato', 409);
        await payment.update({status: 'VOID', voidedAt: new Date(), voidedByUserId: getUserId(req), voidReason: reason}, {transaction});
        if (pack.get('invoiceId')) await syncInvoicePaymentStatus(req.tenantSchema!, String(pack.get('invoiceId')), transaction);
    });
    return sendSuccessResponse(res, 200, await carePackageDetail(req, id));
});
export const createPackageInvoice = (req: Request, res: any, next: any) => {
    try {packageIdempotency(req); req.body = {carePackageId: packageUuid(req.params.id)}; return saveInvoice(req, res, next);}
    catch (error) {return next(error);}
};

export const setupCarePackageBooking = asyncHandler(async (req, res) => {
    const id = packageUuid(req.params.id, 'Pacchetto');
    await scopedReadableCarePackage(req, id);
    const where = {[Op.and]: [{id, templateId: null}, packagePatientWhere(req, 'quote', 'update')]};
    const snapshot = await CarePackage.schema(req.tenantSchema!).findOne({where});
    if (!snapshot) treasuryError('Pacchetto non trovato o non accessibile', 404);
    await sequelize.transaction(async transaction => {
        await lockPatientSettlement(req.tenantSchema!, String(snapshot!.get('patientId')), transaction);
        const pack = await CarePackage.schema(req.tenantSchema!).findOne({where, transaction, lock: transaction.LOCK.UPDATE});
        if (!pack || pack.get('patientId') !== snapshot!.get('patientId')) treasuryError('Pacchetto cambiato o non accessibile', 409);
        await configurePackageBooking(req, pack!, req.body, transaction);
    });
    return sendSuccessResponse(res, 200, await carePackageDetail(req, id));
});
