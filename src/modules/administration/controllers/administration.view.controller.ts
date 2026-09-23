import { Request } from 'express';
import { sequelize } from '../../../config/database.js';
import { literal, Model, ModelStatic, Op } from 'sequelize';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { scopeWhere } from '../../../middleware/rbac.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { Structure, Tenant } from '../../auth/models/index.js';
import { Invoice, InvoiceProduct, InvoiceService } from '../../invoice/models/index.js';
import { decorateInvoicesWithPayments } from '../../invoice/services/payment.service.js';
import Patient from '../../patients/models/patient.model.js';
import {
    BillingParty, CarePackage, Expense, FinancialAccount, FiscalSubmission, PatientCredit,
    PaymentMethod, PriceList, PriceListItem, PriceListVersion, PurchaseDocument, Quote,
    Reconciliation, Supplier, TreasuryMovement
} from '../models/index.js';
import {
    AdministrationDateRange, resolveAdministrationDateRange, resolveAdministrationStructure,
    romeToday
} from '../services/administrationQuery.service.js';
import { fiscalDocumentState, fiscalInvoiceScope, visibleRealFiscalSubmissions } from '../services/fiscalSimulation.service.js';
import { balanceEffectiveMovements } from '../services/treasuryLedger.service.js';
export { listFiscalSubmissions, retryFiscalSubmission } from './fiscalSimulation.controller.js';

type Plain = Record<string, any>;

const money = (value: unknown): number => Math.round((Number(value) || 0) * 100) / 100;
const plain = (row: Model): Plain => row.get({ plain: true }) as Plain;

function page(req: Request) {
    return {
        limit: Math.min(Math.max(Number(req.query.limit) || 50, 1), 200),
        offset: Math.max(Number(req.query.offset) || 0, 0)
    };
}

function structureSelection(req: Request) {
    return resolveAdministrationStructure(req.access, req.query.structureId);
}

function structureWhere(req: Request, includeUnassigned = false): Plain {
    const selection = structureSelection(req);
    if (selection.kind === 'all') return {};
    if (selection.kind === 'none') return { [Op.and]: literal('1=0') };
    if (req.access?.scope === 'tenant') {
        return includeUnassigned
            ? { [Op.or]: [{ structureId: selection.structureId }, { structureId: null }] }
            : { structureId: selection.structureId };
    }
    return scopeWhere(req, { structureField: 'structureId', includeUnassigned });
}

function rangeFrom(period: AdministrationDateRange, field: string): Plain {
    const timestamp = field === 'occurredAt';
    const from = timestamp ? period.fromInstant : period.from;
    const to = timestamp ? period.toInstant : period.to;
    if (from && to) return { [field]: { [Op.between]: [from, to] } };
    if (from) return { [field]: { [Op.gte]: from } };
    if (to) return { [field]: { [Op.lte]: to } };
    return {};
}

function requestPeriod(req: Request): AdministrationDateRange {
    return resolveAdministrationDateRange(req.query.from, req.query.to);
}

function range(req: Request, field: string): Plain {
    return rangeFrom(requestPeriod(req), field);
}

async function validateRequestedStructure(req: Request): Promise<void> {
    const selection = structureSelection(req);
    if (req.access?.scope !== 'tenant' || selection.kind !== 'structure') return;
    const count = await Structure.count({
        where: { id: selection.structureId, tenantId: getCurrentTenantId(req) }
    });
    if (!count) {
        const error = new Error('Sede non valida') as Error & { statusCode: number };
        error.statusCode = 400;
        throw error;
    }
}

async function patientNames(schema: string, ids: unknown[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean).map(String))];
    if (!unique.length) return new Map();
    const rows = await Patient.schema(schema).findAll({
        where: { id: { [Op.in]: unique } }, attributes: ['id', 'name', 'surname'], raw: true
    }) as unknown as Plain[];
    return new Map(rows.map(row => [String(row.id), [row.name, row.surname].filter(Boolean).join(' ')]));
}

async function entitiesById(model: ModelStatic<Model>, schema: string, ids: unknown[]): Promise<Map<string, Plain>> {
    const unique = [...new Set(ids.filter(Boolean).map(String))];
    if (!unique.length) return new Map();
    const rows = await model.schema(schema).findAll({ where: { id: { [Op.in]: unique } } });
    return new Map(rows.map(row => [String(row.get('id')), plain(row)]));
}

function queryMatches(req: Request, values: unknown[]): boolean {
    const query = String(req.query.query ?? '').trim().toLocaleLowerCase('it');
    return !query || values.some(value => String(value ?? '').toLocaleLowerCase('it').includes(query));
}

function slicePage<T>(req: Request, rows: T[]) {
    const { limit, offset } = page(req);
    return { items: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
}

async function enrichedQuotes(req: Request, period = requestPeriod(req)): Promise<Plain[]> {
    const where: Plain = { ...structureWhere(req), ...rangeFrom(period, 'issuedAt') };
    if (req.query.status) where.status = req.query.status;
    if (req.query.patientId) where.patientId = req.query.patientId;
    const rows = await Quote.schema(req.tenantSchema!).findAll({ where, order: [['issuedAt', 'DESC'], ['number', 'DESC']] });
    const values = rows.map(plain);
    const [patients, parties, lists] = await Promise.all([
        patientNames(req.tenantSchema!, values.map(row => row.patientId)),
        entitiesById(BillingParty, req.tenantSchema!, values.map(row => row.billingPartyId)),
        entitiesById(PriceList, req.tenantSchema!, values.map(row => row.priceListId))
    ]);
    return values.map(row => {
        const party = parties.get(String(row.billingPartyId)) ?? {};
        const payerName = party.businessName || [party.firstName, party.lastName].filter(Boolean).join(' ') || null;
        return {
            ...row,
            displayNumber: `PRV-${row.year}/${String(row.number).padStart(4, '0')}`,
            patientName: patients.get(String(row.patientId)) ?? null,
            payerName,
            priceListName: row.priceListName || lists.get(String(row.priceListId))?.name || null
        };
    }).filter(row => queryMatches(req, [row.displayNumber, row.patientName, row.payerName, row.priceListName]));
}

export const listQuotes = asyncHandler(async (req, res) => {
    return sendSuccessResponse(res, 200, slicePage(req, await enrichedQuotes(req)));
});

export const getQuote = asyncHandler(async (req, res) => {
    const rows = await enrichedQuotes(req);
    const quote = rows.find(row => String(row.id) === req.params.id);
    return quote ? sendSuccessResponse(res, 200, quote) : sendErrorResponse(res, 404, 'Preventivo non trovato');
});

async function patientEntityPage(req: Request, model: ModelStatic<Model>): Promise<Plain> {
    const where: Plain = { ...structureWhere(req) };
    if (req.query.status) where.status = req.query.status;
    if (req.query.patientId) where.patientId = req.query.patientId;
    const rows = await model.schema(req.tenantSchema!).findAll({ where, order: [['createdAt', 'DESC']] });
    const values = rows.map(plain);
    const patients = await patientNames(req.tenantSchema!, values.map(row => row.patientId));
    return slicePage(req, values.map(row => ({ ...row, patientName: patients.get(String(row.patientId)) ?? null })));
}

export const listCarePackages = asyncHandler(async (req, res) =>
    sendSuccessResponse(res, 200, await patientEntityPage(req, CarePackage))
);

export const listPatientCredits = asyncHandler(async (req, res) => {
    const result = await patientEntityPage(req, PatientCredit);
    // patientEntityPage slices after filtering; the balance must cover every matching credit.
    const balance = await PatientCredit.schema(req.tenantSchema!).sum('remainingAmount', { where: {
        ...structureWhere(req), ...(req.query.patientId ? { patientId: req.query.patientId } : {}), status: 'ACTIVE',
        sourceType: { [Op.in]: ['TREASURY_ADVANCE', 'VOID_CREDIT'] }, sourceId: { [Op.not]: null }
    } });
    return sendSuccessResponse(res, 200, { ...result,
        balance: Math.round(Number(balance ?? 0) * 100) / 100 });
});

export const listPriceLists = asyncHandler(async (req, res) => {
    const lists = (await PriceList.schema(req.tenantSchema!).findAll({ order: [['priority', 'DESC'], ['name', 'ASC']] })).map(plain);
    const listIds = lists.map(row => row.id);
    const versions = listIds.length ? (await PriceListVersion.schema(req.tenantSchema!).findAll({
        where: { priceListId: { [Op.in]: listIds } }, order: [['version', 'DESC']]
    })).map(plain) : [];
    const currentByList = new Map<string, Plain>();
    versions.forEach(version => {
        const key = String(version.priceListId);
        if (!currentByList.has(key) || (version.status === 'PUBLISHED' && currentByList.get(key)?.status !== 'PUBLISHED')) {
            currentByList.set(key, version);
        }
    });
    const versionIds = [...currentByList.values()].map(version => version.id);
    const items = versionIds.length ? (await PriceListItem.schema(req.tenantSchema!).findAll({
        where: { priceListVersionId: { [Op.in]: versionIds } }, attributes: ['priceListVersionId']
    })).map(plain) : [];
    const counts = new Map<string, number>();
    items.forEach(item => counts.set(String(item.priceListVersionId), (counts.get(String(item.priceListVersionId)) ?? 0) + 1));
    const enriched: Plain[] = lists.map((list): Plain => {
        const version = currentByList.get(String(list.id));
        return { ...list, currentVersion: version?.version ?? null, validFrom: version?.validFrom ?? null, itemCount: version ? counts.get(String(version.id)) ?? 0 : 0 };
    }).filter((list: Plain) => queryMatches(req, [list.name, list.code, list.payerName, list.audience]));
    return sendSuccessResponse(res, 200, slicePage(req, enriched));
});

export const listPriceListItems = asyncHandler(async (req, res) => {
    const where: Plain = {};
    if (req.query.priceListVersionId) where.priceListVersionId = req.query.priceListVersionId;
    const rows = (await PriceListItem.schema(req.tenantSchema!).findAll({ where, order: [['description', 'ASC']] })).map(plain);
    const enriched: Plain[] = rows.map((row): Plain => ({
        ...row,
        baseUnitPrice: Number((row.metadata as Plain | undefined)?.baseUnitPrice ?? row.unitPrice)
    })).filter((row: Plain) => queryMatches(req, [row.description, row.itemType]));
    return sendSuccessResponse(res, 200, slicePage(req, enriched));
});

async function accountRows(req: Request): Promise<Plain[]> {
    const where = structureWhere(req, true);
    const accounts = (await FinancialAccount.schema(req.tenantSchema!).findAll({ where, order: [['name', 'ASC']] })).map(plain);
    const ids = accounts.filter(account => account.structureId || req.access?.scope === 'tenant').map(account => account.id);
    const movements = ids.length ? (await TreasuryMovement.schema(req.tenantSchema!).findAll({
        where: { accountId: { [Op.in]: ids } }, attributes: ['id', 'accountId', 'direction', 'amount', 'status', 'reversalOfId']
    })).map(plain) : [];
    const balances = new Map<string, number>();
    balanceEffectiveMovements(movements).forEach(movement => balances.set(String(movement.accountId), money(
        (balances.get(String(movement.accountId)) ?? 0) + (movement.direction === 'IN' ? Number(movement.amount) : -Number(movement.amount))
    )));
    return accounts.map(account => {
        const balanceAvailable = Boolean(account.structureId) || req.access?.scope === 'tenant';
        return {
            ...account, balanceAvailable, canClose: balanceAvailable && account.isActive && account.type === 'CASH',
            balance: balanceAvailable ? money(Number(account.openingBalance) + (balances.get(String(account.id)) ?? 0)) : null
        };
    });
}

export const listFinancialAccounts = asyncHandler(async (req, res) => {
    const rows = (await accountRows(req)).filter(row => queryMatches(req, [row.name, row.type]));
    return sendSuccessResponse(res, 200, slicePage(req, rows));
});

export { listTreasuryMovements } from './treasuryView.controller.js';

async function supplierPage(req: Request, model: ModelStatic<Model>): Promise<Plain> {
    const where: Plain = { ...structureWhere(req) };
    if (req.query.status) where.status = req.query.status;
    if (req.query.supplierId) where.supplierId = req.query.supplierId;
    const dateField = model === Expense ? 'incurredAt' : 'documentDate';
    Object.assign(where, range(req, dateField));
    const rows = (await model.schema(req.tenantSchema!).findAll({ where, order: [[dateField, 'DESC']] })).map(plain);
    const [suppliers, methods] = await Promise.all([
        entitiesById(Supplier, req.tenantSchema!, rows.map(row => row.supplierId)),
        entitiesById(PaymentMethod, req.tenantSchema!, rows.map(row => row.paymentMethodId))
    ]);
    const enriched: Plain[] = rows.map((row): Plain => ({
        ...row,
        supplierName: suppliers.get(String(row.supplierId))?.businessName ?? null,
        paymentMethodName: methods.get(String(row.paymentMethodId))?.label ?? null
    })).filter((row: Plain) => queryMatches(req, [row.description, row.category, row.number, row.supplierName]));
    return slicePage(req, enriched);
}

export const listExpenses = asyncHandler(async (req, res) =>
    sendSuccessResponse(res, 200, await supplierPage(req, Expense))
);

export const listPurchaseDocuments = asyncHandler(async (req, res) =>
    sendSuccessResponse(res, 200, await supplierPage(req, PurchaseDocument))
);

async function documentRows(req: Request, period = requestPeriod(req)): Promise<Plain[]> {
    const schema = req.tenantSchema!;
    const InvoiceScoped = Invoice.schema(schema);
    const where: Plain = { [Op.and]: [structureWhere(req), fiscalInvoiceScope(req), rangeFrom(period, 'emissionDate'),
        ...(req.query.patientId ? [{ patientID: String(req.query.patientId) }] : [])] };
    const rows = await InvoiceScoped.findAll({
        where,
        include: [
            { model: InvoiceProduct.schema(schema), as: 'products' },
            { model: InvoiceService.schema(schema), as: 'services' }
        ],
        order: [['emissionDate', 'DESC'], ['documentNumber', 'DESC']]
    });
    const invoices = await decorateInvoicesWithPayments(schema, rows);
    const [patients, submissions] = await Promise.all([
        patientNames(schema, invoices.map(invoice => invoice.patientID)),
        FiscalSubmission.schema(schema).findAll({
            where: { documentId: { [Op.in]: invoices.map(invoice => invoice.id) } }, order: [['createdAt', 'DESC']]
        })
    ]);
    const fiscalByDocument = new Map<string, Plain[]>();
    submissions.forEach(row => {
        const value = plain(row);
        const prior = fiscalByDocument.get(String(value.documentId)) ?? [];
        prior.push(value);
        fiscalByDocument.set(String(value.documentId), prior);
    });
    const enriched: Plain[] = invoices.map(invoice => {
        const fiscal = fiscalByDocument.get(String(invoice.id)) ?? [];
        const services = [
            ...(invoice.services ?? []).map((line: Plain) => ({ description: line.serviceName ?? 'Prestazione', quantity: Number(line.quantity ?? 1), total: money(line.totalPrice ?? Number(line.servicePrice) * Number(line.quantity ?? 1)) })),
            ...(invoice.products ?? []).map((line: Plain) => ({ description: line.productName ?? 'Prodotto', quantity: Number(line.quantity ?? 1), total: money(line.totalPrice ?? Number(line.productPrice) * Number(line.quantity ?? 1)) }))
        ];
        return {
            ...invoice,
            patientName: patients.get(String(invoice.patientID)) ?? null,
            payerName: patients.get(String(invoice.patientID)) ?? null,
            documentNumber: invoice.documentNumber != null ? `${invoice.documentNumber}/${invoice.documentYear}` : 'Bozza',
            dueDate: invoice.paymentTerms,
            paidAmount: money(invoice.paidAmount), residualAmount: money(invoice.balance),
            ...fiscalDocumentState(invoice, fiscal),
            services
        };
    });
    return enriched.filter(row => queryMatches(req, [row.documentNumber, row.patientName, row.documentType, row.paymentStatus]));
}

export const listDocuments = asyncHandler(async (req, res) => {
    return sendSuccessResponse(res, 200, slicePage(req, await documentRows(req)));
});

function monthBuckets(from: string, to: string): Array<{ key: string; label: string }> {
    const rows: Array<{ key: string; label: string }> = [];
    const cursor = new Date(`${from.slice(0, 7)}-01T12:00:00.000Z`);
    const last = new Date(`${to.slice(0, 7)}-01T12:00:00.000Z`);
    while (cursor <= last && rows.length < 60) {
        const key = cursor.toISOString().slice(0, 7);
        rows.push({ key, label: new Intl.DateTimeFormat('it-IT', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(cursor) });
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return rows;
}

/** Bucket giornalieri per l'andamento infra-mensile della panoramica (max ~62 giorni). */
function dayBuckets(from: string, to: string): Array<{ key: string; label: string }> {
    const rows: Array<{ key: string; label: string }> = [];
    const cursor = new Date(`${from.slice(0, 10)}T12:00:00.000Z`);
    const last = new Date(`${to.slice(0, 10)}T12:00:00.000Z`);
    while (cursor <= last && rows.length < 62) {
        rows.push({
            key: cursor.toISOString().slice(0, 10),
            label: new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(cursor),
        });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return rows;
}

async function effectiveMovementRows(req: Request, period: AdministrationDateRange): Promise<Plain[]> {
    const rows = (await TreasuryMovement.schema(req.tenantSchema!).findAll({
        where: structureWhere(req), order: [['occurredAt', 'DESC']]
    })).map(plain);
    // Resolve reversal pairs over the whole ledger before narrowing to the selected dates.
    return balanceEffectiveMovements(rows).filter(row => {
        const timestamp = new Date(row.occurredAt).getTime();
        return (!period.fromInstant || timestamp >= period.fromInstant.getTime())
            && (!period.toInstant || timestamp <= period.toInstant.getTime());
    });
}

const romeMonth = (value: unknown): string => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit'
}).format(new Date(value as string));
const romeDay = (value: unknown): string => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(value as string));
async function buildReport(req: Request, requestedPeriod?: AdministrationDateRange): Promise<Plain> {
    const today = romeToday();
    const period = requestedPeriod ?? resolveAdministrationDateRange(
        req.query.from ?? `${today.slice(0, 4)}-01-01`,
        req.query.to ?? today
    );
    const from = period.from!;
    const to = period.to!;
    const [documents, movements, expenses, structures] = await Promise.all([
        documentRows(req, period),
        effectiveMovementRows(req, period),
        Expense.schema(req.tenantSchema!).findAll({ where: { ...structureWhere(req), ...rangeFrom(period, 'incurredAt') } }),
        Structure.findAll({ where: { tenantId: getCurrentTenantId(req) }, attributes: ['id', 'name'] })
    ]);
    const movementRows = movements;
    const expenseRows = expenses.map(plain);
    const issued = money(documents.reduce((sum, row) => sum + (row.documentType === 'nota_di_credito' ? -1 : 1) * Number(row.invoiceTotal ?? 0), 0));
    const collected = money(movementRows.filter(row => row.direction === 'IN').reduce((sum, row) => sum + Number(row.amount), 0));
    const expenseTotal = money(expenseRows.reduce((sum, row) => sum + Number(row.amount), 0));
    const buckets = monthBuckets(from, to).map(bucket => ({
        ...bucket,
        issued: money(documents.filter(row => String(row.emissionDate).startsWith(bucket.key)).reduce((sum, row) => sum + (row.documentType === 'nota_di_credito' ? -1 : 1) * Number(row.invoiceTotal ?? 0), 0)),
        collected: money(movementRows.filter(row => row.direction === 'IN' && romeMonth(row.occurredAt) === bucket.key).reduce((sum, row) => sum + Number(row.amount), 0)),
        expenses: money(expenseRows.filter(row => String(row.incurredAt).startsWith(bucket.key)).reduce((sum, row) => sum + Number(row.amount), 0))
    }));
    const categoryTotals = new Map<string, number>();
    documents.forEach(row => {
        const label = row.documentType === 'nota_di_credito' ? 'Note di credito' : row.documentType === 'ricevuta' ? 'Ricevute' : 'Fatture';
        categoryTotals.set(label, money((categoryTotals.get(label) ?? 0) + Math.abs(Number(row.invoiceTotal ?? 0))));
    });
    const categorySum = [...categoryTotals.values()].reduce((sum, value) => sum + value, 0);
    const selection = structureSelection(req);
    const structureRows = structures.map(plain).filter(item => selection.kind === 'all'
        || (selection.kind === 'structure' && String(item.id) === selection.structureId)
    ).map(item => {
        const docs = documents.filter(row => String(row.structureId) === String(item.id));
        const structureIssued = money(docs.reduce((sum, row) => sum + (row.documentType === 'nota_di_credito' ? -1 : 1) * Number(row.invoiceTotal ?? 0), 0));
        const structureCollected = money(movementRows.filter(row => String(row.structureId) === String(item.id) && row.direction === 'IN').reduce((sum, row) => sum + Number(row.amount), 0));
        const structureExpenses = money(expenseRows.filter(row => String(row.structureId) === String(item.id)).reduce((sum, row) => sum + Number(row.amount), 0));
        const receivable = money(docs.reduce((sum, row) => sum + Number(row.residualAmount ?? 0), 0));
        return { name: item.name || 'Sede', issued: structureIssued, collected: structureCollected, expenses: structureExpenses, receivable, marginPercentage: structureCollected ? money((structureCollected - structureExpenses) / structureCollected * 100) : 0 };
    });
    return {
        period: { from, to }, issued, collected, expenses: expenseTotal, margin: money(collected - expenseTotal),
        series: buckets.map(({ label, issued: bucketIssued, collected: bucketCollected, expenses: bucketExpenses }) => ({ label, issued: bucketIssued, collected: bucketCollected, expenses: bucketExpenses })),
        categories: [...categoryTotals.entries()].map(([label, value]) => ({ label, value, percentage: categorySum ? money(value / categorySum * 100) : 0 })),
        structures: structureRows
    };
}

export const reports = asyncHandler(async (req, res) => {
    await validateRequestedStructure(req);
    return sendSuccessResponse(res, 200, await buildReport(req));
});

export const overview = asyncHandler(async (req, res) => {
    await validateRequestedStructure(req);
    const today = romeToday();
    const period = resolveAdministrationDateRange(
        req.query.from ?? `${today.slice(0, 8)}01`,
        req.query.to ?? today
    );
    const from = period.from!;
    const to = period.to!;
    const [report, documents, accounts, quoteRows, fiscalRows, expenseRows, movementRows, tenant] = await Promise.all([
        buildReport(req, period), documentRows(req, period), accountRows(req), enrichedQuotes(req, period),
        visibleRealFiscalSubmissions(req),
        Expense.schema(req.tenantSchema!).findAll({ where: { ...structureWhere(req), ...rangeFrom(period, 'incurredAt') }, order: [['incurredAt', 'DESC']], limit: 25 }),
        effectiveMovementRows(req, period),
        Tenant.findByPk(getCurrentTenantId(req), { attributes: ['featureFlags'] })
    ]);
    const fiscal = fiscalRows.map(plain);
    const expenses = expenseRows.map(plain);
    const movements = movementRows;
    const openQuotes = quoteRows.filter(row => ['DRAFT', 'SENT'].includes(row.status)).length;
    const fiscalPending = fiscal.filter(row => ['QUEUED', 'PROCESSING', 'REJECTED', 'ERROR', 'FAILED'].includes(row.status)).length;
    const receivable = money(documents.reduce((sum, row) => sum + Number(row.residualAmount ?? 0), 0));
    const activities = [
        ...movements.map(row => ({ id: `movement-${row.id}`, kind: row.direction === 'IN' ? 'income' : 'expense', title: row.description || row.category, subtitle: row.counterparty || 'Movimento di prima nota', occurredAt: row.occurredAt, amount: row.direction === 'IN' ? Number(row.amount) : -Number(row.amount) })),
        ...documents.slice(0, 10).map(row => ({ id: `document-${row.id}`, kind: 'document', title: `Documento ${row.documentNumber}`, subtitle: row.patientName || 'Documento emesso', occurredAt: row.emissionDate, amount: Number(row.invoiceTotal ?? 0) })),
        ...expenses.slice(0, 10).map(row => ({ id: `expense-${row.id}`, kind: 'expense', title: row.description || row.category, subtitle: 'Spesa registrata', occurredAt: row.incurredAt, amount: -Number(row.amount) }))
    ].sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt))).slice(0, 8);
    const horizon = new Date(`${to}T12:00:00.000Z`); horizon.setUTCDate(horizon.getUTCDate() + 15);
    const deadlineSource = [
        ...documents.filter(row => row.dueDate && Number(row.residualAmount) > 0).map(row => ({ id: `invoice-${row.id}`, date: row.dueDate, title: `Incasso ${row.documentNumber}`, subtitle: row.patientName || 'Documento da incassare', kind: 'invoice' })),
        ...quoteRows.filter(row => row.expiresAt && ['DRAFT', 'SENT'].includes(row.status)).map(row => ({ id: `quote-${row.id}`, date: row.expiresAt, title: row.displayNumber, subtitle: row.patientName || 'Preventivo in scadenza', kind: 'quote' })),
        ...expenses.filter(row => row.dueDate && row.status !== 'PAID').map(row => ({ id: `expense-${row.id}`, date: row.dueDate, title: row.description || 'Spesa in scadenza', subtitle: row.category, kind: 'expense' }))
    ].filter(row => new Date(`${String(row.date).slice(0, 10)}T12:00:00.000Z`) <= horizon).sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 6)
        .map(row => { const date = new Date(`${String(row.date).slice(0, 10)}T12:00:00.000Z`); return { ...row, day: String(date.getUTCDate()).padStart(2, '0'), month: new Intl.DateTimeFormat('it-IT', { month: 'short', timeZone: 'UTC' }).format(date) }; });
    const flags = (tenant?.get('featureFlags') ?? {}) as Plain;
    const income = money(movements.filter(row => row.direction === 'IN').reduce((sum, row) => sum + Number(row.amount), 0));
    const outcome = money(movements.filter(row => row.direction === 'OUT').reduce((sum, row) => sum + Number(row.amount), 0));
    // Andamento del grafico: giornaliero per un periodo breve (tipicamente il mese selezionato),
    // così si vede un vero andamento invece di un singolo punto; mensile per periodi lunghi.
    const rangeDays = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000;
    const chart = rangeDays >= 0 && rangeDays <= 62
        ? dayBuckets(from, to).map(bucket => ({
            label: bucket.label,
            issued: money(documents
                .filter(row => String(row.emissionDate).slice(0, 10) === bucket.key)
                .reduce((sum, row) => sum + (row.documentType === 'nota_di_credito' ? -1 : 1) * Number(row.invoiceTotal ?? 0), 0)),
            collected: money(movements
                .filter(row => row.direction === 'IN' && romeDay(row.occurredAt) === bucket.key)
                .reduce((sum, row) => sum + Number(row.amount), 0)),
        }))
        : report.series.map((row: Plain) => ({ label: row.label, issued: row.issued, collected: row.collected }));
    return sendSuccessResponse(res, 200, {
        period: { from, to }, issued: report.issued, collected: report.collected, receivable,
        income, outcome, expenses: report.expenses, cashFlow: money(income - outcome), openQuotes, fiscalPending,
        accounts: accounts.map(account => ({ id: account.id, name: account.name, type: account.type, balance: account.balance })),
        tasks: [], activities, deadlines: deadlineSource, chart,
        fiscal: [
            { channel: 'STS', label: 'Sistema Tessera Sanitaria', status: flags.fiscalSandbox ? 'warning' : 'setup', detail: flags.fiscalSandbox ? 'Ambiente di prova attivo' : 'Da configurare' },
            { channel: 'SDI', label: 'Fatturazione elettronica', status: flags.fiscalSandbox ? 'warning' : 'setup', detail: flags.fiscalSandbox ? 'Ambiente di prova attivo' : 'Da configurare' }
        ]
    });
});

const DEFAULT_DOCUMENT_SETTINGS = {
    invoicePrefix: 'FT', creditNotePrefix: 'NC', quotePrefix: 'PRV', defaultDueDays: 30,
    defaultPaymentMethod: '', defaultNote: ''
};

export const getDocumentSettings = asyncHandler(async (req, res) => {
    const tenant = await Tenant.findByPk(getCurrentTenantId(req), { attributes: ['administrationSettings'] });
    if (!tenant) return sendErrorResponse(res, 404, 'Tenant non trovato');
    const settings = (tenant.get('administrationSettings') ?? {}) as Plain;
    return sendSuccessResponse(res, 200, { ...DEFAULT_DOCUMENT_SETTINGS, ...(settings.documents ?? {}) });
});

export const updateDocumentSettings = asyncHandler(async (req, res) => {
    const source = req.body?.data ?? req.body ?? {};
    const documents = {
        invoicePrefix: String(source.invoicePrefix ?? 'FT').trim().slice(0, 12),
        creditNotePrefix: String(source.creditNotePrefix ?? 'NC').trim().slice(0, 12),
        quotePrefix: String(source.quotePrefix ?? 'PRV').trim().slice(0, 12),
        defaultDueDays: Math.min(Math.max(Number(source.defaultDueDays) || 0, 0), 365),
        defaultPaymentMethod: String(source.defaultPaymentMethod ?? '').trim().slice(0, 80),
        defaultNote: String(source.defaultNote ?? '').trim().slice(0, 2000)
    };
    const saved = await sequelize.transaction(async transaction => {
        const tenant = await Tenant.findByPk(getCurrentTenantId(req), { transaction, lock: transaction.LOCK.UPDATE });
        if (!tenant) return false;
        const current = (tenant.get('administrationSettings') ?? {}) as Plain;
        await tenant.update({ administrationSettings: { ...current, documents } }, { transaction });
        return true;
    });
    if (!saved) return sendErrorResponse(res, 404, 'Tenant non trovato');
    return sendSuccessResponse(res, 200, documents, 'Configurazione documenti aggiornata');
});
