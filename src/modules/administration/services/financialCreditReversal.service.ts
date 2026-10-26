import {Request} from 'express';
import {Model, Op, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {getUserId} from '../../../middleware/rbac.js';
import {FinancialAccount, PatientCredit, TreasuryMovement} from '../models/index.js';
import {PatientCreditMovement} from '../models/patientCreditMovement.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import {lockPatientSettlement} from '../../patients/services/patientSettlementPolicy.service.js';
import {beginFinancialOperation, financialOperationKey} from './financialOperation.service.js';
import {assertFinancialAccess, financialPlain} from './financialOperations.service.js';
import {cents, financialDate, financialMoney, financialNote} from './financialMovementPolicy.service.js';
import {nullableTreasuryUuid, treasuryError} from './treasuryValidation.service.js';
import {dateOnly} from '../../reports/services/financialFacts.service.js';

type Row = Record<string, any>;
function validDependencyAmount(value: unknown): boolean {
    const amount = Number(value);
    return (typeof value === 'number' || typeof value === 'string') && Number.isFinite(amount) && amount > 0
        && Math.abs(amount * 100 - cents(amount)) < 1e-6;
}
/** A full cached balance is insufficient: every prior use must have its own verified compensation. */
function advanceDependenciesResolved(credit: Row, movements: Row[], payments: Map<string, Row>, cash: Map<string, Row>): boolean {
    if (!validDependencyAmount(credit.amount) || cents(credit.remainingAmount) !== cents(credit.amount)) return false;
    const byId = new Map(movements.map(row => [String(row.id), row]));
    if (byId.size !== movements.length || movements.some(row => !row.id || row.creditId !== credit.id || !validDependencyAmount(row.amount))) return false;
    const originals = movements.filter(row => ['APPLY_INVOICE', 'APPLY_APPOINTMENT', 'REFUND'].includes(row.type));
    if (movements.length !== originals.length * 2) return false;
    const usedPayments = new Set<string>();
    for (const original of originals) {
        if (original.reversalOfId) return false;
        const reversed = movements.filter(row => row.reversalOfId === original.id);
        const reverse = reversed[0];
        if (reversed.length !== 1 || !reverse || cents(original.amount) !== cents(reverse.amount)
            || reverse.type !== (original.type === 'REFUND' ? 'REVERSE_REFUND' : 'REVERSE_APPLY')) return false;
        if (original.type !== 'REFUND') {
            const payment = payments.get(String(original.invoicePaymentId));
            if (!original.targetId || !original.invoicePaymentId || usedPayments.has(String(original.invoicePaymentId)) || reverse.targetId !== original.targetId
                || reverse.invoicePaymentId !== original.invoicePaymentId || !payment || payment.source !== 'CREDIT'
                || payment.status !== 'VOID' || cents(payment.amount) !== cents(original.amount)
                || (original.type === 'APPLY_APPOINTMENT' ? payment.agendaEventId !== original.targetId : payment.invoiceId !== original.targetId)) return false;
            usedPayments.add(String(original.invoicePaymentId));
        } else {
            const outgoing = cash.get(String(original.treasuryMovementId)), restored = cash.get(String(reverse.treasuryMovementId));
            if (!outgoing || !restored || outgoing.status !== 'VOID' || outgoing.direction !== 'OUT'
                || outgoing.sourceType !== 'PATIENT_CREDIT_REFUND' || outgoing.sourceId !== original.id || !outgoing.accountId
                || outgoing.structureId !== credit.structureId || cents(outgoing.amount) !== cents(original.amount)
                || restored.status !== 'POSTED' || restored.direction !== 'IN' || restored.sourceType !== 'PATIENT_REFUND_VOID'
                || restored.sourceId !== original.id || restored.reversalOfId !== outgoing.id
                || restored.accountId !== outgoing.accountId || restored.structureId !== credit.structureId
                || cents(restored.amount) !== cents(original.amount)) return false;
        }
    }
    // Reject orphan reversals and unknown ledger kinds even if their amounts happen to cancel out.
    return movements.every(row => originals.includes(row) || originals.some(original => row.reversalOfId === original.id));
}
async function resolvedAdvanceCredits(schema: string, credits: Row[], transaction?: Transaction): Promise<Set<string>> {
    const movements = (await PatientCreditMovement.schema(schema).findAll({where: {creditId: {[Op.in]: credits.map(credit => credit.id)}}, transaction})).map(financialPlain);
    const paymentIds = [...new Set(movements.map(row => row.invoicePaymentId).filter(Boolean))];
    const cashIds = [...new Set(movements.map(row => row.treasuryMovementId).filter(Boolean))];
    const [paymentModels, cashModels] = await Promise.all([
        paymentIds.length ? InvoicePayment.schema(schema).findAll({where: {id: {[Op.in]: paymentIds}}, transaction}) : [],
        cashIds.length ? TreasuryMovement.schema(schema).findAll({where: {id: {[Op.in]: cashIds}}, transaction}) : []
    ]);
    const payments = new Map(paymentModels.map(model => {const row = financialPlain(model); return [String(row.id), row] as const;}));
    const cash = new Map(cashModels.map(model => {const row = financialPlain(model); return [String(row.id), row] as const;}));
    return new Set(credits.filter(credit => advanceDependenciesResolved(credit, movements.filter(row => row.creditId === credit.id), payments, cash)).map(credit => String(credit.id)));
}
function mayCorrect(req: Request, credit: Row): boolean {
    try {
        assertFinancialAccess(req, 'quote', 'update', String(credit.structureId), credit.createdByUserId);
        assertFinancialAccess(req, 'treasury', 'update', String(credit.structureId), getUserId(req)); return true;
    } catch (error) {if ((error as any).statusCode === 403) return false; throw error;}
}
export async function creditCorrectionCapabilities(req: Request, credits: Row[]): Promise<Map<string, {canVoidAdvance: boolean}>> {
    const result = new Map(credits.map(credit => [String(credit.id), {canVoidAdvance: false}]));
    const candidates = credits.filter(credit => mayCorrect(req, credit) && credit.sourceType === 'TREASURY_ADVANCE' && credit.sourceId
        && credit.status === 'ACTIVE' && cents(credit.amount) > 0 && cents(credit.amount) === cents(credit.remainingAmount));
    if (!candidates.length) return result;
    const [receipts, resolved] = await Promise.all([
        TreasuryMovement.schema(req.tenantSchema!).findAll({where: {id: {[Op.in]: candidates.map(credit => credit.sourceId)}}}),
        resolvedAdvanceCredits(req.tenantSchema!, candidates)
    ]);
    const reversals = receipts.length ? await TreasuryMovement.schema(req.tenantSchema!).findAll({where: {reversalOfId: {[Op.in]: receipts.map(row => row.get('id'))}, status: 'POSTED'}, attributes: ['reversalOfId']}) : [];
    const reversed = new Set(reversals.map(row => String(row.get('reversalOfId'))));
    for (const credit of candidates) {
        const receipt = receipts.find(row => row.get('id') === credit.sourceId);
        result.set(String(credit.id), {canVoidAdvance: resolved.has(String(credit.id)) && !!receipt && receipt.get('status') === 'POSTED'
            && receipt.get('direction') === 'IN' && receipt.get('sourceType') === 'PATIENT_ADVANCE' && receipt.get('sourceId') === credit.id
            && receipt.get('structureId') === credit.structureId && cents(receipt.get('amount')) === cents(credit.amount) && !reversed.has(String(receipt.get('id')))});
    }
    return result;
}
export async function refundCorrectionCapabilities(req: Request, credit: Row, movements: Row[]): Promise<Map<string, boolean>> {
    const result = new Map(movements.map(row => [String(row.id), false]));
    if (!mayCorrect(req, credit) || !['ACTIVE', 'EXHAUSTED'].includes(credit.status)) return result;
    const reversed = new Set(movements.map(row => String(row.reversalOfId ?? '')));
    const candidates = movements.filter(row => row.type === 'REFUND' && row.treasuryMovementId && !reversed.has(String(row.id))
        && cents(row.amount) > 0 && cents(credit.remainingAmount) + cents(row.amount) <= cents(credit.amount));
    if (!candidates.length) return result;
    const cash = await TreasuryMovement.schema(req.tenantSchema!).findAll({where: {id: {[Op.in]: candidates.map(row => row.treasuryMovementId)}}});
    const cashReversals = cash.length ? await TreasuryMovement.schema(req.tenantSchema!).findAll({where: {reversalOfId: {[Op.in]: cash.map(row => row.get('id'))}, status: 'POSTED'}, attributes: ['reversalOfId']}) : [];
    const reversedCash = new Set(cashReversals.map(row => String(row.get('reversalOfId'))));
    for (const row of candidates) {
        const original = cash.find(item => item.get('id') === row.treasuryMovementId);
        result.set(String(row.id), !!original && original.get('status') === 'POSTED' && original.get('direction') === 'OUT'
            && original.get('sourceType') === 'PATIENT_CREDIT_REFUND' && original.get('sourceId') === row.id
            && original.get('structureId') === credit.structureId && cents(original.get('amount')) === cents(row.amount) && !reversedCash.has(String(original.get('id'))));
    }
    return result;
}

async function lockedCredit(req: Request, transaction: Transaction): Promise<Model> {
    const creditId = nullableTreasuryUuid(req.params.id, 'Credito');
    if (!creditId) treasuryError('Credito non valido', 422);
    const Credit = PatientCredit.schema(req.tenantSchema!);
    const snapshot = await Credit.findByPk(creditId, {transaction});
    if (!snapshot) treasuryError('Credito non disponibile', 404);
    assertFinancialAccess(req, 'quote', 'update', String(snapshot.get('structureId')), snapshot.get('createdByUserId'));
    assertFinancialAccess(req, 'treasury', 'update', String(snapshot.get('structureId')), getUserId(req));
    const patientId = String(snapshot.get('patientId'));
    await lockPatientSettlement(req.tenantSchema!, patientId, transaction);
    const credit = await Credit.findByPk(creditId, {transaction, lock: transaction.LOCK.UPDATE});
    if (!credit || credit.get('patientId') !== patientId || credit.get('structureId') !== snapshot.get('structureId')) treasuryError('Il credito e cambiato: ricarica', 409);
    return credit;
}

async function reverseCash(req: Request, credit: Model, original: Model, type: string, sourceId: string,
    reason: string, occurredAt: Date, transaction: Transaction): Promise<Model> {
    const Movement = TreasuryMovement.schema(req.tenantSchema!);
    if (original.get('status') !== 'POSTED' || original.get('structureId') !== credit.get('structureId')
        || await Movement.count({where: {reversalOfId: original.get('id'), status: 'POSTED'}, transaction})) treasuryError('Movimento gia annullato o non riconciliato', 409);
    if (dateOnly(occurredAt) < dateOnly(original.get('occurredAt'))) treasuryError('La correzione non puo precedere il movimento', 422);
    await FinancialAccount.schema(req.tenantSchema!).findByPk(String(original.get('accountId')), {transaction, lock: transaction.LOCK.UPDATE});
    const reversed = await Movement.create({accountId: original.get('accountId'), structureId: credit.get('structureId'),
        direction: original.get('direction') === 'IN' ? 'OUT' : 'IN', amount: original.get('amount'), occurredAt,
        category: type, sourceType: type, sourceId, reversalOfId: original.get('id'), status: 'POSTED',
        paymentMethodId: original.get('paymentMethodId'), description: reason, voidReason: reason, createdByUserId: getUserId(req)}, {transaction});
    await original.update({status: 'VOID', voidReason: reason}, {transaction});
    return reversed;
}

export async function voidPatientAdvance(req: Request) {
    const reason = financialNote(req.body?.reason, true)!, occurredAt = financialDate(req.body?.occurredAt ?? new Date());
    return sequelize.transaction(async transaction => {
        const credit = await lockedCredit(req, transaction), structureId = String(credit.get('structureId'));
        const operation = await beginFinancialOperation(req, 'PATIENT_ADVANCE_VOID', structureId, transaction);
        if (operation.replay) return operation.replay;
        if (credit.get('sourceType') !== 'TREASURY_ADVANCE' || credit.get('status') !== 'ACTIVE'
            || cents(credit.get('remainingAmount')) !== cents(credit.get('amount'))
            || !(await resolvedAdvanceCredits(req.tenantSchema!, [financialPlain(credit)], transaction)).has(String(credit.get('id')))) treasuryError('Anticipo gia utilizzato: correggi prima le operazioni collegate', 409);
        const original = await TreasuryMovement.schema(req.tenantSchema!).findOne({where: {id: credit.get('sourceId'),
            sourceType: 'PATIENT_ADVANCE', sourceId: credit.get('id'), direction: 'IN'}, transaction, lock: transaction.LOCK.UPDATE});
        if (!original || cents(original.get('amount')) !== cents(credit.get('amount'))) treasuryError('Anticipo non riconciliato con un incasso', 409);
        const cash = await reverseCash(req, credit, original, 'PATIENT_ADVANCE_VOID', String(credit.get('id')), reason, occurredAt, transaction);
        const movement = await PatientCreditMovement.schema(req.tenantSchema!).create({creditId: credit.get('id'), type: 'VOID_ADVANCE',
            amount: credit.get('amount'), treasuryMovementId: cash.get('id'), idempotencyKey: financialOperationKey(req), createdByUserId: getUserId(req)}, {transaction});
        await credit.update({status: 'VOID', remainingAmount: 0}, {transaction});
        const result = {credit: financialPlain(credit), movement: financialPlain(movement)};
        await operation.complete(result); return result;
    });
}

export async function voidPatientRefund(req: Request) {
    const reason = financialNote(req.body?.reason, true)!, occurredAt = financialDate(req.body?.occurredAt ?? new Date());
    const movementId = nullableTreasuryUuid(req.params.movementId, 'Rimborso');
    if (!movementId) treasuryError('Rimborso non valido', 422);
    return sequelize.transaction(async transaction => {
        const credit = await lockedCredit(req, transaction), structureId = String(credit.get('structureId'));
        const operation = await beginFinancialOperation(req, 'PATIENT_REFUND_VOID', structureId, transaction);
        if (operation.replay) return operation.replay;
        if (!['ACTIVE', 'EXHAUSTED'].includes(String(credit.get('status')))) treasuryError('Credito non disponibile per la correzione', 409);
        const Ledger = PatientCreditMovement.schema(req.tenantSchema!);
        const refund = await Ledger.findOne({where: {id: movementId, creditId: credit.get('id'), type: 'REFUND'}, transaction, lock: transaction.LOCK.UPDATE});
        if (!refund) treasuryError('Rimborso non disponibile', 404);
        if (await Ledger.count({where: {reversalOfId: refund.get('id')}, transaction})) treasuryError('Rimborso gia annullato', 409);
        const cash = await TreasuryMovement.schema(req.tenantSchema!).findOne({where: {id: refund.get('treasuryMovementId'),
            sourceType: 'PATIENT_CREDIT_REFUND', sourceId: refund.get('id'), direction: 'OUT'}, transaction, lock: transaction.LOCK.UPDATE});
        if (!cash || cents(cash.get('amount')) !== cents(refund.get('amount'))) treasuryError('Rimborso non riconciliato con una uscita', 409);
        const remainingAmount = financialMoney(Number(credit.get('remainingAmount')) + Number(refund.get('amount')));
        if (cents(remainingAmount) > cents(credit.get('amount'))) treasuryError('Il saldo del credito richiede una riconciliazione', 409);
        const reversed = await reverseCash(req, credit, cash, 'PATIENT_REFUND_VOID', String(refund.get('id')), reason, occurredAt, transaction);
        const movement = await Ledger.create({creditId: credit.get('id'), type: 'REVERSE_REFUND', amount: refund.get('amount'),
            treasuryMovementId: reversed.get('id'), reversalOfId: refund.get('id'), idempotencyKey: financialOperationKey(req), createdByUserId: getUserId(req)}, {transaction});
        await credit.update({remainingAmount, status: 'ACTIVE'}, {transaction});
        const result = {credit: financialPlain(credit), movement: financialPlain(movement)};
        await operation.complete(result); return result;
    });
}
