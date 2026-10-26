import { Request, Response } from 'express';
import {recordPatientAdvance, recordPatientRefund} from '../services/patientCashOperations.service.js';
import {verifiedSettlementCredit} from '../services/patientCreditBacking.service.js';
import {refundCorrectionCapabilities} from '../services/financialCreditReversal.service.js';
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
import { appointmentPricesByEvent, ensureAppointmentPaymentHistory, syncAppointmentPaymentStatus } from '../../invoice/services/appointmentPayment.service.js';
import { assertPatientSettlementAllocations, lockPatientSettlement } from '../../patients/services/patientSettlementPolicy.service.js';

/** Advance is cash received and a liability to the patient, not invoice revenue. */
export const createAdvance = asyncHandler(async (req: Request, res: Response) =>
    sendSuccessResponse(res, 201, await recordPatientAdvance(req), 'Anticipo e credito registrati'));
const validAmount = (value: unknown) => {
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0 && Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6 ? amount : null;
};
const validKey = (req: Request) => /^[a-zA-Z0-9_-]{8,128}$/.test(String(req.header('Idempotency-Key') ?? ''));

/** Snapshot is read without a row lock; all financial writers then share the patient lock. */
async function lockCreditPatient(req: Request, transaction: Transaction): Promise<PatientCredit | null> {
    const snapshot = await PatientCredit.schema(req.tenantSchema!).findByPk(req.params.id, { transaction });
    if (!snapshot || (req.access?.scope !== 'tenant' && snapshot.get('structureId') !== req.access?.structureId)) return null;
    const patientId = String(snapshot.get('patientId') ?? '');
    if (!patientId) return null;
    await lockPatientSettlement(req.tenantSchema!, patientId, transaction);
    const credit = await PatientCredit.schema(req.tenantSchema!).findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!credit || String(credit.get('patientId')) !== patientId
        || (req.access?.scope !== 'tenant' && credit.get('structureId') !== req.access?.structureId)) return null;
    return credit;
}

async function backingReceipt(schema: string, credit: PatientCredit, transaction: Transaction) {
    return verifiedSettlementCredit(schema, credit.get({plain: true}), transaction);
}
export const creditMovements = asyncHandler(async (req: Request, res: Response) => {
    const credit = await PatientCredit.schema(req.tenantSchema!).findByPk(req.params.id);
    if (!credit || (req.access?.scope !== 'tenant' && credit.get('structureId') !== req.access?.structureId)) {
        return sendErrorResponse(res, 404, 'Credito non disponibile');
    }
    const rows = await PatientCreditMovement.schema(req.tenantSchema!).findAll({
        where: { creditId: credit.get('id') }, order: [['createdAt', 'DESC']]
    });
    const values = rows.map(row => row.get({plain: true}));
    const capabilities = await refundCorrectionCapabilities(req, credit.get({plain: true}), values);
    return sendSuccessResponse(res, 200, values.map(row => ({...row, canVoid: capabilities.get(String(row.id)) === true})));
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
        const credit = await lockCreditPatient(req, transaction);
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
            if (!invoice || String(invoice.get('status')).toLowerCase() === 'void' || invoice.get('documentType') === 'nota_di_credito'
                || !invoice.get('documentNumber')) return { error: 404, message: 'Fattura non disponibile' };
            const summary = await syncInvoicePaymentStatus(req.tenantSchema!, targetId, transaction);
            if (amount > summary.balance + 0.009) {
                return { error: 409, message: 'Importo superiore al residuo della fattura' };
            }
            await assertPatientSettlementAllocations(req.tenantSchema!, {
                patientId: String(credit.get('patientId')), structureId: String(credit.get('structureId')), referenceInvoiceId: targetId
            }, [{ kind: 'INVOICE', targetId, amount }], transaction);
            if (invoice.get('carePackageId')) return {error: 409, message: 'Per questo acquisto registra un incasso dal pacchetto; il credito paziente non è ancora previsto'};
            payment = await InvoicePayment.schema(req.tenantSchema!).create({
                invoiceId: targetId, carePackageId: invoice.get('carePackageId') as string | null, amount, paidAt: new Date(), method: 'Credito paziente', source: 'CREDIT',
                status: 'POSTED', createdByUserId: req.access!.userId
            }, { transaction });
            await syncInvoicePaymentStatus(req.tenantSchema!, targetId, transaction);
        } else {
            const event = await AgendaEvent.schema(req.tenantSchema!).findOne({ where: {
                id: targetId, patientId: String(credit.get('patientId')), structureId: String(credit.get('structureId'))
            }, transaction, lock: transaction.LOCK.UPDATE });
            if (!event || event.get('invoiceId') || event.get('recurrence') || event.get('recurringEventId')
                || (event.get('carePackageId') && ['RESERVED', 'CONSUMED'].includes(String(event.get('packageReservationStatus'))))
                || !['CONFIRMED', 'COMPLETED'].includes(String(event.get('status')).toUpperCase())
                || !Number.isFinite(Date.parse(String(event.get('start') ?? ''))) || Date.parse(String(event.get('start'))) > Date.now()) {
                return { error: 404, message: 'Seduta non disponibile' };
            }
            const price = (await appointmentPricesByEvent(req.tenantSchema!, [event.get({ plain: true })], transaction))
                .get(targetId);
            await ensureAppointmentPaymentHistory(req.tenantSchema!, event, transaction);
            const expected = price?.amount ?? Number(event.get('appointmentExpectedAmount'));
            const paid = Number(await InvoicePayment.schema(req.tenantSchema!).sum('amount', {
                where: { agendaEventId: targetId, status: 'POSTED' }, transaction }) ?? 0);
            if (!Number.isFinite(expected) || expected <= 0 || amount > Math.round((expected - paid) * 100) / 100) {
                return { error: 409, message: 'Imposta il prezzo della seduta e verifica il residuo' };
            }
            if (event.get('appointmentExpectedAmount') == null) {
                await event.update({ appointmentExpectedAmount: expected, appointmentPriceRecordedAt: new Date() }, { transaction });
            }
            await assertPatientSettlementAllocations(req.tenantSchema!, {
                patientId: String(credit.get('patientId')), structureId: String(credit.get('structureId')), referenceAgendaEventId: targetId
            }, [{ kind: 'APPOINTMENT', targetId, amount }], transaction);
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

export const refundCredit = asyncHandler(async (req: Request, res: Response) =>
    sendSuccessResponse(res, 201, await recordPatientRefund(req), 'Rimborso registrato'));
export const reverseCreditApplication = asyncHandler(async (req: Request, res: Response) => {
    const key = String(req.header('Idempotency-Key') ?? '');
    if (!validKey(req)) return sendErrorResponse(res, 422, 'Identificativo operazione non valido');
    const result = await sequelize.transaction(async transaction => {
        const credit = await lockCreditPatient(req, transaction);
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
        // Event-owned credit may have been linked, released and reissued since application.
        // Synchronize the live payment destinations, preserving the original movement ID.
        const linkedInvoiceId = payment.get('invoiceId') as string | null;
        if (linkedInvoiceId) await syncInvoicePaymentStatus(req.tenantSchema!, linkedInvoiceId, transaction);
        const agendaEventId = payment.get('agendaEventId') as string | null
            || (original.get('type') === 'APPLY_APPOINTMENT' ? String(original.get('targetId')) : null);
        if (agendaEventId) {
            const event = await AgendaEvent.schema(req.tenantSchema!).findByPk(agendaEventId,
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
