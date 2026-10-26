import {randomUUID} from 'node:crypto';
import {Request} from 'express';
import {Op, QueryTypes, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {getGrantedPermissions, getSelectedStructureId, getUserId} from '../../../middleware/rbac.js';
import {resolveGrantedScope, Resource} from '../../auth/rbac/permissions.js';
import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendSuccessResponse} from '../../../utils/response.js';
import {Expense, FinancialAccount, PatientCredit, PurchaseDocument, TreasuryMovement} from '../models/index.js';
import {PatientCreditMovement} from '../models/patientCreditMovement.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import {PatientSettlementOperation} from '../../patients/models/patientSettlementOperation.model.js';
import {parseAdministrationUuid, resolveAdministrationDateRange, resolveAdministrationStructure} from '../services/administrationQuery.service.js';
import {treasuryError} from '../services/treasuryValidation.service.js';
import {financialDate} from '../services/financialMovementPolicy.service.js';
import {analyzeTreasuryIntegrity, integrityDate, TreasuryIntegrityIssue} from '../services/treasuryIntegrity.policy.js';

type Row = Record<string, any>;
const plain = (row: {get(options: any): any}) => row.get({plain: true}) as Row;
function selection(req: Request) {
    const selected = resolveAdministrationStructure(req.access, req.query.structureId ?? req.body?.structureId);
    if (selected.kind === 'none') treasuryError('Seleziona una sede accessibile', 403);
    return selected.kind === 'structure' ? selected.structureId : null;
}
async function loadIntegrity(req: Request, transaction?: Transaction) {
    const schema = req.tenantSchema!;
    if (!/^rehablo_[a-f0-9]{32}$/i.test(schema)) treasuryError('Contesto studio non valido');
    const structureId = selection(req);
    const prefix = `"${schema}"`;
    const payments = await sequelize.query<Row>(`SELECT p."id",p."invoiceId",p."agendaEventId",p."carePackageId",
        p."source",p."status",p."amount",p."paidAt",p."voidedAt",p."voidedByUserId",
        COALESCE(a."structureId",c."structureId",i."structureId") AS "structureId"
        FROM ${prefix}."invoice_payments" p
        LEFT JOIN ${prefix}."invoices" i ON i."id"=p."invoiceId"
        LEFT JOIN ${prefix}."agenda_events" a ON a."id"=p."agendaEventId"
        LEFT JOIN ${prefix}."care_packages" c ON c."id"=p."carePackageId"
        WHERE CAST(:structureId AS uuid) IS NULL OR COALESCE(a."structureId",c."structureId",i."structureId")=CAST(:structureId AS uuid)
        ORDER BY p."id"`, {type: QueryTypes.SELECT, replacements: {structureId}, transaction});
    const [movements, accounts, expenses, credits, documents, settlements] = await Promise.all([
        TreasuryMovement.schema(schema).findAll({where: structureId ? {structureId} : {}, transaction,
            order: [['id', 'ASC']], attributes: ['id', 'accountId', 'structureId', 'direction', 'amount', 'occurredAt',
                'status', 'paymentMethodId', 'invoiceId', 'expenseId', 'sourceType', 'sourceId', 'reversalOfId', 'idempotencyKey']}),
        FinancialAccount.schema(schema).findAll({attributes: ['id'], transaction}),
        Expense.schema(schema).findAll({where: structureId ? {structureId} : {},
            attributes: ['id', 'structureId', 'amount', 'status', 'paidAt', 'purchaseDocumentId'], order: [['id', 'ASC']], transaction}),
        PatientCredit.schema(schema).findAll({where: structureId ? {structureId} : {},
            attributes: ['id', 'structureId', 'amount', 'sourceId', 'sourceType', 'status'], order: [['id', 'ASC']], transaction}),
        PurchaseDocument.schema(schema).findAll({where: {...(structureId ? {structureId} : {}), status: {[Op.in]: ['PAID', 'PARTIAL']}},
            attributes: ['id', 'structureId', 'total', 'status'], order: [['id', 'ASC']], transaction}),
        PatientSettlementOperation.schema(schema).findAll({where: structureId ? {structureId} : {},
            attributes: ['id', 'structureId', 'result'], order: [['id', 'ASC']], transaction}),
    ]);
    const creditRows = credits.map(plain);
    const creditSites = new Map(creditRows.map(row => [row.id, row.structureId]));
    const creditEntries = creditRows.length ? await PatientCreditMovement.schema(schema).findAll({where: {creditId: {[Op.in]: creditRows.map(row => row.id)},
        type: {[Op.in]: ['REFUND', 'REVERSE_REFUND', 'VOID_ADVANCE']}}, order: [['id', 'ASC']], transaction}) : [];
    return analyzeTreasuryIntegrity(payments, movements.map(plain), accounts.map(row => String(row.get('id'))), expenses.map(plain),
        creditRows, creditEntries.map(row => ({...plain(row), structureId: creditSites.get(row.get('creditId'))})), documents.map(plain), settlements.map(plain));
}
function allowedLink(req: Request, resource: Resource, structureId: string) {
    const scope = req.user?.isSuperAdmin ? 'tenant' : resolveGrantedScope(getGrantedPermissions(req), resource, 'read');
    return scope === 'tenant' || (scope === 'structure' && structureId === getSelectedStructureId(req));
}
function publicIssue(req: Request, issue: TreasuryIntegrityIssue) {
    return {...issue, invoiceId: allowedLink(req, 'invoice', issue.structureId) ? issue.invoiceId : null,
        agendaEventId: allowedLink(req, 'agenda', issue.structureId) ? issue.agendaEventId : null,
        carePackageId: allowedLink(req, 'care_package', issue.structureId) ? issue.carePackageId : null,
        expenseId: allowedLink(req, 'expense', issue.structureId) ? issue.expenseId : undefined};
}
export const getTreasuryIntegrity = asyncHandler(async (req, res) => {
    const result = await loadIntegrity(req);
    return sendSuccessResponse(res, 200, {...result, issues: result.issues.map(issue => publicIssue(req, issue)), checkedAt: new Date().toISOString()});
});

/** Explicit reconciliation only: never called by a GET, bootstrap, or ordinary clinical edit. */
export const repairTreasuryIntegrity = asyncHandler(async (req, res) => {
    const key = req.header('Idempotency-Key')?.trim();
    if (!key || !/^[a-zA-Z0-9_-]{8,128}$/.test(key)) treasuryError('Identificativo della registrazione mancante o non valido', 422);
    const issueId = typeof req.body?.issueId === 'string' ? req.body.issueId : '';
    const version = typeof req.body?.evidenceVersion === 'string' ? req.body.evidenceVersion : '';
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1000) : '';
    if (!reason || !issueId || !version) treasuryError('Indica l’anomalia e il motivo della registrazione', 422);
    const result = await sequelize.transaction(async transaction => {
        await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', {
            transaction, replacements: {lockKey: req.tenantSchema + ':treasury-integrity:' + issueId}
        });
        const Movement = TreasuryMovement.schema(req.tenantSchema!);
        const existing = await Movement.findOne({where: {idempotencyKey: key}, transaction});
        if (existing) {
            const sameSite = !selection(req) || existing.get('structureId') === selection(req);
            const exact = existing.get('description') === 'Riconciliazione: ' + reason
                && ((issueId === 'MISSING_RECEIPT:' + existing.get('sourceId') && existing.get('sourceType') === 'INVOICE_PAYMENT')
                    || (issueId === 'MISSING_REVERSAL:' + existing.get('sourceId') && existing.get('sourceType') === 'INVOICE_PAYMENT_VOID'));
            if (!sameSite || !exact || (req.body?.accountId && existing.get('accountId') !== req.body.accountId)
                || (req.body?.occurredAt && integrityDate(existing.get('occurredAt')) !== req.body.occurredAt)) treasuryError('Identificativo già utilizzato per una diversa registrazione', 409);
            return {movementId: existing.get('id'), reused: true};
        }
        const found = (await loadIntegrity(req, transaction)).issues.find(issue => issue.id === issueId);
        if (!found || found.evidenceVersion !== version) treasuryError('La situazione è cambiata. Aggiorna il controllo prima di registrare.', 409);
        if (!found.repair || !found.structureId || !found.paymentId) treasuryError('Questa anomalia va corretta dalla registrazione di origine', 409);
        // Serialize against receipt, void and credit commands as well as other reconciliations.
        const payment = await InvoicePayment.schema(req.tenantSchema!).findByPk(found.paymentId, {transaction, lock: transaction.LOCK.UPDATE});
        const fresh = (await loadIntegrity(req, transaction)).issues.find(issue => issue.id === issueId);
        if (!payment || !fresh || fresh.evidenceVersion !== version) treasuryError('L’incasso è cambiato. Aggiorna il controllo.', 409);
        let accountId: string, occurredAt: string, direction: 'IN' | 'OUT', reversalOfId: string | null = null;
        if (found.repair === 'RECEIPT') {
            // A historic account must be explicit, even if the current site has only one/default account.
            accountId = parseAdministrationUuid(req.body?.accountId, 'Conto effettivo') ?? treasuryError('Indica il conto effettivamente usato', 422);
            const account = await FinancialAccount.schema(req.tenantSchema!).findByPk(accountId, {transaction, lock: transaction.LOCK.UPDATE});
            if (!account || (account.get('structureId') && account.get('structureId') !== found.structureId) || account.get('currency') !== 'EUR') {
                treasuryError('Il conto non è disponibile per questa sede e valuta', 422);
            }
            const suppliedDate = typeof req.body?.occurredAt === 'string' ? req.body.occurredAt : null;
            if (found.paidAt && suppliedDate && suppliedDate !== found.paidAt) treasuryError('Usa la data già registrata nell’incasso', 422);
            occurredAt = found.paidAt ?? suppliedDate ?? treasuryError('Indica la data effettiva dell’incasso', 422);
            resolveAdministrationDateRange(occurredAt, occurredAt);
            financialDate(occurredAt);
            if (!found.paidAt) await payment.update({paidAt: new Date(occurredAt + 'T12:00:00.000Z')}, {transaction, completeHistoricalDate: true} as any);
            direction = 'IN';
        } else {
            const original = await Movement.findByPk(found.movementId, {transaction, lock: transaction.LOCK.UPDATE});
            if (!original || !integrityDate(payment.get('voidedAt'))) treasuryError('Mancano i dati originali dello storno', 409);
            accountId = String(original.get('accountId'));
            occurredAt = integrityDate(payment.get('voidedAt'))!;
            financialDate(occurredAt);
            direction = 'OUT';
            reversalOfId = String(original.get('id'));
        }
        const row = await Movement.create({id: randomUUID(), accountId, structureId: found.structureId, direction,
            category: direction === 'IN' ? 'INVOICE_PAYMENT' : 'PAYMENT_VOID', amount: found.amount,
            occurredAt: new Date(occurredAt + 'T12:00:00.000Z'), status: 'POSTED', invoiceId: payment.get('invoiceId'),
            sourceType: direction === 'IN' ? 'INVOICE_PAYMENT' : 'INVOICE_PAYMENT_VOID', sourceId: found.paymentId,
            reversalOfId, description: 'Riconciliazione: ' + reason, idempotencyKey: key, createdByUserId: getUserId(req)}, {transaction});
        return {movementId: row.get('id'), reused: false};
    });
    return sendSuccessResponse(res, result.reused ? 200 : 201, result, 'Prima nota completata');
});
