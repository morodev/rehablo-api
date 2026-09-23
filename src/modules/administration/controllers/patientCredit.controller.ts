import { Request, Response } from 'express';
import { sequelize } from '../../../config/database.js';
import { Transaction } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import Patient from '../../patients/models/patient.model.js';
import { FinancialAccount, PatientCredit, PaymentMethod, TreasuryMovement } from '../models/administration.model.js';
import { PatientCreditMovement } from '../models/patientCreditMovement.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import { syncInvoicePaymentStatus } from '../../invoice/services/payment.service.js';
import { appointmentPricesByEvent, syncAppointmentPaymentStatus } from '../../invoice/services/appointmentPayment.service.js';

/** Advance is cash received and a liability to the patient, not invoice revenue. */
export const createAdvance = asyncHandler(async (req: Request, res: Response) => {
    const amount = Number(req.body?.amount);
    const patientId = String(req.body?.patientId ?? '');
    const accountId = String(req.body?.accountId ?? '');
    const paymentMethodId = String(req.body?.paymentMethodId ?? '');
    const key = String(req.header('Idempotency-Key') ?? '');
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6
        || !/^[a-f0-9-]{36}$/i.test(patientId) || !/^[a-f0-9-]{36}$/i.test(accountId)
        || !/^[a-f0-9-]{36}$/i.test(paymentMethodId) || !/^[a-zA-Z0-9_-]{8,128}$/.test(key)) {
        return sendErrorResponse(res, 422, 'Paziente, importo, conto, metodo e identificativo operazione obbligatori');
    }
    const result = await sequelize.transaction(async transaction => {
        const existing = await TreasuryMovement.schema(req.tenantSchema!).findOne({ where: { idempotencyKey: key }, transaction });
        if (existing) {
            if (existing.get('category') !== 'PATIENT_ADVANCE' || Number(existing.get('amount')) !== amount) {
                return { error: 409, message: 'Identificativo già usato per un’altra operazione' };
            }
            const credit = await PatientCredit.schema(req.tenantSchema!).findOne({ where: { sourceId: existing.get('id') }, transaction });
            return credit && credit.get('patientId') === patientId && existing.get('accountId') === accountId
                && existing.get('paymentMethodId') === paymentMethodId
                ? { credit, reused: true } : { error: 409, message: 'Identificativo già usato per un altro anticipo' };
        }
        const patient = await Patient.schema(req.tenantSchema!).findByPk(patientId, { transaction });
        if (!patient || !patient.get('structureId') || (req.access?.scope !== 'tenant' && patient.get('structureId') !== req.access?.structureId)) {
            return { error: 404, message: 'Paziente non disponibile nella sede' };
        }
        const structureId = String(patient.get('structureId'));
        const [account, method] = await Promise.all([
            FinancialAccount.schema(req.tenantSchema!).findOne({ where: { id: accountId, isActive: true }, transaction }),
            PaymentMethod.schema(req.tenantSchema!).findOne({ where: { id: paymentMethodId, isActive: true }, transaction })
        ]);
        if (!account || !method || (account.get('structureId') && account.get('structureId') !== structureId)) {
            return { error: 422, message: 'Conto o metodo non disponibile per la sede' };
        }
        const credit = await PatientCredit.schema(req.tenantSchema!).create({
            structureId, patientId, amount, remainingAmount: amount, status: 'ACTIVE', sourceType: 'TREASURY_ADVANCE',
            note: typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 1000) : null
        }, { transaction });
        const movement = await TreasuryMovement.schema(req.tenantSchema!).create({
            accountId, structureId, direction: 'IN', category: 'PATIENT_ADVANCE', amount, occurredAt: new Date(),
            status: 'POSTED', paymentMethodId, counterparty: `${patient.get('name')} ${patient.get('surname') ?? ''}`.trim(),
            description: 'Anticipo paziente', sourceType: 'PATIENT_ADVANCE', sourceId: credit.get('id'),
            idempotencyKey: key, createdByUserId: req.access!.userId
        }, { transaction });
        await credit.update({ sourceId: movement.get('id') }, { transaction });
        return { credit, reused: false };
    });
    if ('error' in result) return sendErrorResponse(res, result.error ?? 409, result.message ?? 'Anticipo non registrato');
    return sendSuccessResponse(res, result.reused ? 200 : 201, result.credit, 'Anticipo e credito registrati');
});

const validAmount = (value: unknown) => {
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0 && Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6 ? amount : null;
};
const validKey = (req: Request) => /^[a-zA-Z0-9_-]{8,128}$/.test(String(req.header('Idempotency-Key') ?? ''));

async function backingReceipt(schema: string, credit: PatientCredit, transaction: Transaction) {
    const sourceType = String(credit.get('sourceType') ?? '');
    const sourceId = String(credit.get('sourceId') ?? '');
    if (!sourceId) return null;
    const receipt = sourceType === 'TREASURY_ADVANCE'
        ? await TreasuryMovement.schema(schema).findByPk(sourceId, { transaction })
        : sourceType === 'VOID_CREDIT'
            ? await TreasuryMovement.schema(schema).findOne({ where: { sourceType: 'INVOICE_PAYMENT', sourceId }, transaction })
            : null;
    if (!receipt || receipt.get('status') !== 'POSTED' || receipt.get('direction') !== 'IN'
        || String(receipt.get('structureId')) !== String(credit.get('structureId'))
        || (sourceType === 'TREASURY_ADVANCE' && (receipt.get('sourceType') !== 'PATIENT_ADVANCE'
            || String(receipt.get('sourceId')) !== String(credit.get('id'))))
        || Number(receipt.get('amount')) < Number(credit.get('amount'))
        || await TreasuryMovement.schema(schema).count({
            where: { reversalOfId: receipt.get('id'), status: 'POSTED' }, transaction
        })) return null;
    return receipt;
}

export const creditMovements = asyncHandler(async (req: Request, res: Response) => {
    const credit = await PatientCredit.schema(req.tenantSchema!).findByPk(req.params.id);
    if (!credit || (req.access?.scope !== 'tenant' && credit.get('structureId') !== req.access?.structureId)) {
        return sendErrorResponse(res, 404, 'Credito non disponibile');
    }
    const rows = await PatientCreditMovement.schema(req.tenantSchema!).findAll({
        where: { creditId: credit.get('id') }, order: [['createdAt', 'DESC']]
    });
    return sendSuccessResponse(res, 200, rows);
});

export const applyCredit = asyncHandler(async (req: Request, res: Response) => {
    const amount = validAmount(req.body?.amount);
    const targetType = String(req.body?.targetType ?? '');
    const targetId = String(req.body?.targetId ?? '');
    const key = String(req.header('Idempotency-Key') ?? '');
    if (!amount || !['INVOICE', 'APPOINTMENT'].includes(targetType) || !/^[a-f0-9-]{36}$/i.test(targetId) || !validKey(req)) {
        return sendErrorResponse(res, 422, 'Destinazione, importo e identificativo operazione non validi');
    }
    const result = await sequelize.transaction(async transaction => {
        const credit = await PatientCredit.schema(req.tenantSchema!).findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!credit || (req.access?.scope !== 'tenant' && credit.get('structureId') !== req.access?.structureId)) {
            return { error: 404, message: 'Credito non disponibile' };
        }
        const prior = await PatientCreditMovement.schema(req.tenantSchema!).findOne({ where: { idempotencyKey: key }, transaction });
        if (prior) return prior.get('creditId') === credit.get('id') && prior.get('targetId') === targetId
            && Number(prior.get('amount')) === amount && prior.get('type') === `APPLY_${targetType}`
            ? { movement: prior, reused: true } : { error: 409, message: 'Identificativo già usato per un’altra operazione' };
        const remaining = Number(credit.get('remainingAmount'));
        if (credit.get('status') !== 'ACTIVE' || amount > remaining) return { error: 409, message: 'Credito residuo insufficiente' };
        if (!await backingReceipt(req.tenantSchema!, credit, transaction)) {
            return { error: 409, message: 'Credito non riconciliato con un incasso' };
        }
        let payment: InvoicePayment;
        if (targetType === 'INVOICE') {
            const invoice = await Invoice.schema(req.tenantSchema!).findOne({ where: {
                id: targetId, patientID: String(credit.get('patientId')), structureId: String(credit.get('structureId'))
            }, transaction, lock: transaction.LOCK.UPDATE });
            if (!invoice || invoice.get('status') === 'VOID' || invoice.get('documentType') === 'nota_di_credito'
                || !invoice.get('documentNumber')) return { error: 404, message: 'Fattura non disponibile' };
            const paid = Number(await InvoicePayment.schema(req.tenantSchema!).sum('amount', {
                where: { invoiceId: targetId, status: 'POSTED' }, transaction }) ?? 0);
            if (amount > Math.round((Number(invoice.get('invoiceTotal')) - paid) * 100) / 100) {
                return { error: 409, message: 'Importo superiore al residuo della fattura' };
            }
            payment = await InvoicePayment.schema(req.tenantSchema!).create({
                invoiceId: targetId, amount, paidAt: new Date(), method: 'Credito paziente', source: 'CREDIT',
                status: 'POSTED', createdByUserId: req.access!.userId
            }, { transaction });
            await syncInvoicePaymentStatus(req.tenantSchema!, targetId, transaction);
        } else {
            const event = await AgendaEvent.schema(req.tenantSchema!).findOne({ where: {
                id: targetId, patientId: String(credit.get('patientId')), structureId: String(credit.get('structureId'))
            }, transaction, lock: transaction.LOCK.UPDATE });
            if (!event || event.get('invoiceId') || event.get('status') === 'CANCELLED') return { error: 404, message: 'Seduta non disponibile' };
            const price = (await appointmentPricesByEvent(req.tenantSchema!, [event.get({ plain: true })], transaction))
                .get(targetId);
            const expected = price?.amount ?? Number(event.get('appointmentExpectedAmount'));
            const paid = Number(await InvoicePayment.schema(req.tenantSchema!).sum('amount', {
                where: { agendaEventId: targetId, status: 'POSTED' }, transaction }) ?? 0);
            if (!Number.isFinite(expected) || expected <= 0 || amount > Math.round((expected - paid) * 100) / 100) {
                return { error: 409, message: 'Imposta il prezzo della seduta e verifica il residuo' };
            }
            if (event.get('appointmentExpectedAmount') == null) {
                await event.update({ appointmentExpectedAmount: expected, appointmentPriceRecordedAt: new Date() }, { transaction });
            }
            payment = await InvoicePayment.schema(req.tenantSchema!).create({
                agendaEventId: targetId, amount, paidAt: new Date(), method: 'Credito paziente', source: 'CREDIT',
                status: 'POSTED', createdByUserId: req.access!.userId
            }, { transaction });
            await syncAppointmentPaymentStatus(req.tenantSchema!, event, transaction, req.access!.userId);
        }
        const movement = await PatientCreditMovement.schema(req.tenantSchema!).create({
            creditId: credit.get('id'), type: `APPLY_${targetType}`, amount, targetId,
            invoicePaymentId: payment.get('id'), idempotencyKey: key, createdByUserId: req.access!.userId
        }, { transaction });
        await credit.update({ remainingAmount: Math.round((remaining - amount) * 100) / 100,
            status: remaining === amount ? 'EXHAUSTED' : 'ACTIVE' }, { transaction });
        return { movement, reused: false };
    });
    if ('error' in result) return sendErrorResponse(res, result.error ?? 409, result.message ?? 'Credito non applicato');
    return sendSuccessResponse(res, result.reused ? 200 : 201, result.movement, 'Credito applicato senza nuovo incasso');
});

export const refundCredit = asyncHandler(async (req: Request, res: Response) => {
    const amount = validAmount(req.body?.amount);
    const accountId = String(req.body?.accountId ?? '');
    const paymentMethodId = String(req.body?.paymentMethodId ?? '');
    const key = String(req.header('Idempotency-Key') ?? '');
    if (!amount || !/^[a-f0-9-]{36}$/i.test(accountId) || !/^[a-f0-9-]{36}$/i.test(paymentMethodId) || !validKey(req)) {
        return sendErrorResponse(res, 422, 'Importo, conto, metodo e identificativo operazione non validi');
    }
    const result = await sequelize.transaction(async transaction => {
        const credit = await PatientCredit.schema(req.tenantSchema!).findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!credit || (req.access?.scope !== 'tenant' && credit.get('structureId') !== req.access?.structureId)) {
            return { error: 404, message: 'Credito non disponibile' };
        }
        const prior = await PatientCreditMovement.schema(req.tenantSchema!).findOne({ where: { idempotencyKey: key }, transaction });
        if (prior) {
            const priorTreasury = await TreasuryMovement.schema(req.tenantSchema!).findByPk(String(prior.get('treasuryMovementId')), { transaction });
            return prior.get('creditId') === credit.get('id') && prior.get('type') === 'REFUND'
                && Number(prior.get('amount')) === amount && priorTreasury?.get('accountId') === accountId
                && priorTreasury?.get('paymentMethodId') === paymentMethodId
                ? { movement: prior, reused: true }
                : { error: 409, message: 'Identificativo già usato per un’altra operazione' };
        }
        const remaining = Number(credit.get('remainingAmount'));
        if (credit.get('status') !== 'ACTIVE' || amount > remaining) return { error: 409, message: 'Credito residuo insufficiente' };
        if (!await backingReceipt(req.tenantSchema!, credit, transaction)) {
            return { error: 409, message: 'Credito non riconciliato con un incasso' };
        }
        const [account, method] = await Promise.all([
            FinancialAccount.schema(req.tenantSchema!).findOne({ where: { id: accountId, isActive: true }, transaction }),
            PaymentMethod.schema(req.tenantSchema!).findOne({ where: { id: paymentMethodId, isActive: true }, transaction })
        ]);
        if (!account || !method || (account.get('structureId') && account.get('structureId') !== credit.get('structureId'))) {
            return { error: 422, message: 'Conto o metodo non disponibile per la sede' };
        }
        const movement = await PatientCreditMovement.schema(req.tenantSchema!).create({
            creditId: credit.get('id'), type: 'REFUND', amount, idempotencyKey: key, createdByUserId: req.access!.userId
        }, { transaction });
        const treasury = await TreasuryMovement.schema(req.tenantSchema!).create({
            accountId, structureId: credit.get('structureId'), direction: 'OUT', category: 'PATIENT_CREDIT_REFUND',
            amount, occurredAt: new Date(), status: 'POSTED', paymentMethodId, description: 'Rimborso credito paziente',
            sourceType: 'PATIENT_CREDIT_REFUND', sourceId: movement.get('id'), idempotencyKey: `credit-refund-${movement.get('id')}`,
            createdByUserId: req.access!.userId
        }, { transaction });
        await movement.update({ treasuryMovementId: treasury.get('id') }, { transaction });
        await credit.update({ remainingAmount: Math.round((remaining - amount) * 100) / 100,
            status: remaining === amount ? 'EXHAUSTED' : 'ACTIVE' }, { transaction });
        return { movement, reused: false };
    });
    if ('error' in result) return sendErrorResponse(res, result.error ?? 409, result.message ?? 'Credito non rimborsato');
    return sendSuccessResponse(res, result.reused ? 200 : 201, result.movement, 'Rimborso registrato');
});

export const reverseCreditApplication = asyncHandler(async (req: Request, res: Response) => {
    const key = String(req.header('Idempotency-Key') ?? '');
    if (!validKey(req)) return sendErrorResponse(res, 422, 'Identificativo operazione non valido');
    const result = await sequelize.transaction(async transaction => {
        const credit = await PatientCredit.schema(req.tenantSchema!).findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!credit || (req.access?.scope !== 'tenant' && credit.get('structureId') !== req.access?.structureId)) {
            return { error: 404, message: 'Credito non disponibile' };
        }
        const original = await PatientCreditMovement.schema(req.tenantSchema!).findOne({ where: {
            id: req.params.movementId, creditId: credit.get('id')
        }, transaction, lock: transaction.LOCK.UPDATE });
        if (!original || !['APPLY_INVOICE', 'APPLY_APPOINTMENT'].includes(String(original.get('type')))) {
            return { error: 404, message: 'Applicazione non disponibile' };
        }
        const prior = await PatientCreditMovement.schema(req.tenantSchema!).findOne({ where: { reversalOfId: original.get('id') }, transaction });
        if (prior) return { movement: prior, reused: true };
        const keyUse = await PatientCreditMovement.schema(req.tenantSchema!).findOne({ where: { idempotencyKey: key }, transaction });
        if (keyUse) return { error: 409, message: 'Identificativo già usato' };
        const payment = await InvoicePayment.schema(req.tenantSchema!).findByPk(String(original.get('invoicePaymentId')),
            { transaction, lock: transaction.LOCK.UPDATE });
        if (!payment || payment.get('status') !== 'POSTED' || payment.get('source') !== 'CREDIT') {
            return { error: 409, message: 'Copertura già annullata' };
        }
        await payment.update({ status: 'VOID', voidedAt: new Date(), voidedByUserId: req.access!.userId,
            voidReason: 'Correzione applicazione credito' }, { transaction });
        if (original.get('type') === 'APPLY_INVOICE') {
            await syncInvoicePaymentStatus(req.tenantSchema!, String(original.get('targetId')), transaction);
        } else {
            const event = await AgendaEvent.schema(req.tenantSchema!).findByPk(String(original.get('targetId')),
                { transaction, lock: transaction.LOCK.UPDATE });
            if (event) await syncAppointmentPaymentStatus(req.tenantSchema!, event, transaction, req.access!.userId);
        }
        const amount = Number(original.get('amount'));
        const movement = await PatientCreditMovement.schema(req.tenantSchema!).create({
            creditId: credit.get('id'), type: 'REVERSE_APPLY', amount, targetId: original.get('targetId'),
            invoicePaymentId: payment.get('id'), reversalOfId: original.get('id'),
            idempotencyKey: key, createdByUserId: req.access!.userId
        }, { transaction });
        await credit.update({ remainingAmount: Math.round((Number(credit.get('remainingAmount')) + amount) * 100) / 100,
            status: 'ACTIVE' }, { transaction });
        return { movement, reused: false };
    });
    if ('error' in result) return sendErrorResponse(res, result.error ?? 409, result.message ?? 'Applicazione non annullata');
    return sendSuccessResponse(res, result.reused ? 200 : 201, result.movement, 'Applicazione annullata e credito ripristinato');
});
