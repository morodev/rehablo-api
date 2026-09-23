import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { QuoteDelivery } from './quoteDelivery.model.js';

const id = { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true };
const uuid = (allowNull = true) => ({ type: DataTypes.UUID, allowNull });
const text = (allowNull = true) => ({ type: DataTypes.STRING, allowNull });
const money = (allowNull = false, defaultValue?: number) => ({
    type: DataTypes.DECIMAL(12, 2), allowNull, ...(defaultValue === undefined ? {} : { defaultValue })
});
const date = (allowNull = true) => ({ type: DataTypes.DATEONLY, allowNull });
const json = (defaultValue: unknown = {}) => ({ type: DataTypes.JSONB, allowNull: false, defaultValue });

/** Snapshot anagrafico del soggetto intestatario di preventivi e documenti. */
export class BillingParty extends Model {}
BillingParty.init({
    id,
    type: { ...text(false), defaultValue: 'PERSON' },
    patientId: uuid(),
    businessName: text(),
    firstName: text(),
    lastName: text(),
    taxCode: text(),
    vatNumber: text(),
    email: text(), pec: text(), sdiCode: text(),
    address: text(), city: text(), province: text(), postalCode: text(),
    country: { ...text(false), defaultValue: 'IT' },
    metadata: json()
}, { sequelize, modelName: 'billingParty', tableName: 'billing_parties', indexes: [
    { name: 'billing_parties_patient_idx', fields: ['patientId'] },
    { name: 'billing_parties_tax_code_idx', fields: ['taxCode'] }
] });

export class PriceList extends Model {}
PriceList.init({
    id,
    name: text(false),
    code: { ...text(false), unique: true },
    audience: { ...text(false), defaultValue: 'PRIVATE' },
    payerName: text(),
    description: { type: DataTypes.TEXT, allowNull: true },
    priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
}, { sequelize, modelName: 'priceList', tableName: 'price_lists' });

export class PriceListVersion extends Model {}
PriceListVersion.init({
    id,
    priceListId: uuid(false),
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    validFrom: date(false),
    validTo: date(),
    status: { ...text(false), defaultValue: 'DRAFT' },
    notes: { type: DataTypes.TEXT, allowNull: true }
}, { sequelize, modelName: 'priceListVersion', tableName: 'price_list_versions', indexes: [
    { unique: true, name: 'price_list_versions_unique', fields: ['priceListId', 'version'] }
] });

export class PriceListItem extends Model {}
PriceListItem.init({
    id,
    priceListVersionId: uuid(false),
    itemType: { ...text(false), defaultValue: 'SERVICE' },
    itemId: uuid(false),
    description: text(),
    unitPrice: money(false),
    vatRate: money(true),
    vatNature: text(),
    structureId: uuid(),
    minQuantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    metadata: json()
}, { sequelize, modelName: 'priceListItem', tableName: 'price_list_items', indexes: [
    { unique: true, name: 'price_list_item_context_unique', fields: ['priceListVersionId', 'itemType', 'itemId', 'structureId'] }
] });

export class Quote extends Model {}
Quote.init({
    id,
    number: { type: DataTypes.INTEGER, allowNull: false },
    year: { type: DataTypes.INTEGER, allowNull: false },
    structureId: uuid(false),
    patientId: uuid(),
    billingPartyId: uuid(),
    priceListId: uuid(),
    priceListVersionId: uuid(),
    priceListName: text(),
    priceListOrigin: text(),
    status: { ...text(false), defaultValue: 'DRAFT' },
    issuedAt: date(false),
    expiresAt: date(),
    currency: { ...text(false), defaultValue: 'EUR' },
    subtotal: money(false, 0),
    taxTotal: money(false, 0),
    total: money(false, 0),
    lines: json([]),
    notes: { type: DataTypes.TEXT, allowNull: true },
    acceptedAt: { type: DataTypes.DATE, allowNull: true },
    rejectedAt: { type: DataTypes.DATE, allowNull: true },
    createdByUserId: uuid()
}, { sequelize, modelName: 'quote', tableName: 'quotes', indexes: [
    { unique: true, name: 'quotes_number_unique', fields: ['year', 'number'] },
    { name: 'quotes_patient_idx', fields: ['patientId'] }
] });

export class CarePackage extends Model {}
CarePackage.init({
    id,
    structureId: uuid(false),
    patientId: uuid(false),
    quoteId: uuid(),
    name: text(false),
    status: { ...text(false), defaultValue: 'ACTIVE' },
    purchasedUnits: money(false, 0),
    remainingUnits: money(false, 0),
    totalPrice: money(false, 0),
    expiresAt: date(),
    lines: json([]),
    notes: { type: DataTypes.TEXT, allowNull: true }
}, { sequelize, modelName: 'carePackage', tableName: 'care_packages', indexes: [
    { name: 'care_packages_patient_status_idx', fields: ['patientId', 'status'] }
] });

export class PackageConsumption extends Model {}
PackageConsumption.init({
    id,
    packageId: uuid(false),
    agendaEventId: uuid(),
    units: money(false, 1),
    consumedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    status: { ...text(false), defaultValue: 'POSTED' },
    note: { type: DataTypes.TEXT, allowNull: true },
    createdByUserId: uuid()
}, { sequelize, modelName: 'packageConsumption', tableName: 'package_consumptions', indexes: [
    { name: 'package_consumptions_package_idx', fields: ['packageId', 'status'] }
] });

export class PatientCredit extends Model {}
PatientCredit.init({
    id,
    structureId: uuid(false),
    patientId: uuid(false),
    amount: money(false),
    remainingAmount: money(false),
    status: { ...text(false), defaultValue: 'ACTIVE' },
    sourceType: text(), sourceId: uuid(),
    expiresAt: date(),
    note: { type: DataTypes.TEXT, allowNull: true }
}, { sequelize, modelName: 'patientCredit', tableName: 'patient_credits', indexes: [
    { name: 'patient_credits_patient_status_idx', fields: ['patientId', 'status'] }
] });

export class PaymentMethod extends Model {}
PaymentMethod.init({
    id,
    code: { ...text(false), unique: true },
    label: text(false),
    type: { ...text(false), defaultValue: 'OTHER' },
    isTraceable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
}, { sequelize, modelName: 'paymentMethod', tableName: 'payment_methods' });

export class FinancialAccount extends Model {}
FinancialAccount.init({
    id,
    structureId: uuid(),
    name: text(false),
    type: { ...text(false), defaultValue: 'CASH' },
    currency: { ...text(false), defaultValue: 'EUR' },
    openingBalance: money(false, 0),
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    metadata: json()
}, { sequelize, modelName: 'financialAccount', tableName: 'financial_accounts' });

/** Movimento di prima nota append-only. Le correzioni producono uno storno. */
export class TreasuryMovement extends Model {}
TreasuryMovement.init({
    id,
    accountId: uuid(false),
    structureId: uuid(false),
    direction: text(false),
    category: text(false),
    amount: money(false),
    occurredAt: { type: DataTypes.DATE, allowNull: false },
    status: { ...text(false), defaultValue: 'POSTED' },
    paymentMethodId: uuid(),
    counterparty: text(),
    description: { type: DataTypes.TEXT, allowNull: true },
    invoiceId: uuid(), expenseId: uuid(),
    sourceType: text(), sourceId: uuid(),
    idempotencyKey: { ...text(), unique: true },
    createdByUserId: uuid(),
    reversalOfId: uuid(),
    voidReason: { type: DataTypes.TEXT, allowNull: true }
}, { sequelize, modelName: 'treasuryMovement', tableName: 'treasury_movements', indexes: [
    { name: 'treasury_movements_account_date_idx', fields: ['accountId', 'occurredAt'] },
    { unique: true, name: 'treasury_movements_source_unique', fields: ['sourceType', 'sourceId'] }
] });

export class PaymentAllocation extends Model {}
PaymentAllocation.init({
    id,
    movementId: uuid(false),
    invoiceId: uuid(false),
    amount: money(false)
}, { sequelize, modelName: 'paymentAllocation', tableName: 'payment_allocations', indexes: [
    { unique: true, name: 'payment_allocations_unique', fields: ['movementId', 'invoiceId'] }
] });

export class DailyClosing extends Model {}
DailyClosing.init({
    id,
    accountId: uuid(false),
    structureId: uuid(false),
    closedOn: date(false),
    openingBalance: money(false, 0),
    expectedBalance: money(false, 0),
    countedBalance: money(false, 0),
    difference: money(false, 0),
    status: { ...text(false), defaultValue: 'CLOSED' },
    notes: { type: DataTypes.TEXT, allowNull: true },
    closedByUserId: uuid()
}, { sequelize, modelName: 'dailyClosing', tableName: 'daily_closings', indexes: [
    { unique: true, name: 'daily_closing_unique', fields: ['accountId', 'closedOn'] }
] });

export class Reconciliation extends Model {}
Reconciliation.init({
    id,
    accountId: uuid(false),
    periodStart: date(false), periodEnd: date(false),
    statementBalance: money(false, 0), bookBalance: money(false, 0), difference: money(false, 0),
    status: { ...text(false), defaultValue: 'OPEN' },
    matchedMovementIds: json([]),
    notes: { type: DataTypes.TEXT, allowNull: true },
    completedAt: { type: DataTypes.DATE, allowNull: true },
    completedByUserId: uuid()
}, { sequelize, modelName: 'reconciliation', tableName: 'reconciliations' });

export class Supplier extends Model {}
Supplier.init({
    id,
    businessName: text(false),
    taxCode: text(), vatNumber: text(),
    email: text(), pec: text(), sdiCode: text(), phone: text(),
    address: text(), city: text(), province: text(), postalCode: text(),
    iban: text(), notes: { type: DataTypes.TEXT, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
}, { sequelize, modelName: 'supplier', tableName: 'suppliers' });

export class PurchaseDocument extends Model {}
PurchaseDocument.init({
    id,
    structureId: uuid(false), supplierId: uuid(),
    type: { ...text(false), defaultValue: 'INVOICE' },
    number: text(), documentDate: date(false), dueDate: date(),
    status: { ...text(false), defaultValue: 'OPEN' },
    subtotal: money(false, 0), taxTotal: money(false, 0), total: money(false, 0),
    lines: json([]), attachment: json(), notes: { type: DataTypes.TEXT, allowNull: true }
}, { sequelize, modelName: 'purchaseDocument', tableName: 'purchase_documents', indexes: [
    { name: 'purchase_documents_supplier_date_idx', fields: ['supplierId', 'documentDate'] }
] });

export class Expense extends Model {}
Expense.init({
    id,
    structureId: uuid(false), supplierId: uuid(), purchaseDocumentId: uuid(),
    category: text(false), description: { type: DataTypes.TEXT, allowNull: true },
    amount: money(false), taxAmount: money(false, 0), incurredAt: date(false), dueDate: date(), paidAt: date(),
    status: { ...text(false), defaultValue: 'OPEN' },
    paymentMethodId: uuid(), accountId: uuid(),
    isDeductible: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    attachment: json(), createdByUserId: uuid()
}, { sequelize, modelName: 'expense', tableName: 'expenses', indexes: [
    { name: 'expenses_structure_date_idx', fields: ['structureId', 'incurredAt'] }
] });

/** Outbox provider-neutral per Sistema TS / SDI. */
export class FiscalSubmission extends Model {}
FiscalSubmission.init({
    id,
    channel: text(false),
    documentType: text(false), documentId: uuid(false),
    status: { ...text(false), defaultValue: 'QUEUED' },
    provider: { ...text(false), defaultValue: 'MOCK' },
    idempotencyKey: { ...text(false), unique: true },
    payloadSnapshot: json(),
    externalId: text(), protocolNumber: text(),
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lastError: { type: DataTypes.TEXT, allowNull: true },
    submittedAt: { type: DataTypes.DATE, allowNull: true },
    completedAt: { type: DataTypes.DATE, allowNull: true },
    createdByUserId: uuid()
}, { sequelize, modelName: 'fiscalSubmission', tableName: 'fiscal_submissions', indexes: [
    { name: 'fiscal_submissions_document_idx', fields: ['documentType', 'documentId'] },
    { name: 'fiscal_submissions_status_idx', fields: ['status'] }
] });

export const ADMINISTRATION_MODELS = [
    BillingParty, PriceList, PriceListVersion, PriceListItem, Quote, CarePackage,
    PackageConsumption, PatientCredit, PaymentMethod, FinancialAccount, TreasuryMovement,
    PaymentAllocation, DailyClosing, Reconciliation, Supplier, PurchaseDocument, Expense,
    FiscalSubmission, QuoteDelivery
];
