import {randomUUID} from 'node:crypto';
import {Request} from 'express';
import {Model, Op, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {getGrantedPermissions, getSelectedStructureId, getUserId, scopeWhere} from '../../../middleware/rbac.js';
import {Action, Resource, resolveGrantedScope} from '../../auth/rbac/permissions.js';
import {DailyClosing, Expense, FinancialAccount, PaymentMethod, Reconciliation, TreasuryMovement} from '../models/index.js';
import {balanceEffectiveMovements} from './treasuryLedger.service.js';
import {beginFinancialOperation} from './financialOperation.service.js';
import {lockFinancialAccounts, resolveFinancialAccount} from './financialAccountResolver.service.js';
import {nullableTreasuryUuid, treasuryError, validateManualTreasuryMovement, validateTreasuryMethod} from './treasuryValidation.service.js';
import {cents, financialDate, financialMoney, financialNote, positiveFinancialAmount} from './financialMovementPolicy.service.js';
import {dateOnly} from '../../reports/services/financialFacts.service.js';

type Row = Record<string, any>;
export const financialPlain = (row: Model): Row => row.get({plain: true});
export function assertFinancialAccess(req: Request, resource: Resource, action: Action, structureId: string, ownerId?: unknown): void {
    const scope = req.user?.isSuperAdmin ? 'tenant' : resolveGrantedScope(getGrantedPermissions(req), resource, action);
    if (!scope || (scope !== 'tenant' && structureId !== (getSelectedStructureId(req) ?? req.access?.structureId))
        || (scope === 'own' && ownerId !== getUserId(req))) treasuryError('Non sei autorizzato a questa registrazione', 403);
}
function requiredId(value: unknown, label: string): string {
    const id = nullableTreasuryUuid(value, label);
    if (!id) treasuryError(label + ' obbligatorio', 422);
    return id;
}
async function lockedExpense(req: Request, transaction: Transaction, action: Action = 'create'): Promise<Model> {
    const id = requiredId(req.params.id, 'Spesa');
    const expense = await Expense.schema(req.tenantSchema!).findOne({where: {id}, transaction, lock: transaction.LOCK.UPDATE});
    if (!expense) treasuryError('Spesa non disponibile', 404);
    assertFinancialAccess(req, 'expense', 'update', String(expense.get('structureId')), expense.get('createdByUserId'));
    assertFinancialAccess(req, 'treasury', action, String(expense.get('structureId')), getUserId(req));
    return expense;
}
export function expensePaymentPosition(expense: Row, ledger: Row[]) {
    const linked = ledger.filter(row => row.expenseId === expense.id);
    const payments = linked.filter(row => row.sourceType === 'EXPENSE_PAYMENT');
    const effective = balanceEffectiveMovements(linked);
    const amount = Number(expense.amount);
    const paid = financialMoney(effective.reduce((total, row) => total + (row.direction === 'OUT' ? Number(row.amount) : -Number(row.amount)), 0));
    const unknown = expense.amount == null || expense.amount === '' || !Number.isFinite(amount) || amount < 0
        || !Number.isFinite(paid) || paid < 0 || cents(paid) > cents(amount)
        || linked.some(row => !['EXPENSE_PAYMENT', 'EXPENSE_PAYMENT_VOID'].includes(row.sourceType))
        || payments.some(row => row.direction !== 'OUT' || Number(row.amount) <= 0 || !row.accountId
            || (row.status === 'VOID' && !effective.includes(row)))
        || linked.some(row => row.sourceType === 'EXPENSE_PAYMENT_VOID' && !payments.some(original => original.id === row.reversalOfId
            && original.accountId === row.accountId && row.direction === 'IN' && cents(original.amount) === cents(row.amount)))
        || (!payments.length && (['PAID', 'PARTIAL'].includes(String(expense.status).toUpperCase()) || !!expense.paidAt));
    const paidAmount = unknown ? null : paid, balance = unknown ? null : financialMoney(Math.max(0, Number(expense.amount) - paid));
    return {paidAmount, balance, paymentState: unknown ? 'UNRECONCILED' : balance === 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'OPEN',
        payments: payments.map(row => ({id: row.id, amount: financialMoney(row.amount), paidAt: dateOnly(row.occurredAt),
            accountId: row.accountId, paymentMethodId: row.paymentMethodId ?? null, method: row.paymentMethodName ?? null,
            status: row.status, note: row.description ?? null, voidReason: row.voidReason ?? null}))};
}
export async function decorateExpensePayments(schema: string, expenses: Row[], transaction?: Transaction): Promise<Row[]> {
    if (!expenses.length) return [];
    const ledger = (await TreasuryMovement.schema(schema).findAll({where: {expenseId: {[Op.in]: expenses.map(row => row.id)}},
        order: [['occurredAt', 'DESC'], ['id', 'DESC']], transaction})).map(financialPlain);
    const methodIds = [...new Set(ledger.map(row => row.paymentMethodId).filter(Boolean))];
    if (methodIds.length) {
        const methods = new Map((await PaymentMethod.schema(schema).findAll({where: {id: {[Op.in]: methodIds}}, attributes: ['id', 'label'], transaction})).map(row => [String(row.get('id')), row.get('label')]));
        ledger.forEach(row => {row.paymentMethodName = methods.get(String(row.paymentMethodId)) ?? null;});
    }
    return expenses.map(expense => ({...expense, ...expensePaymentPosition(expense, ledger)}));
}
async function expenseView(req: Request, expense: Model, transaction: Transaction): Promise<Row> {
    return (await decorateExpensePayments(req.tenantSchema!, [financialPlain(expense)], transaction))[0];
}
export async function recordExpensePayment(req: Request): Promise<Row> {
    const body = req.body ?? {}, amount = positiveFinancialAmount(body.amount), occurredAt = financialDate(body.paidAt), note = financialNote(body.note);
    const requestedAccount = nullableTreasuryUuid(body.accountId, 'Conto'), paymentMethodId = nullableTreasuryUuid(body.paymentMethodId, 'Metodo');
    return sequelize.transaction(async transaction => {
        const expense = await lockedExpense(req, transaction), structureId = String(expense.get('structureId'));
        const operation = await beginFinancialOperation(req, 'EXPENSE_PAYMENT', structureId, transaction);
        if (operation.replay) return operation.replay;
        if (['VOID', 'CANCELLED'].includes(String(expense.get('status')).toUpperCase())) treasuryError('La spesa è annullata', 409);
        const view = await expenseView(req, expense, transaction);
        if (view.balance === null) treasuryError('La spesa ha pagamenti precedenti da riconciliare: non registrare una seconda uscita', 409);
        if (cents(amount) > cents(view.balance)) treasuryError('Il pagamento supera il residuo della spesa', 409);
        const accountId = await resolveFinancialAccount(req.tenantSchema!, structureId, requestedAccount, transaction);
        await validateTreasuryMethod(req.tenantSchema!, paymentMethodId, transaction);
        await TreasuryMovement.schema(req.tenantSchema!).create({id: randomUUID(), accountId, structureId,
            direction: 'OUT', category: 'SUPPLIER_PAYMENT', amount, occurredAt, status: 'POSTED', expenseId: expense.get('id'),
            paymentMethodId, description: note ?? String(expense.get('description') ?? 'Pagamento spesa'), sourceType: 'EXPENSE_PAYMENT',
            sourceId: randomUUID(), createdByUserId: getUserId(req)}, {transaction});
        const paid = financialMoney(Number(view.paidAmount) + amount), balance = financialMoney(Number(expense.get('amount')) - paid);
        await expense.update({status: balance <= 0 ? 'PAID' : 'PARTIAL', paidAt: balance <= 0 ? dateOnly(occurredAt) : null}, {transaction});
        const result = await expenseView(req, expense, transaction); await operation.complete(result); return result;
    });
}
export async function voidExpensePayment(req: Request): Promise<Row> {
    const reason = financialNote(req.body?.reason, true), occurredAt = financialDate(req.body?.occurredAt ?? new Date());
    const paymentId = requiredId(req.params.paymentId, 'Pagamento');
    return sequelize.transaction(async transaction => {
        const expense = await lockedExpense(req, transaction, 'update'), structureId = String(expense.get('structureId'));
        const operation = await beginFinancialOperation(req, 'EXPENSE_PAYMENT_VOID', structureId, transaction);
        if (operation.replay) return operation.replay;
        const Movement = TreasuryMovement.schema(req.tenantSchema!);
        const original = await Movement.findOne({where: {id: paymentId, expenseId: expense.get('id'), sourceType: 'EXPENSE_PAYMENT'}, transaction, lock: transaction.LOCK.UPDATE});
        if (!original) treasuryError('Pagamento della spesa non disponibile', 404);
        if (original.get('status') !== 'POSTED') treasuryError('Pagamento già annullato', 409);
        if (dateOnly(occurredAt) < dateOnly(original.get('occurredAt'))) treasuryError('La correzione non può precedere il pagamento', 422);
        await FinancialAccount.schema(req.tenantSchema!).findByPk(String(original.get('accountId')), {transaction, lock: transaction.LOCK.UPDATE});
        await Movement.create({accountId: original.get('accountId'), structureId, amount: original.get('amount'), direction: 'IN',
            category: 'SUPPLIER_PAYMENT_VOID', occurredAt, status: 'POSTED', expenseId: expense.get('id'), paymentMethodId: original.get('paymentMethodId'),
            sourceType: 'EXPENSE_PAYMENT_VOID', sourceId: paymentId, reversalOfId: paymentId, description: reason, voidReason: reason,
            createdByUserId: getUserId(req)}, {transaction});
        await original.update({status: 'VOID', voidReason: reason}, {transaction});
        // Once a genuine movement exists, a former cached PAID status is no longer legacy evidence.
        const result = await expenseView(req, expense, transaction);
        await expense.update({status: result.paymentState, paidAt: result.paymentState === 'PAID' ? expense.get('paidAt') : null}, {transaction});
        const refreshed = await expenseView(req, expense, transaction); await operation.complete(refreshed); return refreshed;
    });
}
export async function recordManualMovement(req: Request, source: Row): Promise<Row> {
    const payload = {...source};
    if (payload.expenseId) treasuryError('Usa Paga spesa per collegare un pagamento alla spesa', 422);
    const structureId = requiredId(payload.structureId, 'Sede');
    assertFinancialAccess(req, 'treasury', 'create', structureId, getUserId(req));
    const occurredAt = financialDate(payload.occurredAt);
    payload.amount = positiveFinancialAmount(payload.amount);
    payload.occurredAt = occurredAt.toISOString();
    return sequelize.transaction(async transaction => {
        const operation = await beginFinancialOperation(req, 'MANUAL_TREASURY', structureId, transaction);
        if (operation.replay) return operation.replay;
        payload.accountId = await resolveFinancialAccount(req.tenantSchema!, structureId, payload.accountId, transaction);
        await validateManualTreasuryMovement(req, payload);
        const key = req.header('Idempotency-Key')!.trim();
        const prior = await TreasuryMovement.schema(req.tenantSchema!).findOne({where: {idempotencyKey: key}, transaction});
        if (prior) {
            const saved = financialPlain(prior);
            if (['accountId', 'structureId', 'direction', 'category', 'paymentMethodId', 'counterparty', 'sourceType'].some(field => (saved[field] ?? null) !== (payload[field] ?? null))
                || cents(saved.amount) !== cents(payload.amount) || new Date(saved.occurredAt).getTime() !== occurredAt.getTime()
                || (saved.description ?? null) !== (payload.description ?? null) || saved.createdByUserId !== getUserId(req) || saved.sourceId || saved.invoiceId || saved.expenseId)
                treasuryError('Identificativo già usato con dati diversi', 409);
            await operation.complete(saved); return saved;
        }
        const movement = await TreasuryMovement.schema(req.tenantSchema!).create({...payload, status: 'POSTED',
            idempotencyKey: key, createdByUserId: getUserId(req)}, {transaction});
        const result = financialPlain(movement); await operation.complete(result); return result;
    });
}
export async function voidManualMovement(req: Request, source: Row): Promise<Row> {
    const id = requiredId(req.params.id, 'Movimento'), reason = financialNote(source.reason, true), occurredAt = financialDate(source.occurredAt ?? new Date());
    return sequelize.transaction(async transaction => {
        const Movement = TreasuryMovement.schema(req.tenantSchema!);
        const original = await Movement.findByPk(id, {transaction, lock: transaction.LOCK.UPDATE});
        if (!original) treasuryError('Movimento non disponibile', 404);
        const structureId = String(original.get('structureId'));
        assertFinancialAccess(req, 'treasury', 'update', structureId, original.get('createdByUserId'));
        const operation = await beginFinancialOperation(req, 'MANUAL_TREASURY_VOID', structureId, transaction);
        if (operation.replay) return operation.replay;
        if (original.get('invoiceId') || original.get('expenseId') || original.get('sourceId') || original.get('reversalOfId')
            || (original.get('sourceType') && original.get('sourceType') !== 'MANUAL')) treasuryError('Correggi il pagamento dalla sua origine', 409);
        if (original.get('status') !== 'POSTED' || await Movement.count({where: {reversalOfId: id, status: 'POSTED'}, transaction})) treasuryError('Movimento gia annullato', 409);
        if (dateOnly(occurredAt) < dateOnly(original.get('occurredAt'))) treasuryError('Lo storno non puo precedere il movimento', 422);
        await FinancialAccount.schema(req.tenantSchema!).findByPk(String(original.get('accountId')), {transaction, lock: transaction.LOCK.UPDATE});
        const movement = await Movement.create({accountId: original.get('accountId'), structureId,
            amount: original.get('amount'), direction: original.get('direction') === 'IN' ? 'OUT' : 'IN',
            category: 'REVERSAL', occurredAt, status: 'POSTED', paymentMethodId: original.get('paymentMethodId'),
            counterparty: original.get('counterparty'), description: reason, reversalOfId: id, voidReason: reason, createdByUserId: getUserId(req)}, {transaction});
        await original.update({status: 'VOID', voidReason: reason}, {transaction});
        const result = financialPlain(movement); await operation.complete(result); return result;
    });
}
function transferView(out: Row, incoming: Row): Row {
    return {id: out.sourceId, fromAccountId: out.accountId, toAccountId: incoming.accountId, amount: financialMoney(out.amount),
        occurredAt: out.occurredAt, note: out.description ?? null, status: out.status,
        outMovementId: out.id, inMovementId: incoming.id};
}
export async function recordTransfer(req: Request): Promise<Row> {
    const body = req.body ?? {}, fromAccountId = requiredId(body.fromAccountId, 'Conto di origine'), toAccountId = requiredId(body.toAccountId, 'Conto di destinazione');
    if (fromAccountId === toAccountId) treasuryError('Seleziona due conti diversi', 422);
    const amount = positiveFinancialAmount(body.amount), occurredAt = financialDate(body.occurredAt), note = financialNote(body.note);
    const structureId = requiredId(getSelectedStructureId(req) ?? req.access?.structureId, 'Sede');
    assertFinancialAccess(req, 'treasury', 'create', structureId, getUserId(req));
    return sequelize.transaction(async transaction => {
        const operation = await beginFinancialOperation(req, 'TRANSFER', structureId, transaction);
        if (operation.replay) return operation.replay;
        for (const id of [fromAccountId, toAccountId].sort()) await resolveFinancialAccount(req.tenantSchema!, structureId, id, transaction);
        const accounts = await FinancialAccount.schema(req.tenantSchema!).findAll({where: {id: {[Op.in]: [fromAccountId, toAccountId]}}, transaction});
        if (accounts.length !== 2 || new Set(accounts.map(row => row.get('currency'))).size !== 1) treasuryError('I conti devono usare la stessa valuta', 422);
        const id = randomUUID(), common = {structureId, amount, occurredAt, status: 'POSTED', category: 'INTERNAL_TRANSFER',
            sourceId: id, description: note, createdByUserId: getUserId(req)};
        const Movement = TreasuryMovement.schema(req.tenantSchema!);
        const out = await Movement.create({...common, accountId: fromAccountId, direction: 'OUT', sourceType: 'TRANSFER_OUT'}, {transaction});
        const incoming = await Movement.create({...common, accountId: toAccountId, direction: 'IN', sourceType: 'TRANSFER_IN'}, {transaction});
        const result = transferView(financialPlain(out), financialPlain(incoming)); await operation.complete(result); return result;
    });
}
export async function voidTransfer(req: Request): Promise<Row> {
    const id = requiredId(req.params.id, 'Trasferimento'), reason = financialNote(req.body?.reason, true), occurredAt = financialDate(req.body?.occurredAt ?? new Date());
    const structureId = requiredId(getSelectedStructureId(req) ?? req.access?.structureId, 'Sede');
    assertFinancialAccess(req, 'treasury', 'update', structureId, getUserId(req));
    return sequelize.transaction(async transaction => {
        const operation = await beginFinancialOperation(req, 'TRANSFER_VOID', structureId, transaction);
        if (operation.replay) return operation.replay;
        const Movement = TreasuryMovement.schema(req.tenantSchema!);
        const rows = await Movement.findAll({where: {sourceId: id, sourceType: {[Op.in]: ['TRANSFER_OUT', 'TRANSFER_IN']}, structureId},
            order: [['accountId', 'ASC']], transaction, lock: transaction.LOCK.UPDATE});
        const out = rows.find(row => row.get('sourceType') === 'TRANSFER_OUT'), incoming = rows.find(row => row.get('sourceType') === 'TRANSFER_IN');
        if (rows.length !== 2 || !out || !incoming || cents(out.get('amount')) !== cents(incoming.get('amount'))) treasuryError('Trasferimento completo non disponibile', 404);
        if (rows.some(row => row.get('status') !== 'POSTED')) treasuryError('Trasferimento già annullato', 409);
        for (const row of rows) {
            if (dateOnly(occurredAt) < dateOnly(row.get('occurredAt'))) treasuryError('Lo storno non può precedere il trasferimento', 422);
            await Movement.create({accountId: row.get('accountId'), structureId, amount: row.get('amount'), occurredAt,
                direction: row.get('direction') === 'OUT' ? 'IN' : 'OUT', category: 'INTERNAL_TRANSFER', sourceType: row === out ? 'TRANSFER_VOID_OUT' : 'TRANSFER_VOID_IN',
                sourceId: id, reversalOfId: row.get('id'), status: 'POSTED', description: reason, voidReason: reason, createdByUserId: getUserId(req)}, {transaction});
            await row.update({status: 'VOID', voidReason: reason}, {transaction});
        }
        const result = transferView(financialPlain(out), financialPlain(incoming)); await operation.complete(result); return result;
    });
}
export async function protectAccountChange(req: Request, id: string, changes: Row | null): Promise<Model> {
    return sequelize.transaction(async transaction => {
        const site = getSelectedStructureId(req) ?? req.access?.structureId;
        if (site) await lockFinancialAccounts(req.tenantSchema!, site, transaction);
        const account = await FinancialAccount.schema(req.tenantSchema!).findOne({where: {id, ...scopeWhere(req, {structureField: 'structureId'})}, transaction, lock: transaction.LOCK.UPDATE});
        if (!account) treasuryError('Conto non disponibile', 404);
        const used = (await Promise.all([TreasuryMovement, DailyClosing, Expense, Reconciliation].map(model =>
            model.schema(req.tenantSchema!).count({where: {accountId: id}, transaction})))).some(count => count > 0);
        if (used && (!changes || ['openingBalance', 'structureId', 'currency', 'type'].some(field => changes[field] !== undefined
            && (field === 'openingBalance' ? cents(changes[field]) !== cents(account.get(field)) : String(changes[field] ?? '') !== String(account.get(field) ?? ''))))) treasuryError('Il conto è già utilizzato: conserva saldo iniziale, sede e valuta; puoi disattivarlo', 409);
        if (changes) {
            if (changes.openingBalance !== undefined && (!Number.isFinite(Number(changes.openingBalance)) || Math.abs(Number(changes.openingBalance) * 100 - cents(changes.openingBalance)) > 1e-6)) treasuryError('Saldo iniziale non valido', 422);
            await account.update(changes, {transaction});
        } else await account.destroy({transaction});
        return account;
    });
}
export async function protectExpenseChange(req: Request, id: string, changes: Row | null): Promise<Model> {
    return sequelize.transaction(async transaction => {
        const expense = await Expense.schema(req.tenantSchema!).findOne({where: {id, ...scopeWhere(req, {structureField: 'structureId', ownerField: 'createdByUserId'})}, transaction, lock: transaction.LOCK.UPDATE});
        if (!expense) treasuryError('Spesa non disponibile', 404);
        const ledger = await TreasuryMovement.schema(req.tenantSchema!).findAll({where: {expenseId: id}, transaction});
        if (!changes && ledger.length) treasuryError('La spesa ha movimenti registrati: conserva lo storico e annullala dopo aver stornato i pagamenti', 409);
        if (changes) {
            if (changes.amount !== undefined) changes.amount = positiveFinancialAmount(changes.amount);
            if (ledger.length && ['amount', 'structureId', 'supplierId', 'purchaseDocumentId'].some(field => changes[field] !== undefined
                && (field === 'amount' ? cents(changes[field]) !== cents(expense.get(field)) : String(changes[field] ?? '') !== String(expense.get(field) ?? '')))) treasuryError('La spesa ha pagamenti: annullali prima di cambiare importo o intestazione', 409);
            if ((changes.paidAt !== undefined && String(changes.paidAt ?? '') !== String(expense.get('paidAt') ?? ''))
                || (changes.status !== undefined && changes.status !== expense.get('status') && !['VOID', 'CANCELLED'].includes(String(changes.status)))) treasuryError('Usa Paga spesa per registrare il pagamento', 409);
            const position = expensePaymentPosition(financialPlain(expense), ledger.map(financialPlain));
            if (['VOID', 'CANCELLED'].includes(String(changes.status)) && (position.paidAmount === null || position.paidAmount > 0)) treasuryError('Storna prima i pagamenti della spesa', 409);
            await expense.update(changes, {transaction});
        } else await expense.destroy({transaction});
        return expense;
    });
}
