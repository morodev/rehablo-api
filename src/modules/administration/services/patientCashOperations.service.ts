import {Request} from 'express';
import {sequelize} from '../../../config/database.js';
import {getUserId} from '../../../middleware/rbac.js';
import Patient from '../../patients/models/patient.model.js';
import {PatientCredit, TreasuryMovement} from '../models/index.js';
import {PatientCreditMovement} from '../models/patientCreditMovement.model.js';
import {lockPatientSettlement} from '../../patients/services/patientSettlementPolicy.service.js';
import {beginFinancialOperation} from './financialOperation.service.js';
import {resolveFinancialAccount} from './financialAccountResolver.service.js';
import {assertFinancialAccess, financialPlain} from './financialOperations.service.js';
import {cents, financialDate, financialMoney, financialNote, positiveFinancialAmount} from './financialMovementPolicy.service.js';
import {nullableTreasuryUuid, treasuryError, validateTreasuryMethod} from './treasuryValidation.service.js';
import {verifiedSettlementCredit} from './patientCreditBacking.service.js';
import {dateOnly} from '../../reports/services/financialFacts.service.js';

function requiredPatientId(value: unknown): string {
    const id = nullableTreasuryUuid(value, 'Paziente');
    if (!id) treasuryError('Seleziona il paziente', 422); return id;
}

export async function recordPatientAdvance(req: Request) {
    const body = req.body ?? {}, patientId = requiredPatientId(body.patientId), amount = positiveFinancialAmount(body.amount);
    const account = nullableTreasuryUuid(body.accountId, 'Conto'), method = nullableTreasuryUuid(body.paymentMethodId, 'Metodo');
    const occurredAt = financialDate(body.paidAt ?? body.occurredAt ?? new Date()), note = financialNote(body.note);
    return sequelize.transaction(async transaction => {
        await lockPatientSettlement(req.tenantSchema!, patientId, transaction);
        const patient = await Patient.schema(req.tenantSchema!).findByPk(patientId, {transaction});
        if (!patient?.get('structureId')) treasuryError('Paziente non disponibile nella sede', 404);
        const structureId = String(patient.get('structureId'));
        assertFinancialAccess(req, 'quote', 'create', structureId, patient.get('userId'));
        assertFinancialAccess(req, 'treasury', 'create', structureId, getUserId(req));
        const operation = await beginFinancialOperation(req, 'PATIENT_ADVANCE', structureId, transaction);
        if (operation.replay) return operation.replay;
        const key = req.header('Idempotency-Key')!.trim(), Movement = TreasuryMovement.schema(req.tenantSchema!);
        const previous = await Movement.findOne({where: {idempotencyKey: key}, transaction});
        if (previous) {
            const credit = await PatientCredit.schema(req.tenantSchema!).findOne({where: {sourceType: 'TREASURY_ADVANCE', sourceId: previous.get('id'), patientId}, transaction});
            if (!credit || previous.get('sourceType') !== 'PATIENT_ADVANCE' || previous.get('createdByUserId') !== getUserId(req)
                || previous.get('structureId') !== structureId || cents(previous.get('amount')) !== cents(amount)
                || (account && previous.get('accountId') !== account) || (method && previous.get('paymentMethodId') !== method)
                || (body.paidAt && dateOnly(previous.get('occurredAt')) !== dateOnly(occurredAt)) || (credit.get('note') ?? null) !== note) treasuryError('Identificativo gia utilizzato per un altro anticipo', 409);
            const result = financialPlain(credit); await operation.complete(result); return result;
        }
        const accountId = await resolveFinancialAccount(req.tenantSchema!, structureId, account, transaction);
        await validateTreasuryMethod(req.tenantSchema!, method, transaction);
        const credit = await PatientCredit.schema(req.tenantSchema!).create({structureId, patientId, amount, remainingAmount: amount,
            status: 'ACTIVE', sourceType: 'TREASURY_ADVANCE', note}, {transaction});
        const movement = await Movement.create({accountId, structureId, direction: 'IN', category: 'PATIENT_ADVANCE', amount, occurredAt,
            status: 'POSTED', paymentMethodId: method, counterparty: [patient.get('name'), patient.get('surname')].filter(Boolean).join(' '),
            description: 'Anticipo paziente', sourceType: 'PATIENT_ADVANCE', sourceId: credit.get('id'), idempotencyKey: key, createdByUserId: getUserId(req)}, {transaction});
        await credit.update({sourceId: movement.get('id')}, {transaction});
        const result = financialPlain(credit); await operation.complete(result); return result;
    });
}

export async function recordPatientRefund(req: Request) {
    const body = req.body ?? {}, amount = positiveFinancialAmount(body.amount);
    const creditId = nullableTreasuryUuid(req.params.id, 'Credito');
    if (!creditId) treasuryError('Credito non valido', 422);
    const account = nullableTreasuryUuid(body.accountId, 'Conto'), method = nullableTreasuryUuid(body.paymentMethodId, 'Metodo');
    const occurredAt = financialDate(body.paidAt ?? body.occurredAt ?? new Date()), note = financialNote(body.note);
    return sequelize.transaction(async transaction => {
        const Credit = PatientCredit.schema(req.tenantSchema!), snapshot = await Credit.findByPk(creditId, {transaction});
        if (!snapshot) treasuryError('Credito non disponibile', 404);
        const patientId = String(snapshot.get('patientId')), structureId = String(snapshot.get('structureId'));
        assertFinancialAccess(req, 'treasury', 'create', structureId, getUserId(req));
        await lockPatientSettlement(req.tenantSchema!, patientId, transaction);
        const credit = await Credit.findByPk(creditId, {transaction, lock: transaction.LOCK.UPDATE});
        if (!credit || credit.get('patientId') !== patientId || credit.get('structureId') !== structureId) treasuryError('Il credito e cambiato: ricarica', 409);
        const operation = await beginFinancialOperation(req, 'PATIENT_CREDIT_REFUND', structureId, transaction);
        if (operation.replay) return operation.replay;
        const Ledger = PatientCreditMovement.schema(req.tenantSchema!), key = req.header('Idempotency-Key')!.trim();
        const prior = await Ledger.findOne({where: {idempotencyKey: key}, transaction});
        if (prior) {
            const treasury = await TreasuryMovement.schema(req.tenantSchema!).findByPk(String(prior.get('treasuryMovementId')), {transaction});
            if (prior.get('creditId') !== credit.get('id') || prior.get('type') !== 'REFUND' || prior.get('createdByUserId') !== getUserId(req)
                || cents(prior.get('amount')) !== cents(amount) || !treasury || (account && treasury.get('accountId') !== account)
                || (method && treasury.get('paymentMethodId') !== method)
                || (body.paidAt && dateOnly(treasury.get('occurredAt')) !== dateOnly(occurredAt)) || (note && treasury.get('description') !== note)) treasuryError('Identificativo gia usato per un altro rimborso', 409);
            const result = financialPlain(prior); await operation.complete(result); return result;
        }
        if (credit.get('status') !== 'ACTIVE' || cents(amount) > cents(credit.get('remainingAmount'))) treasuryError('Credito residuo insufficiente', 409);
        if (!await verifiedSettlementCredit(req.tenantSchema!, financialPlain(credit), transaction)) treasuryError('Credito non riconciliato con un incasso', 409);
        const Cash = TreasuryMovement.schema(req.tenantSchema!);
        const backing = credit.get('sourceType') === 'TREASURY_ADVANCE'
            ? await Cash.findByPk(String(credit.get('sourceId')), {transaction})
            : await Cash.findOne({where: {sourceType: 'INVOICE_PAYMENT_CORRECTION', sourceId: credit.get('sourceId')}, transaction})
                ?? await Cash.findOne({where: {sourceType: 'INVOICE_PAYMENT', sourceId: credit.get('sourceId')}, transaction});
        if (!backing || dateOnly(occurredAt) < dateOnly(backing.get('occurredAt'))) treasuryError('Il rimborso non puo precedere il suo incasso', 422);
        const accountId = await resolveFinancialAccount(req.tenantSchema!, structureId, account, transaction);
        await validateTreasuryMethod(req.tenantSchema!, method, transaction);
        const ledger = await Ledger.create({creditId: credit.get('id'), type: 'REFUND', amount, idempotencyKey: key, createdByUserId: getUserId(req)}, {transaction});
        const cash = await TreasuryMovement.schema(req.tenantSchema!).create({accountId, structureId, direction: 'OUT', category: 'PATIENT_CREDIT_REFUND',
            amount, occurredAt, status: 'POSTED', paymentMethodId: method, description: note ?? 'Rimborso credito paziente',
            sourceType: 'PATIENT_CREDIT_REFUND', sourceId: ledger.get('id'), idempotencyKey: `credit-refund-${ledger.get('id')}`, createdByUserId: getUserId(req)}, {transaction});
        await ledger.update({treasuryMovementId: cash.get('id')}, {transaction});
        const remainingAmount = financialMoney(Number(credit.get('remainingAmount')) - amount);
        await credit.update({remainingAmount, status: remainingAmount === 0 ? 'EXHAUSTED' : 'ACTIVE'}, {transaction});
        const result = financialPlain(ledger); await operation.complete(result); return result;
    });
}
