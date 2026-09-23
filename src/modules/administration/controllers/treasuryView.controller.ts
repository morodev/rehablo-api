import { Request } from 'express';
import { literal, Model, ModelStatic, Op } from 'sequelize';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { getGrantedPermissions, getSelectedStructureId, getUserId, patientScopeWhere, scopeWhere } from '../../../middleware/rbac.js';
import { resolveGrantedScope } from '../../auth/rbac/permissions.js';
import { Structure } from '../../auth/models/index.js';
import { Invoice, InvoicePayment } from '../../invoice/models/index.js';
import { AgendaEvent } from '../../agenda/models/agendaEvent.model.js';
import Patient from '../../patients/models/patient.model.js';
import { Expense, FinancialAccount, PaymentMethod, PurchaseDocument, Reconciliation, Supplier, TreasuryMovement } from '../models/index.js';
import { AdministrationQueryError, parseAdministrationUuid, resolveAdministrationDateRange, resolveAdministrationStructure } from '../services/administrationQuery.service.js';
import { balanceEffectiveMovements } from '../services/treasuryLedger.service.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';

type Plain = Record<PropertyKey, any>;
const plain = (row: Model): Plain => row.get({ plain: true });
const money = (value: number): number => Math.round(value * 100) / 100;
const CATEGORY_LABELS: Record<string, string> = {
    COLLECTION: 'Incasso', INVOICE_PAYMENT: 'Incasso fattura', PAYMENT_VOID: 'Storno incasso',
    INVOICE_PAYMENT_VOID: 'Storno incasso fattura', SUPPLIER_PAYMENT: 'Pagamento fornitore',
    REFUND: 'Rimborso', REVERSAL: 'Storno', OTHER: 'Altro'
};
const UUID_IN_TEXT = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;

function textQuery(value: unknown, label: string, maxLength = 200): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || value.length > maxLength) throw new AdministrationQueryError(label + ' non valido');
    return value.trim() || undefined;
}
function enumQuery(value: unknown, label: string, options: string[]): string | undefined {
    const text = textQuery(value, label);
    if (text && !options.includes(text)) throw new AdministrationQueryError(label + ' non valido');
    return text;
}
function integerQuery(value: unknown, label: string, fallback: number, minimum: number): number {
    if (value === undefined || value === '') return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) {
        throw new AdministrationQueryError(label + ' non valido');
    }
    return Number(value);
}
export function treasuryFilters(req: Request) {
    // Reject compound query values before passing them to Sequelize.
    for (const field of ['accountId', 'paymentMethodId', 'structureId', 'from', 'to']) {
        textQuery(req.query[field], field);
    }
    const period = resolveAdministrationDateRange(req.query.from, req.query.to);
    return {
        accountId: parseAdministrationUuid(req.query.accountId, 'Conto'),
        paymentMethodId: parseAdministrationUuid(req.query.paymentMethodId, 'Metodo di pagamento'),
        selection: resolveAdministrationStructure(req.access, req.query.structureId),
        period, direction: enumQuery(req.query.direction, 'Tipo di movimento', ['IN', 'OUT']),
        status: enumQuery(req.query.status, 'Stato', ['POSTED', 'VOID']),
        linkState: enumQuery(req.query.linkState, 'Collegamento', ['linked', 'unlinked']),
        category: textQuery(req.query.category, 'Categoria', 100),
        query: textQuery(req.query.query, 'Ricerca')?.toLocaleLowerCase('it'),
        limit: Math.min(integerQuery(req.query.limit, 'Dimensione pagina', 50, 1), 200),
        offset: integerQuery(req.query.offset, 'Pagina', 0, 0)
    };
}
function movementScope(req: Request, filters: ReturnType<typeof treasuryFilters>): Plain {
    const selection = filters.selection;
    if (selection.kind === 'all') return {};
    if (selection.kind === 'none') return { [Op.and]: literal('1=0') };
    return { structureId: selection.structureId };
}
function relatedRequest(req: Request, resource: 'invoice' | 'expense' | 'agenda' | 'patient'): Request | null {
    const scope = req.user?.isSuperAdmin ? 'tenant' : resolveGrantedScope(getGrantedPermissions(req), resource, 'read');
    if (!scope) return null;
    // The linked document has its own permission scope; treasury permission alone does not expose it.
    const related = Object.create(req) as Request;
    related.access = { resource, action: 'read', scope, userId: getUserId(req), structureId: getSelectedStructureId(req) };
    return related;
}
async function entities(model: ModelStatic<Model>, schema: string, ids: unknown[], extra: Plain = {}, attributes?: string[]): Promise<Map<string, Plain>> {
    const unique = [...new Set(ids.filter(Boolean).map(String))];
    if (!unique.length) return new Map();
    const rows = await model.schema(schema).findAll({ where: { [Op.and]: [{ id: { [Op.in]: unique } }, extra] }, ...(attributes ? { attributes } : {}) });
    return new Map(rows.map(row => [String(row.get('id')), plain(row)]));
}
function invoiceLabel(invoice: Plain): string {
    const type = invoice.documentType === 'nota_di_credito' ? 'Nota di credito'
        : invoice.documentType === 'ricevuta_fiscale' ? 'Ricevuta fiscale' : 'Fattura';
    const number = invoice.documentNumber == null ? '' : String(invoice.documentNumber);
    return number ? type + ' ' + number + (invoice.documentYear ? '/' + invoice.documentYear : '') : type + ' senza numero';
}
function readableDescription(row: Plain, documentLabel: string | null, documentAccessible: boolean): string | null {
    const raw = String(row.description ?? '').trim();
    if (['INVOICE_PAYMENT', 'INVOICE_PAYMENT_VOID', 'PAYMENT_VOID'].includes(String(row.sourceType))
        || ['INVOICE_PAYMENT', 'INVOICE_PAYMENT_VOID', 'PAYMENT_VOID'].includes(String(row.category))) {
        // Older generated notes contained the UUID. Keep user-authored notes but remove opaque identifiers.
        if (raw && !UUID_IN_TEXT.test(raw)) { UUID_IN_TEXT.lastIndex = 0; return raw; }
        UUID_IN_TEXT.lastIndex = 0;
        const action = row.reversalOfId || row.category !== 'INVOICE_PAYMENT' ? 'Storno incasso' : 'Incasso';
        return documentAccessible && documentLabel ? action + ' · ' + documentLabel : action + (row.invoiceId ? ' fattura' : ' registrato');
    }
    UUID_IN_TEXT.lastIndex = 0;
    return raw ? raw.replace(UUID_IN_TEXT, 'documento collegato') : null;
}

/** Readable, scoped first-notice records; filtering and totals apply before pagination. */
export const listTreasuryMovements = asyncHandler(async (req, res) => {
    const filters = treasuryFilters(req);
    const schema = req.tenantSchema!;
    const scope = movementScope(req, filters);
    if (req.access?.scope === 'tenant' && filters.selection.kind === 'structure') {
        const count = await Structure.count({ where: { id: filters.selection.structureId, tenantId: getCurrentTenantId(req) } });
        if (!count) throw new AdministrationQueryError('Sede non valida');
    }
    // A legacy VOID original can still affect the balance when a later posted reversal compensates it.
    // Resolve that relationship before period/status filters, including reversals outside the requested dates.
    const where: Plain = { ...scope, ...(filters.accountId ? { accountId: filters.accountId } : {}) };
    const ledger = (await TreasuryMovement.schema(schema).findAll({ where, order: [['occurredAt', 'DESC'], ['id', 'DESC']] })).map(plain);
    const effectiveIds = new Set(balanceEffectiveMovements(ledger).map(row => String(row.id)));
    const { fromInstant, toInstant } = filters.period;
    const rows = ledger.filter(row => {
        for (const field of ['paymentMethodId', 'direction', 'status', 'category'] as const) {
            if (filters[field] && row[field] !== filters[field]) return false;
        }
        const instant = new Date(row.occurredAt).getTime();
        if (fromInstant && instant < fromInstant.getTime() || toInstant && instant > toInstant.getTime()) return false;
        if (filters.linkState === 'linked' && !row.invoiceId && !row.expenseId) return false;
        if (filters.linkState === 'unlinked' && (row.invoiceId || row.expenseId)) return false;
        return true;
    });
    const invoiceReq = relatedRequest(req, 'invoice');
    const expenseReq = relatedRequest(req, 'expense');
    const invoiceScope = invoiceReq ? { [Op.and]: [
        scope,
        patientScopeWhere(invoiceReq, schema, 'patientID'),
        invoiceReq.access?.scope === 'structure' ? scopeWhere(invoiceReq, { structureField: 'structureId' }) : {}
    ] } : {};
    const expenseScope = expenseReq ? { [Op.and]: [
        scope, scopeWhere(expenseReq, { structureField: 'structureId', ownerField: 'createdByUserId' })
    ] } : {};
    const accountIds = rows.map(row => row.accountId);
    const structureIds = [...new Set(rows.map(row => row.structureId).filter(Boolean))];
    const [accounts, methods, invoices, expenses, structures, reconciliations] = await Promise.all([
        entities(FinancialAccount, schema, accountIds, {}, ['id', 'name']),
        entities(PaymentMethod, schema, rows.map(row => row.paymentMethodId), {}, ['id', 'label']),
        invoiceReq ? entities(Invoice, schema, rows.map(row => row.invoiceId), invoiceScope,
            ['id', 'documentNumber', 'documentYear', 'documentType', 'patientID']) : Promise.resolve(new Map<string, Plain>()),
        expenseReq ? entities(Expense, schema, rows.map(row => row.expenseId), expenseScope,
            ['id', 'description', 'supplierId', 'purchaseDocumentId', 'structureId']) : Promise.resolve(new Map<string, Plain>()),
        structureIds.length ? Structure.findAll({ where: { id: { [Op.in]: structureIds }, tenantId: getCurrentTenantId(req) }, attributes: ['id', 'name'] }) : Promise.resolve([]),
        accountIds.length ? Reconciliation.schema(schema).findAll({
            where: { accountId: { [Op.in]: [...new Set(accountIds)] }, status: { [Op.in]: ['COMPLETED', 'CLOSED'] } },
            attributes: ['matchedMovementIds']
        }) : Promise.resolve([])
    ]);
    const [patients, suppliers, purchases] = await Promise.all([
        invoiceReq ? entities(Patient, schema, [...invoices.values()].map(row => row.patientID),
            patientScopeWhere(invoiceReq, schema, 'id'), ['id', 'name', 'surname']) : Promise.resolve(new Map<string, Plain>()),
        entities(Supplier, schema, [...expenses.values()].map(row => row.supplierId), {}, ['id', 'businessName']),
        entities(PurchaseDocument, schema, [...expenses.values()].map(row => row.purchaseDocumentId), expenseReq?.access?.scope === 'own' ? { [Op.and]: literal('1=0') } : expenseScope,
            ['id', 'number', 'documentDate'])
    ]);
    // Pre-invoice appointment receipts have a payment source but no fiscal document.
    // Resolve only the minimal display data, under the agenda and patient permissions.
    const agendaReq = relatedRequest(req, 'agenda');
    const patientReq = relatedRequest(req, 'patient');
    const appointmentPayments = agendaReq ? await entities(InvoicePayment, schema,
        rows.filter(row => !row.invoiceId && ['INVOICE_PAYMENT', 'INVOICE_PAYMENT_VOID'].includes(String(row.sourceType)))
            .map(row => row.sourceId), {}, ['id', 'agendaEventId']) : new Map<string, Plain>();
    const appointments = agendaReq ? await entities(AgendaEvent, schema,
        [...appointmentPayments.values()].map(row => row.agendaEventId),
        { [Op.and]: [scope, scopeWhere(agendaReq, { ownerField: 'calendarId', structureField: 'structureId' })] },
        ['id', 'start', 'patientId']) : new Map<string, Plain>();
    const appointmentPatients = patientReq ? await entities(Patient, schema,
        [...appointments.values()].map(row => row.patientId),
        patientScopeWhere(patientReq, schema, 'id'), ['id', 'name', 'surname']) : new Map<string, Plain>();
    const structureNames = new Map(structures.map(row => [String(row.get('id')), row.get('name')]));
    const matched = new Set<string>();
    reconciliations.forEach(row => ((row.get('matchedMovementIds') ?? []) as unknown[]).forEach(id => matched.add(String(id))));
    const enriched = rows.map((row): Plain => {
        const invoice = invoices.get(String(row.invoiceId));
        const expense = expenses.get(String(row.expenseId));
        const patient = patients.get(String(invoice?.patientID));
        const appointment = appointments.get(String(appointmentPayments.get(String(row.sourceId))?.agendaEventId));
        const appointmentPatient = appointmentPatients.get(String(appointment?.patientId));
        const supplier = suppliers.get(String(expense?.supplierId));
        const purchase = purchases.get(String(expense?.purchaseDocumentId));
        const hasDocument = Boolean(row.invoiceId || row.expenseId);
        const documentAccessible = Boolean(invoice || expense);
        const documentLabel = invoice ? invoiceLabel(invoice)
            : expense ? (purchase?.number ? 'Spesa · documento ' + purchase.number
                : expense.description ? 'Spesa · ' + expense.description : 'Spesa registrata')
                : hasDocument ? 'Documento non disponibile' : null;
        const fallbackCounterparty = invoice ? [patient?.name, patient?.surname].filter(Boolean).join(' ')
            : supplier?.businessName || [appointmentPatient?.name, appointmentPatient?.surname].filter(Boolean).join(' ');
        return {
            ...row,
            categoryLabel: appointment ? (row.reversalOfId ? 'Storno incasso seduta' : 'Incasso seduta')
                : CATEGORY_LABELS[String(row.category)] ?? String(row.category),
            accountName: accounts.get(String(row.accountId))?.name ?? null,
            paymentMethodName: methods.get(String(row.paymentMethodId))?.label ?? null,
            structureName: structureNames.get(String(row.structureId)) ?? null,
            counterparty: String(row.counterparty ?? '').trim() || fallbackCounterparty || null,
            description: appointment
                ? (row.reversalOfId ? 'Storno incasso seduta' : 'Incasso seduta')
                    + (appointment.start && Number.isFinite(Date.parse(appointment.start))
                        ? ' del ' + new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome' }).format(new Date(appointment.start)) : '')
                    + (row.description && !/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i.test(String(row.description))
                        ? ' · ' + row.description : '')
                : readableDescription(row, documentLabel, documentAccessible),
            documentType: row.invoiceId ? 'INVOICE' : row.expenseId ? 'EXPENSE' : null,
            documentId: documentAccessible ? String(invoice?.id ?? expense?.id) : null,
            documentLabel, documentAccessible, hasDocument, affectsBalance: effectiveIds.has(String(row.id)),
            reconciled: matched.has(String(row.id))
        };
    }).filter(row => !filters.query || [
        row.description, row.counterparty, row.documentLabel, row.accountName, row.paymentMethodName,
        row.structureName, row.categoryLabel
    ].some(value => String(value ?? '').toLocaleLowerCase('it').includes(filters.query!)));
    const posted = enriched.filter(row => row.affectsBalance);
    const income = posted.filter(row => row.direction === 'IN').reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0) / 100;
    const outcome = posted.filter(row => row.direction === 'OUT').reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0) / 100;
    return sendSuccessResponse(res, 200, {
        items: enriched.slice(filters.offset, filters.offset + filters.limit), total: enriched.length,
        limit: filters.limit, offset: filters.offset,
        summary: { income, outcome, net: money(income - outcome), postedCount: enriched.filter(row => row.status === 'POSTED').length,
            unlinkedCount: enriched.filter(row => !row.hasDocument).length }
    });
});

/** Direct lookup for a treasury link, independent of the expense list pagination. */
export const getTreasuryExpense = asyncHandler(async (req, res) => {
    const id = parseAdministrationUuid(req.params.id, 'Spesa');
    if (!id) throw new AdministrationQueryError('Spesa non valida');
    const schema = req.tenantSchema!;
    const rows = await entities(Expense, schema, [id],
        scopeWhere(req, { structureField: 'structureId', ownerField: 'createdByUserId' }));
    const expense = rows.get(id);
    if (!expense) return sendErrorResponse(res, 404, 'Spesa non disponibile');
    const [suppliers, methods] = await Promise.all([
        entities(Supplier, schema, [expense.supplierId], {}, ['id', 'businessName']),
        entities(PaymentMethod, schema, [expense.paymentMethodId], {}, ['id', 'label'])
    ]);
    return sendSuccessResponse(res, 200, { ...expense,
        supplierName: suppliers.get(String(expense.supplierId))?.businessName ?? null,
        paymentMethodName: methods.get(String(expense.paymentMethodId))?.label ?? null
    });
});
