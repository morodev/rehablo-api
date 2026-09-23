import { Request, Response } from 'express';
import { Model, ModelStatic, Op, Transaction } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { scopeWhere } from '../../../middleware/rbac.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { Structure, Tenant } from '../../auth/models/index.js';
import Patient from '../../patients/models/patient.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import { appointmentPricesByEvent, syncAppointmentPaymentStatus } from '../../invoice/services/appointmentPayment.service.js';
import {
    BillingParty, CarePackage, DailyClosing, Expense, FinancialAccount, FiscalSubmission,
    PackageConsumption, PatientCredit, PaymentAllocation, PaymentMethod, PriceList,
    PriceListItem, PriceListVersion, PurchaseDocument, Quote, Reconciliation, Supplier,
    TreasuryMovement
} from '../models/index.js';
import { validateManualTreasuryMovement } from '../services/treasuryValidation.service.js';
import { createTreasuryClosing, reverseTreasuryMovement } from '../services/treasuryLedger.service.js';
import { submitFiscal } from './fiscalSimulation.controller.js';
import { resolvePrice } from '../services/pricing.service.js';
import { validateQuoteDraft } from '../services/quoteAccess.js';
import { ensureNoPendingQuoteDelivery, loadScopedQuote, revokeQuoteLinks } from '../services/quoteDelivery.service.js';

type AdminModel = ModelStatic<Model>;
interface EntitySpec {
    model: AdminModel;
    fields: string[];
    structureScoped?: boolean;
    appendOnly?: boolean;
}

const SPECS = {
    billingParties: { model: BillingParty, fields: ['type','patientId','businessName','firstName','lastName','taxCode','vatNumber','email','pec','sdiCode','address','city','province','postalCode','country','metadata'] },
    priceLists: { model: PriceList, fields: ['name','code','audience','payerName','description','priority','isDefault','isActive'] },
    priceListVersions: { model: PriceListVersion, fields: ['priceListId','version','validFrom','validTo','status','notes'] },
    priceListItems: { model: PriceListItem, fields: ['priceListVersionId','itemType','itemId','description','unitPrice','vatRate','vatNature','structureId','minQuantity','metadata'] },
    quotes: { model: Quote, fields: ['number','year','structureId','patientId','billingPartyId','priceListId','priceListVersionId','priceListName','priceListOrigin','status','issuedAt','expiresAt','currency','subtotal','taxTotal','total','lines','notes','acceptedAt','rejectedAt','createdByUserId'], structureScoped: true },
    carePackages: { model: CarePackage, fields: ['structureId','patientId','quoteId','name','status','purchasedUnits','remainingUnits','totalPrice','expiresAt','lines','notes'], structureScoped: true },
    packageConsumptions: { model: PackageConsumption, fields: ['packageId','agendaEventId','units','consumedAt','status','note','createdByUserId'], appendOnly: true },
    patientCredits: { model: PatientCredit, fields: ['structureId','patientId','amount','remainingAmount','status','sourceType','sourceId','expiresAt','note'], structureScoped: true },
    paymentMethods: { model: PaymentMethod, fields: ['code','label','type','isTraceable','isActive'] },
    financialAccounts: { model: FinancialAccount, fields: ['structureId','name','type','currency','openingBalance','isActive','metadata'], structureScoped: true },
    treasuryMovements: { model: TreasuryMovement, fields: ['accountId','structureId','direction','category','amount','occurredAt','status','paymentMethodId','counterparty','description','invoiceId','expenseId','sourceType','sourceId','idempotencyKey','createdByUserId','reversalOfId','voidReason'], structureScoped: true, appendOnly: true },
    paymentAllocations: { model: PaymentAllocation, fields: ['movementId','invoiceId','amount'], appendOnly: true },
    dailyClosings: { model: DailyClosing, fields: ['accountId','structureId','closedOn','openingBalance','expectedBalance','countedBalance','difference','status','notes','closedByUserId'], structureScoped: true, appendOnly: true },
    reconciliations: { model: Reconciliation, fields: ['accountId','periodStart','periodEnd','statementBalance','bookBalance','difference','status','matchedMovementIds','notes','completedAt','completedByUserId'] },
    suppliers: { model: Supplier, fields: ['businessName','taxCode','vatNumber','email','pec','sdiCode','phone','address','city','province','postalCode','iban','notes','isActive'] },
    purchaseDocuments: { model: PurchaseDocument, fields: ['structureId','supplierId','type','number','documentDate','dueDate','status','subtotal','taxTotal','total','lines','attachment','notes'], structureScoped: true },
    expenses: { model: Expense, fields: ['structureId','supplierId','purchaseDocumentId','category','description','amount','taxAmount','incurredAt','dueDate','paidAt','status','paymentMethodId','accountId','isDeductible','attachment','createdByUserId'], structureScoped: true },
    fiscalSubmissions: { model: FiscalSubmission, fields: ['channel','documentType','documentId','status','provider','idempotencyKey','payloadSnapshot','externalId','protocolNumber','attempts','lastError','submittedAt','completedAt','createdByUserId'], appendOnly: true }
} satisfies Record<string, EntitySpec>;
type SpecName = keyof typeof SPECS;

const schemaModel = (req: Request, name: SpecName) => SPECS[name].model.schema(req.tenantSchema!);
const specFor = (name: SpecName): EntitySpec => SPECS[name] as EntitySpec;
const bodySource = (req: Request) => req.body?.data ?? req.body ?? {};
const pick = (source: Record<string, unknown>, fields: string[]) => Object.fromEntries(
    fields.filter(field => source[field] !== undefined).map(field => [field, source[field]])
);
const structureWhere = (req: Request, spec: EntitySpec): Record<string, unknown> =>
    spec.structureScoped ? scopeWhere(req, { structureField: 'structureId' }) : {};

function normalizePayload(req: Request, spec: EntitySpec) {
    const payload = pick(bodySource(req), spec.fields);
    if (spec.structureScoped && req.access?.scope !== 'tenant') payload['structureId'] = req.access?.structureId;
    if ('createdByUserId' in payload || spec.fields.includes('createdByUserId')) {
        payload['createdByUserId'] = req.access?.userId;
    }
    return payload;
}

async function snapshotQuotePriceList(req: Request, payload: Record<string, unknown>): Promise<string | null> {
    const priceListId = String(payload['priceListId'] ?? '');
    if (!priceListId) return null;
    const list = await PriceList.schema(req.tenantSchema!).findOne({ where: { id: priceListId, isActive: true } });
    if (!list) return 'Il listino selezionato non e attivo';
    const onDate = String(payload['issuedAt'] ?? new Date().toISOString().slice(0, 10));
    const version = await PriceListVersion.schema(req.tenantSchema!).findOne({
        where: {
            priceListId,
            status: 'PUBLISHED',
            validFrom: { [Op.lte]: onDate },
            [Op.or]: [{ validTo: null }, { validTo: { [Op.gte]: onDate } }]
        },
        order: [['version', 'DESC']]
    });
    if (!version) return 'Il listino non ha una versione pubblicata valida alla data del preventivo';
    payload['priceListVersionId'] = version.get('id');
    payload['priceListName'] = list.get('name');
    payload['priceListOrigin'] = payload['priceListOrigin'] ?? 'EXPLICIT';
    return null;
}

export function normalizeQuoteLines(payload: Record<string, unknown>, required: boolean): string | null {
    if (payload['lines'] === undefined) return required ? 'Aggiungi almeno una voce al preventivo' : null;
    if (!Array.isArray(payload['lines']) || payload['lines'].length === 0) return 'Aggiungi almeno una voce al preventivo';
    const normalized: Array<Record<string, unknown>> = [];
    for (const candidate of payload['lines'] as unknown[]) {
        if (!candidate || typeof candidate !== 'object') return 'Una o piu righe del preventivo non sono valide';
        const raw = candidate as Record<string, unknown>;
        const itemType = String(raw['itemType'] ?? '').toUpperCase();
        const description = String(raw['description'] ?? '').trim();
        const quantity = Number(raw['quantity']);
        const unitPrice = Number(raw['unitPrice']);
        const baseUnitPrice = Number(raw['baseUnitPrice'] ?? unitPrice);
        if (!['SERVICE', 'PRODUCT', 'CUSTOM'].includes(itemType) || !description || !Number.isFinite(quantity) || !(quantity > 0)
            || raw['unitPrice'] === null || raw['unitPrice'] === undefined || raw['unitPrice'] === ''
            || !Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(baseUnitPrice) || baseUnitPrice < 0) {
            return 'Una o piu righe del preventivo non sono valide';
        }
        normalized.push({
            ...raw, itemType, description, quantity, unitPrice, baseUnitPrice: itemType === 'CUSTOM' ? unitPrice : baseUnitPrice,
            total: Math.round(quantity * unitPrice * 100) / 100
        });
    }
    payload['lines'] = normalized;
    payload['subtotal'] = Math.round(normalized.reduce((sum, line) =>
        sum + Math.round(Number(line['baseUnitPrice']) * Number(line['quantity']) * 100) / 100, 0) * 100) / 100;
    payload['total'] = Math.round(normalized.reduce((sum, line) => sum + Number(line['total']), 0) * 100) / 100;
    payload['taxTotal'] = Number(payload['taxTotal'] ?? 0);
    return null;
}

function list(name: SpecName) {
    return asyncHandler(async (req, res) => {
        const spec = specFor(name);
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
        const offset = Math.max(Number(req.query.offset) || 0, 0);
        const where: Record<string, unknown> = { ...structureWhere(req, spec) };
        for (const field of ['status','patientId','supplierId','priceListId','priceListVersionId','accountId']) {
            if (req.query[field]) where[field] = req.query[field];
        }
        const { rows, count } = await schemaModel(req, name).findAndCountAll({
            where, limit, offset, order: [['createdAt', 'DESC']]
        });
        return sendSuccessResponse(res, 200, { items: rows, total: count, limit, offset });
    });
}

function create(name: SpecName) {
    return asyncHandler(async (req, res) => {
        const spec = specFor(name);
        if (name === 'dailyClosings') return sendSuccessResponse(res, 201, await createTreasuryClosing(req, bodySource(req)), 'Chiusura cassa registrata');
        const payload = normalizePayload(req, spec);
        if (spec.structureScoped && !payload['structureId']) return sendErrorResponse(res, 400, 'Seleziona una sede');
        if (name === 'quotes') {
            await validateQuoteDraft(req, payload);
            const year = Number(payload['year'] ?? new Date().getFullYear());
            payload['year'] = year;
            payload['number'] ??= Number(await schemaModel(req, name).max('number', { where: { year } }) ?? 0) + 1;
            payload['issuedAt'] ??= new Date().toISOString().slice(0, 10);
            const linesError = normalizeQuoteLines(payload, true);
            if (linesError) return sendErrorResponse(res, 400, linesError);
            const pricingError = await snapshotQuotePriceList(req, payload);
            if (pricingError) return sendErrorResponse(res, 409, pricingError);
        }
        if (name === 'treasuryMovements') {
            await validateManualTreasuryMovement(req, payload);
            payload['idempotencyKey'] = req.header('Idempotency-Key') ?? payload['idempotencyKey'];
            if (!payload['idempotencyKey']) return sendErrorResponse(res, 400, 'Identificativo della registrazione mancante');
            const existing = await schemaModel(req, name).findOne({ where: { idempotencyKey: payload['idempotencyKey'] } });
            if (existing) return sendSuccessResponse(res, 200, existing, 'Movimento gia registrato');
            payload['status'] = 'POSTED';
        }
        const entity = await schemaModel(req, name).create(payload);
        if (name === 'priceLists' && payload['isDefault'] === true) {
            await PriceList.schema(req.tenantSchema!).update(
                { isDefault: false },
                { where: { id: { [Op.ne]: entity.get('id') } } }
            );
            await Tenant.update(
                { defaultPriceListId: entity.get('id') as string },
                { where: { id: getCurrentTenantId(req) } }
            );
        }
        if (name === 'priceListVersions') {
            const Version = PriceListVersion.schema(req.tenantSchema!);
            const Item = PriceListItem.schema(req.tenantSchema!);
            const priceListId = String(entity.get('priceListId'));
            const requestedSourceId = String(bodySource(req)['copyFromVersionId'] ?? '');
            let sourceVersion = requestedSourceId
                ? await Version.findOne({ where: { id: requestedSourceId } })
                : await Version.findOne({
                    where: { priceListId, id: { [Op.ne]: entity.get('id') } },
                    order: [['version', 'DESC']]
                });
            if (!sourceVersion) {
                const defaultList = await PriceList.schema(req.tenantSchema!).findOne({
                    where: { isActive: true, id: { [Op.ne]: priceListId } },
                    order: [['isDefault', 'DESC'], ['priority', 'DESC'], ['createdAt', 'ASC']]
                });
                if (defaultList) {
                    sourceVersion = await Version.findOne({
                        where: { priceListId: defaultList.get('id'), status: 'PUBLISHED' },
                        order: [['version', 'DESC']]
                    });
                }
            }
            if (sourceVersion) {
                const sourceItems = await Item.findAll({ where: { priceListVersionId: sourceVersion.get('id') } });
                if (sourceItems.length) {
                    await Item.bulkCreate(sourceItems.map(item => {
                        const value = item.get({ plain: true }) as Record<string, any>;
                        const metadata = (value.metadata ?? {}) as Record<string, unknown>;
                        return {
                            priceListVersionId: entity.get('id'), itemType: value.itemType, itemId: value.itemId,
                            description: value.description, unitPrice: value.unitPrice, vatRate: value.vatRate,
                            vatNature: value.vatNature, structureId: value.structureId, minQuantity: value.minQuantity,
                            metadata: { ...metadata, baseUnitPrice: metadata['baseUnitPrice'] ?? Number(value.unitPrice) }
                        };
                    }));
                }
            }
        }
        return sendSuccessResponse(res, 201, entity, 'Creato');
    });
}

function update(name: SpecName) {
    return asyncHandler(async (req, res) => {
        if (name === 'quotes') {
            const quote = await sequelize.transaction(async transaction => {
                const entity = await loadScopedQuote(req, transaction);
                if (['ACCEPTED', 'REJECTED', 'EXPIRED'].includes(String(entity.get('status')))) {
                    throw Object.assign(new Error('Il preventivo non è più modificabile'), { statusCode: 409 });
                }
                await ensureNoPendingQuoteDelivery(req, entity.get('id'), transaction);
                const payload = normalizePayload(req, SPECS.quotes);
                await validateQuoteDraft(req, payload, entity, transaction);
                const linesError = normalizeQuoteLines(payload, false);
                if (linesError) throw Object.assign(new Error(linesError), { statusCode: 400 });
                const pricedPayload = { ...entity.get({ plain: true }), ...payload };
                const pricingError = await snapshotQuotePriceList(req, pricedPayload);
                if (pricingError) throw Object.assign(new Error(pricingError), { statusCode: 409 });
                for (const field of ['priceListVersionId', 'priceListName', 'priceListOrigin']) {
                    payload[field] = pricedPayload['priceListId'] ? pricedPayload[field] : null;
                }
                if (payload.patientId !== undefined && payload.patientId !== entity.get('patientId')) {
                    await revokeQuoteLinks(req, entity.get('id'), transaction);
                }
                await entity.update(payload, { transaction });
                return entity;
            });
            return sendSuccessResponse(res, 200, quote, 'Preventivo salvato');
        }
        const spec = specFor(name);
        if (spec.appendOnly) return sendErrorResponse(res, 409, 'Il registro e append-only: usa una operazione di storno');
        const entity = await schemaModel(req, name).findOne({ where: { id: req.params.id, ...structureWhere(req, spec) } });
        if (!entity) return sendErrorResponse(res, 404, 'Elemento non trovato');
        if (name === 'priceListVersions' && entity.get('status') === 'PUBLISHED') {
            return sendErrorResponse(res, 409, 'Una versione pubblicata e immutabile: creane una nuova');
        }
        const payload = normalizePayload(req, spec);
        await entity.update(payload);
        return sendSuccessResponse(res, 200, entity, 'Aggiornato');
    });
}

function remove(name: SpecName) {
    return asyncHandler(async (req, res) => {
        if (name === 'quotes') {
            await sequelize.transaction(async transaction => {
                const quote = await loadScopedQuote(req, transaction);
                await ensureNoPendingQuoteDelivery(req, quote.get('id'), transaction);
                await revokeQuoteLinks(req, quote.get('id'), transaction);
                await quote.destroy({ transaction });
            });
            return sendSuccessResponse(res, 200, { id: req.params.id }, 'Eliminato');
        }
        const spec = specFor(name);
        if (spec.appendOnly) return sendErrorResponse(res, 409, 'Il registro e append-only');
        const entity = await schemaModel(req, name).findOne({ where: { id: req.params.id, ...structureWhere(req, spec) } });
        if (!entity) return sendErrorResponse(res, 404, 'Elemento non trovato');
        await entity.destroy();
        return sendSuccessResponse(res, 200, { id: req.params.id }, 'Eliminato');
    });
}

const getCapabilities = asyncHandler(async (req, res) => {
    const tenant = await Tenant.findByPk(getCurrentTenantId(req), { attributes: ['featureFlags'] });
    const flags = (tenant?.get('featureFlags') ?? {}) as Record<string, boolean>;
    return sendSuccessResponse(res, 200, {
        administration: flags.administration === true,
        fiscalSandbox: flags.fiscalSandbox === true,
        fiscalProvider: 'MOCK', realTransmissionEnabled: false
    });
});

const updateCapabilities = asyncHandler(async (req, res) => {
    if (!req.user?.isSuperAdmin && req.user?.role !== 'OWNER') {
        return sendErrorResponse(res, 403, 'Solo il titolare puo attivare il modulo');
    }
    const tenant = await Tenant.findByPk(getCurrentTenantId(req));
    if (!tenant) return sendErrorResponse(res, 404, 'Tenant non trovato');
    const current = (tenant.get('featureFlags') ?? {}) as Record<string, boolean>;
    const source = bodySource(req);
    const flags = {
        ...current,
        ...(typeof source['administration'] === 'boolean' ? { administration: source['administration'] } : {}),
        ...(typeof source['fiscalSandbox'] === 'boolean' ? { fiscalSandbox: source['fiscalSandbox'] } : {})
    };
    await tenant.update({ featureFlags: flags });
    return sendSuccessResponse(res, 200, { ...flags, fiscalProvider: 'MOCK', realTransmissionEnabled: false });
});

const pricingResolve = asyncHandler(async (req, res) => {
    const itemType = String(req.query.itemType ?? '').toUpperCase();
    const itemId = String(req.query.itemId ?? '');
    if (!['SERVICE','PRODUCT'].includes(itemType) || !itemId) return sendErrorResponse(res, 400, 'itemType e itemId obbligatori');
    const result = await resolvePrice(req.tenantSchema!, getCurrentTenantId(req), {
        itemType: itemType as 'SERVICE' | 'PRODUCT', itemId,
        onDate: String(req.query.onDate ?? new Date().toISOString().slice(0, 10)),
        structureId: String(req.query.structureId ?? req.access?.structureId ?? '') || null,
        patientId: String(req.query.patientId ?? '') || null,
        explicitPriceListId: String(req.query.priceListId ?? '') || null,
        quantity: Number(req.query.quantity ?? 1)
    });
    return result ? sendSuccessResponse(res, 200, result) : sendErrorResponse(res, 404, 'Nessun prezzo applicabile');
});

const publishPriceListVersion = asyncHandler(async (req, res) => {
    const Version = PriceListVersion.schema(req.tenantSchema!);
    const version = await Version.findByPk(req.params.id);
    if (!version) return sendErrorResponse(res, 404, 'Versione non trovata');
    if (version.get('status') === 'PUBLISHED') return sendSuccessResponse(res, 200, version);
    const itemCount = await PriceListItem.schema(req.tenantSchema!).count({ where: { priceListVersionId: version.get('id') } });
    if (!itemCount) return sendErrorResponse(res, 409, 'Aggiungi almeno una tariffa prima di pubblicare');
    await version.update({ status: 'PUBLISHED' });
    return sendSuccessResponse(res, 200, version, 'Versione pubblicata');
});

const quoteDecision = (status: 'ACCEPTED' | 'REJECTED') => asyncHandler(async (req, res) => {
    const quote = await Quote.schema(req.tenantSchema!).findOne({ where: { id: req.params.id, ...structureWhere(req, SPECS.quotes) } });
    if (!quote) return sendErrorResponse(res, 404, 'Preventivo non trovato');
    if (!['DRAFT','SENT'].includes(String(quote.get('status')))) return sendErrorResponse(res, 409, 'Stato del preventivo non modificabile');
    await quote.update({ status, ...(status === 'ACCEPTED' ? { acceptedAt: new Date() } : { rejectedAt: new Date() }) });
    return sendSuccessResponse(res, 200, quote);
});
const assignPriceList = asyncHandler(async (req, res) => {
    const priceList = await PriceList.schema(req.tenantSchema!).findOne({
        where: { id: req.params.id, isActive: true }
    });
    if (!priceList) return sendErrorResponse(res, 404, 'Listino attivo non trovato');
    const source = bodySource(req);
    const priceListId = priceList.get('id') as string;
    const scope = String(source['scope'] ?? '').toUpperCase();
    const targetId = String(source['targetId'] ?? '');
    if (scope === 'TENANT') {
        await Tenant.update(
            { defaultPriceListId: priceListId },
            { where: { id: getCurrentTenantId(req) } }
        );
    } else if (scope === 'STRUCTURE') {
        const [updated] = await Structure.update(
            { defaultPriceListId: priceListId },
            { where: { id: targetId, tenantId: getCurrentTenantId(req) } }
        );
        if (!updated) return sendErrorResponse(res, 404, 'Sede non trovata');
    } else if (scope === 'PATIENT') {
        const [updated] = await Patient.schema(req.tenantSchema!).update(
            { defaultPriceListId: priceListId },
            { where: { id: targetId } }
        );
        if (!updated) return sendErrorResponse(res, 404, 'Paziente non trovato');
    } else {
        return sendErrorResponse(res, 400, 'scope deve essere TENANT, STRUCTURE o PATIENT');
    }
    return sendSuccessResponse(res, 200, {
        priceListId, scope, targetId: scope === 'TENANT' ? getCurrentTenantId(req) : targetId
    }, 'Listino assegnato');
});


const createPackageFromQuote = asyncHandler(async (req, res) => {
    const source = bodySource(req);
    const result = await sequelize.transaction(async transaction => {
        // Serializing on the quote also makes concurrent clicks idempotent.
        const quote = await Quote.schema(req.tenantSchema!).findOne({ where: {
            id: req.params.id, status: 'ACCEPTED', ...structureWhere(req, SPECS.quotes)
        }, transaction, lock: transaction.LOCK.UPDATE });
        if (!quote) return { error: 404, message: 'Preventivo accettato non trovato' };
        const existing = await CarePackage.schema(req.tenantSchema!).findOne({
            where: { quoteId: quote.get('id') }, transaction
        });
        if (existing) return { carePackage: existing, reused: true };
        const serviceLines = (Array.isArray(quote.get('lines')) ? quote.get('lines') as Array<Record<string, unknown>> : [])
            .filter(line => line['itemType'] === 'SERVICE');
        const units = serviceLines.reduce((sum, line) => sum + Number(line['quantity']), 0);
        if (!serviceLines.length || !Number.isSafeInteger(units) || units <= 0
            || serviceLines.some(line => !Number.isSafeInteger(Number(line['quantity'])) || Number(line['quantity']) <= 0)) {
            return { error: 422, message: 'Il preventivo non contiene un numero di sedute valido' };
        }
        const carePackage = await CarePackage.schema(req.tenantSchema!).create({
            quoteId: quote.get('id'), structureId: quote.get('structureId'), patientId: quote.get('patientId'),
            name: source['name'] ?? `Pacchetto preventivo ${quote.get('number')}`,
            purchasedUnits: units, remainingUnits: units, totalPrice: quote.get('total'), lines: quote.get('lines'),
            expiresAt: null, notes: source['notes'] ?? null
        }, { transaction });
        return { carePackage, reused: false };
    });
    if ('error' in result) return sendErrorResponse(res, result.error ?? 409, result.message ?? 'Pacchetto non disponibile');
    return sendSuccessResponse(res, result.reused ? 200 : 201, result.carePackage, 'Pacchetto attivato');
});

const consumePackage = asyncHandler(async (req, res) => {
    const source = bodySource(req);
    const units = Number(source['units'] ?? 1);
    const agendaEventId = source['agendaEventId'] ?? null;
    if (!Number.isInteger(units) || units < 1 || (agendaEventId && units !== 1)) {
        return sendErrorResponse(res, 400, 'Seleziona una sola seduta valida');
    }
    if (agendaEventId && (typeof agendaEventId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agendaEventId))) {
        return sendErrorResponse(res, 400, 'Seduta non valida');
    }
    const result = await sequelize.transaction(async (transaction: Transaction) => {
        const Pack = CarePackage.schema(req.tenantSchema!);
        const pack = await Pack.findOne({ where: { id: req.params.id, ...structureWhere(req, SPECS.carePackages) }, transaction, lock: transaction.LOCK.UPDATE });
        if (!pack || pack.get('status') !== 'ACTIVE') return null;
        const remaining = Number(pack.get('remainingUnits'));
        if (units > remaining) throw Object.assign(new Error('Sedute residue insufficienti'), { status: 409 });
        const expiry = pack.get('expiresAt');
        if (expiry && String(expiry).slice(0, 10) < new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' })) {
            throw Object.assign(new Error('Il pacchetto è scaduto'), { status: 409 });
        }
        // Validate and lock the appointment before changing the package balance.
        const appointment = agendaEventId ? await settleAppointmentWithPackage(req, agendaEventId, pack, transaction) : null;
        const consumption = await PackageConsumption.schema(req.tenantSchema!).create({
            packageId: pack.get('id'), agendaEventId,
            units, note: source['note'] ?? null, createdByUserId: req.access?.userId
        }, { transaction });
        await pack.update({ remainingUnits: remaining - units, status: remaining === units ? 'EXHAUSTED' : 'ACTIVE' }, { transaction });
        return { package: pack, consumption, appointment };
    });
    return result ? sendSuccessResponse(res, 201, result) : sendErrorResponse(res, 404, 'Pacchetto attivo non trovato');
});

/**
 * Package coverage is a non-cash settlement. The payment row makes existing appointment and
 * invoice balance readers recognize it; source PACKAGE prevents a second treasury receipt.
 */
async function settleAppointmentWithPackage(req: Request, agendaEventId: string, pack: Model, transaction: Transaction): Promise<'settled'> {
    const schema = req.tenantSchema!;
    const event = await AgendaEvent.schema(schema).findByPk(agendaEventId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!event || String(event.get('patientId') ?? '') !== String(pack.get('patientId') ?? '')
        || String(event.get('structureId') ?? '') !== String(pack.get('structureId') ?? '')
        || !['CONFIRMED', 'COMPLETED'].includes(String(event.get('status') ?? '').toUpperCase())
        || event.get('recurrence') || event.get('recurringEventId')) {
        throw Object.assign(new Error('La seduta non appartiene al paziente o alla sede del pacchetto'), { status: 409 });
    }
    if (event.get('invoiceId')) throw Object.assign(new Error('La seduta è già fatturata'), { status: 409 });
    const alreadyConsumed = await PackageConsumption.schema(schema).count({ where: { agendaEventId, status: 'POSTED' }, transaction });
    if (alreadyConsumed) throw Object.assign(new Error('Questa seduta è già stata usata da un pacchetto'), { status: 409 });
    const existing = await InvoicePayment.schema(schema).count({ where: { agendaEventId, status: 'POSTED' }, transaction });
    if (existing > 0) throw Object.assign(new Error('Questa seduta ha già un pagamento registrato'), { status: 409 });
    const price = (await appointmentPricesByEvent(schema, [event.get({ plain: true })], transaction)).get(String(agendaEventId));
    const units = Number(pack.get('purchasedUnits'));
    const unitPrice = units > 0 ? Math.round(Number(pack.get('totalPrice')) / units * 100) / 100 : null;
    const amount = price?.amount ?? unitPrice;
    if (!amount || amount <= 0) throw Object.assign(new Error('Impossibile determinare il valore della seduta'), { status: 409 });
    if (price?.amount == null) {
        await event.update({ appointmentExpectedAmount: amount, appointmentPriceRecordedAt: new Date() }, { transaction });
    }
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
    await InvoicePayment.schema(schema).create({
        agendaEventId, invoiceId: event.get('invoiceId') ?? null, amount,
        paidAt: new Date(today + 'T12:00:00.000Z'), method: 'Pacchetto', note: 'Seduta coperta da pacchetto',
        source: 'PACKAGE', status: 'POSTED', createdByUserId: req.access?.userId
    }, { transaction });
    await syncAppointmentPaymentStatus(schema, event, transaction, req.access?.userId);
    return 'settled';
}

const voidMovement = asyncHandler(async (req, res) => {
    const result = await reverseTreasuryMovement(req, bodySource(req));
    return sendSuccessResponse(res, result.created ? 201 : 200, result.row, 'Storno registrato');
});
const overview = asyncHandler(async (req, res) => {
    const movementWhere = { status: 'POSTED', ...structureWhere(req, SPECS.treasuryMovements) };
    const expenseWhere = { ...structureWhere(req, SPECS.expenses) };
    const [income, outcome, expenses, openQuotes, fiscalPending] = await Promise.all([
        TreasuryMovement.schema(req.tenantSchema!).sum('amount', { where: { ...movementWhere, direction: 'IN' } }),
        TreasuryMovement.schema(req.tenantSchema!).sum('amount', { where: { ...movementWhere, direction: 'OUT' } }),
        Expense.schema(req.tenantSchema!).sum('amount', { where: expenseWhere }),
        Quote.schema(req.tenantSchema!).count({ where: { ...structureWhere(req, SPECS.quotes), status: { [Op.in]: ['DRAFT','SENT'] } } }),
        FiscalSubmission.schema(req.tenantSchema!).count({ where: { status: { [Op.in]: ['QUEUED','PROCESSING','REJECTED'] } } })
    ]);
    return sendSuccessResponse(res, 200, {
        income: Number(income ?? 0), outcome: Number(outcome ?? 0), expenses: Number(expenses ?? 0),
        cashFlow: Number(income ?? 0) - Number(outcome ?? 0), openQuotes, fiscalPending
    });
});

const accountantExport = asyncHandler(async (req, res) => {
    const from = String(req.query.from ?? `${new Date().getFullYear()}-01-01`);
    const to = String(req.query.to ?? new Date().toISOString().slice(0, 10));
    const [movements, expenses, invoices] = await Promise.all([
        TreasuryMovement.schema(req.tenantSchema!).findAll({ where: { occurredAt: { [Op.between]: [from, `${to}T23:59:59`] }, ...structureWhere(req, SPECS.treasuryMovements) }, order: [['occurredAt','ASC']] }),
        Expense.schema(req.tenantSchema!).findAll({ where: { incurredAt: { [Op.between]: [from, to] }, ...structureWhere(req, SPECS.expenses) }, order: [['incurredAt','ASC']] }),
        Invoice.schema(req.tenantSchema!).findAll({ where: { emissionDate: { [Op.between]: [from, to] } }, order: [['emissionDate','ASC']] })
    ]);
    return sendSuccessResponse(res, 200, { period: { from, to }, generatedAt: new Date(), movements, expenses, invoices });
});

export default {
    list, create, update, remove, getCapabilities, updateCapabilities, pricingResolve,
    publishPriceListVersion, assignPriceList, acceptQuote: quoteDecision('ACCEPTED'), rejectQuote: quoteDecision('REJECTED'),
    createPackageFromQuote, consumePackage, voidMovement, submitFiscal, overview, accountantExport
};
