import {Request} from 'express';
import {literal, Model, Op, Transaction} from 'sequelize';
import {getGrantedPermissions, getSelectedStructureId, getUserId, patientScopeWhere} from '../../../middleware/rbac.js';
import {Action, Resource, resolveGrantedScope} from '../../auth/rbac/permissions.js';
import {sequelize} from '../../../config/database.js';
import Patient from '../../patients/models/patient.model.js';
import Service from '../../products-services/models/service.model.js';
import ServiceStructure from '../../products-services/models/serviceStructure.model.js';
import {availabilityWhere} from '../../products-services/services/structureAvailability.service.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import {syncInvoicePaymentStatus} from '../../invoice/services/payment.service.js';
import {isValidPaymentDate, paymentMoney} from '../../invoice/services/appointmentPayment.service.js';
import {CarePackage, TreasuryMovement} from '../models/index.js';
import {InvoicePaymentCreateOptions} from './invoicePaymentTreasury.service.js';
import {TREASURY_UUID, treasuryError, nullableTreasuryUuid, validateTreasuryMethod} from './treasuryValidation.service.js';
import {resolveFinancialAccount} from './financialAccountResolver.service.js';
import {beginFinancialOperation} from './financialOperation.service.js';
import {quotePackageFinancialSnapshot} from './quotePackageFinance.js';

export const packageToday = () => new Date().toLocaleDateString('en-CA', {timeZone: 'Europe/Rome'});
export function packageUuid(value: unknown, label = 'Identificativo'): string {
    if (typeof value !== 'string' || !TREASURY_UUID.test(value)) treasuryError(`${label} non valido`);
    return value;
}
export function packageAccessRequest(req: Request, resource: Resource = 'care_package', action: Action = 'read'): Request {
    const scope = req.user?.isSuperAdmin ? 'tenant' : resolveGrantedScope(getGrantedPermissions(req), resource, action);
    if (!scope) treasuryError('Non sei autorizzato a questa operazione', 403);
    return Object.assign(Object.create(req), {access: {resource, action, scope, userId: getUserId(req), structureId: getSelectedStructureId(req)}});
}
export function packagePatientWhere(req: Request, resource: Resource = 'care_package', action: Action = 'read') {
    const scoped = packageAccessRequest(req, resource, action);
    const structureId = packageSelectedStructure(req);
    return {[Op.and]: [packagePatientScope(scoped), {structureId}]};
}
function packagePatientScope(req: Request, field = 'patientId') {
    if (req.access?.scope !== 'own') return patientScopeWhere(req, req.tenantSchema!, field);
    const schema = req.tenantSchema!, userId = packageUuid(getUserId(req)), structureId = packageSelectedStructure(req);
    if (!/^rehablo_[a-z0-9]+$/i.test(schema)) treasuryError('Contesto non valido', 403);
    return {[field]: {[Op.in]: literal(`(SELECT p."id" FROM "${schema}"."patients" p WHERE p."structureId" = '${structureId}'
        AND (p."userId" = '${userId}' OR EXISTS (SELECT 1 FROM "${schema}"."agenda_events" a
        WHERE a."calendarId" = '${userId}' AND a."structureId" = '${structureId}'
        AND (a."patientId" = p."id" OR a."patient"->>'id' = p."id"::text))))`)}};
}
export function packageSelectedStructure(req: Request): string {
    const structureId = getSelectedStructureId(req) ?? req.access?.structureId;
    if (!structureId) treasuryError('Seleziona una sede per gestire i pacchetti', 409);
    if (req.query?.structureId && req.query.structureId !== structureId) treasuryError('La sede richiesta non coincide con quella selezionata', 403);
    return packageUuid(structureId, 'Sede');
}
export async function packagePatient(req: Request, id: unknown, resource: Resource = 'care_package', action: Action = 'read', transaction?: Transaction) {
    const patientId = packageUuid(id, 'Paziente'), scoped = packageAccessRequest(req, resource, action);
    const patient = await Patient.schema(req.tenantSchema!).findOne({where: {[Op.and]: [{id: patientId},
        packagePatientScope(scoped, 'id'),
        {structureId: packageSelectedStructure(req)}]}, transaction});
    if (!patient || !patient.get('structureId')) treasuryError('Paziente non disponibile nella sede', 404);
    return patient;
}
export async function scopedCarePackage(req: Request, id: unknown, transaction?: Transaction, lock = false): Promise<Model> {
    const pack = await CarePackage.schema(req.tenantSchema!).findOne({where: {[Op.and]: [
        {id: packageUuid(id, 'Pacchetto')}, packagePatientWhere(req)]}, transaction,
        ...(lock && transaction ? {lock: transaction.LOCK.UPDATE} : {})});
    if (!pack) treasuryError('Pacchetto non trovato o non accessibile', 404);
    return pack;
}
export async function packageService(req: Request, serviceId: unknown, structureId: string, transaction?: Transaction) {
    const service = await Service.schema(req.tenantSchema!).findOne({where: {[Op.and]: [
        {id: packageUuid(serviceId, 'Prestazione'), isActive: true},
        await availabilityWhere(ServiceStructure, req.tenantSchema!, 'serviceId', structureId)]}, transaction});
    if (!service) treasuryError('Prestazione non disponibile nella sede', 422);
    return service;
}
export function packageIdempotency(req: Request): string {
    const key = req.header('Idempotency-Key') ?? '';
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key)) treasuryError('Identificativo operazione obbligatorio');
    return key;
}
export async function lockPackageOperation(schema: string, key: string, transaction: Transaction): Promise<void> {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:schema), hashtext(:key))', {replacements: {schema, key}, transaction});
}
export interface PackageReceiptInput {amount: number; accountId: string | null; paymentMethodId: string | null; paidAt: string;}
export function normalizePackageReceipt(value: Record<string, unknown>): PackageReceiptInput {
    const amount = Number(value?.amount), paidAt = String(value?.paidAt ?? packageToday());
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) treasuryError('Importo incasso non valido');
    if (!isValidPaymentDate(paidAt)) treasuryError('La data dell’incasso deve essere valida e non futura');
    return {amount: paymentMoney(amount), paidAt, accountId: nullableTreasuryUuid(value?.accountId, 'Conto'), paymentMethodId: nullableTreasuryUuid(value?.paymentMethodId, 'Metodo di pagamento')};
}
export function packageMoneySummary(pack: Record<string, any>, payments: Array<Record<string, any>>) {
    const paidAmount = paymentMoney(payments.filter(payment => payment.status === 'POSTED')
        .reduce((sum, payment) => sum + Number(payment.amount), 0));
    const balance = paymentMoney(Math.max(0, Number(pack.totalPrice) - paidAmount));
    return {paidAmount, balance, paymentStatus: balance <= 0 ? 'paid' : paidAmount > 0 ? 'partial' : 'unpaid'};
}
/** Financial eligibility is independent from the existing booking and origin permission buckets. */
export function isFinancialCarePackage(pack: Record<string, any>): boolean {
    return !!pack.templateId || quotePackageFinancialSnapshot(pack) !== null;
}
export async function recordPackageReceipt(req: Request, pack: Model, input: PackageReceiptInput, key: string, transaction: Transaction) {
    if (!isFinancialCarePackage(pack.get({plain: true}))) treasuryError('I dati economici del pacchetto non sono completi: verifica il preventivo prima di registrare un incasso', 409);
    await packagePatient(req, pack.get('patientId'), 'payment', 'create', transaction);
    const schema = req.tenantSchema!, id = String(pack.get('id'));
    const operation = await beginFinancialOperation(req, 'PACKAGE_RECEIPT', String(pack.get('structureId')), transaction);
    if (operation.replay) {
        const payment = await InvoicePayment.schema(schema).findOne({where: {id: operation.replay.paymentId, carePackageId: id}, transaction});
        if (!payment) treasuryError('Registrazione del pacchetto non disponibile', 409);
        return payment;
    }
    const previous = await TreasuryMovement.schema(schema).findOne({where: {idempotencyKey: key}, transaction});
    if (previous) {
        const payment = await InvoicePayment.schema(schema).findOne({where: {id: String(previous.get('sourceId')), carePackageId: id}, transaction});
        if (!payment || payment.status !== 'POSTED' || previous.get('sourceType') !== 'INVOICE_PAYMENT'
            || Number(payment.amount) !== input.amount || String(payment.paidAt).slice(0, 10) !== input.paidAt
            || (input.accountId && previous.get('accountId') !== input.accountId) || (previous.get('paymentMethodId') ?? null) !== input.paymentMethodId) {
            treasuryError('Identificativo operazione già usato con dati diversi', 409);
        }
        await operation.complete({paymentId: payment.id});
        return payment;
    }
    const accountId = await resolveFinancialAccount(schema, String(pack.get('structureId')), input.accountId, transaction);
    const method = await validateTreasuryMethod(schema, input.paymentMethodId, transaction);
    const payments = await InvoicePayment.schema(schema).findAll({where: {carePackageId: id}, transaction});
    const summary = packageMoneySummary(pack.get({plain: true}), payments.map(row => row.get({plain: true})));
    if (input.amount > summary.balance + 0.009) treasuryError('L’incasso supera il residuo del pacchetto', 409);
    const options: InvoicePaymentCreateOptions = {transaction, treasuryContext: {accountId,
        structureId: String(pack.get('structureId')), paymentMethodId: input.paymentMethodId, idempotencyKey: key}};
    const payment = await InvoicePayment.schema(schema).create({carePackageId: id, invoiceId: pack.get('invoiceId') as string | null,
        agendaEventId: null, amount: input.amount, paidAt: new Date(input.paidAt + 'T12:00:00Z'), method: method ? String(method.get('label')) : null,
        source: 'PACKAGE_PURCHASE', status: 'POSTED', note: `Acquisto ${String(pack.get('name'))}`, createdByUserId: getUserId(req)}, options);
    if (pack.get('invoiceId')) await syncInvoicePaymentStatus(schema, String(pack.get('invoiceId')), transaction);
    await operation.complete({paymentId: payment.id});
    return payment;
}


export type CarePackageOrigin = 'CATALOG' | 'QUOTE' | 'OTHER';
export function carePackageOrigin(pack: Record<string, any>): CarePackageOrigin {return pack.quoteId ? 'QUOTE' : pack.templateId ? 'CATALOG' : 'OTHER';}
/** Origin labels do not change the existing template/non-template authorization buckets. */
export function packageOriginReadWhere(req: Request, mode: 'all' | 'catalog' | 'legacy' = 'all') {
    const branches: object[] = [];
    for (const [resource, templateId] of [['care_package', {[Op.ne]: null}], ['quote', null]] as const) {
        if (mode === 'catalog' && resource !== 'care_package' || mode === 'legacy' && resource !== 'quote') continue;
        try {branches.push({[Op.and]: [packagePatientWhere(req, resource, 'read'), {templateId}]});}
        catch (error) {if ((error as {statusCode?: number}).statusCode !== 403) throw error;}
    }
    if (!branches.length) treasuryError('Non sei autorizzato a consultare questi pacchetti', 403);
    return {[Op.or]: branches};
}
export function packagePatientIdentityWhere(req: Request, resource: Resource, action: Action) {
    return {[Op.and]: [packagePatientScope(packageAccessRequest(req, resource, action), 'id'), {structureId: packageSelectedStructure(req)}]};
}
export async function scopedReadableCarePackage(req: Request, id: unknown, transaction?: Transaction, lock = false): Promise<Model> {
    const pack = await CarePackage.schema(req.tenantSchema!).findOne({where: {[Op.and]: [{id: packageUuid(id, 'Pacchetto')}, packageOriginReadWhere(req)]},
        transaction, ...(lock && transaction ? {lock: transaction.LOCK.UPDATE} : {})});
    if (!pack) treasuryError('Pacchetto non trovato o non accessibile', 404);
    return pack;
}
