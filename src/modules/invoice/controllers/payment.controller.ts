import { Request, Response } from 'express';
import { InvoicePaymentCreateOptions } from '../../administration/services/invoicePaymentTreasury.service.js';
import { nullableTreasuryUuid, treasuryError, validateTreasuryAccount, validateTreasuryMethod } from '../../administration/services/treasuryValidation.service.js';
import { FinancialAccount, TreasuryMovement } from '../../administration/models/index.js';
import { Structure } from '../../auth/models/index.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { sequelize } from '../../../config/database.js';
import { patientScopeWhere, getUserId } from '../../../middleware/rbac.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import Invoice from '../models/invoice.model.js';
import InvoicePayment from '../models/invoicePayment.model.js';
import { PatientCredit } from '../../administration/models/index.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import { syncInvoicePaymentStatus } from '../services/payment.service.js';
import { syncAppointmentPaymentStatus } from '../services/appointmentPayment.service.js';
import { assertPatientSettlementAllocations, lockPatientSettlement } from '../../patients/services/patientSettlementPolicy.service.js';
import {beginFinancialOperation, financialOperationKey} from '../../administration/services/financialOperation.service.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateOnly(value: unknown): value is string {
    if (typeof value !== 'string' || !DATE_REGEX.test(value)) return false;
    const parsed = new Date(`${value}T12:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function todayInRome(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
}

async function findScopedInvoice(req: Request) {
    return Invoice.schema(req.tenantSchema!).findOne({
        where: {
            id: req.params.invoiceId,
            ...patientScopeWhere(req, req.tenantSchema!, 'patientID')
        }
    });
}

export const listPayments = asyncHandler(async (req: Request, res: Response) => {
    const invoice = await findScopedInvoice(req);
    if (!invoice) return sendErrorResponse(res, 404, 'Fattura non trovata');

    const payments = await InvoicePayment.schema(req.tenantSchema!).findAll({
        where: { invoiceId: invoice.id },
        order: [['createdAt', 'DESC']]
    });
    return sendSuccessResponse(res, 200, { payments }, 'Movimenti di pagamento caricati');
});

export const createPayment = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    if (!UUID_REGEX.test(req.params.invoiceId)) return sendErrorResponse(res, 400, 'Fattura non valida');
    const accountId = nullableTreasuryUuid(req.body?.accountId, 'Conto');
    const paymentMethodId = nullableTreasuryUuid(req.body?.paymentMethodId, 'Metodo di pagamento');
    const idempotencyKey = financialOperationKey(req);
    const amount = Number(req.body?.amount);
    const paidAt = req.body?.paidAt;
    if (!Number.isFinite(amount) || Math.round(amount * 100) < 1) {
        return sendErrorResponse(res, 400, 'L’importo del pagamento deve essere maggiore di zero');
    }
    if (!isValidDateOnly(paidAt)) {
        return sendErrorResponse(res, 400, 'La data del pagamento è obbligatoria');
    }
    if (paidAt > todayInRome()) {
        return sendErrorResponse(res, 400, 'La data del pagamento non può essere futura');
    }
    if ((req.body?.method != null && (typeof req.body.method !== 'string' || req.body.method.length > 255))
        || (req.body?.note != null && (typeof req.body.note !== 'string' || req.body.note.length > 2000))) {
        return sendErrorResponse(res, 400, 'Metodo o nota di pagamento non validi');
    }

    const snapshot = await findScopedInvoice(req);
    if (!snapshot) return sendErrorResponse(res, 404, 'Fattura non trovata');
    const result = await sequelize.transaction(async (transaction) => {
        // Serialize retries across invoices too: the key is unique within the tenant ledger.
        if (idempotencyKey) await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:schema), hashtext(:key))', {
            replacements: { schema, key: idempotencyKey }, transaction
        });
        if (snapshot.patientID) await lockPatientSettlement(schema, snapshot.patientID, transaction);
        const invoice = await Invoice.schema(schema).findOne({
            where: {
                id: req.params.invoiceId,
                ...patientScopeWhere(req, schema, 'patientID')
            },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!invoice) return { kind: 'not-found' } as const;
        if (invoice.patientID !== snapshot.patientID) treasuryError('Il paziente del documento è cambiato: ricarica la posizione', 409);
        if (String(invoice.status).toLowerCase() === 'void') return { kind: 'void' } as const;
        if (invoice.documentType === 'nota_di_credito') return { kind: 'credit-note' } as const;

        let structureId = invoice.structureId ?? req.access?.structureId;
        const method = typeof req.body?.method === 'string' ? req.body.method.trim() || null : null;
        const note = typeof req.body?.note === 'string' ? req.body.note.trim() || null : null;
        const selectedMethod = paymentMethodId ? await validateTreasuryMethod(schema, paymentMethodId, transaction) : null;
        if (accountId) {
            // A legacy invoice can have no site. Tenant-wide access may use the selected account's site.
            if (!structureId && req.access?.scope === 'tenant') {
                const account = await FinancialAccount.schema(schema).findOne({ where: { id: accountId, isActive: true }, transaction });
                if (!account) treasuryError('Il conto selezionato non è disponibile o non è attivo');
                structureId = account.get('structureId') as string | undefined;
            }
            await validateTreasuryAccount(schema, accountId, structureId, transaction);
            const structure = await Structure.findOne({
                where: { id: structureId!, tenantId: getCurrentTenantId(req) }, transaction
            });
            if (!structure) treasuryError('La sede selezionata non è disponibile');
        }
        if (!structureId) treasuryError('Seleziona la sede dell’incasso', 422);
        const operation = await beginFinancialOperation(req, 'INVOICE_PAYMENT', structureId, transaction);
        if (operation.replay) {
            const payment = await InvoicePayment.schema(schema).findOne({where: {id: operation.replay.paymentId, invoiceId: invoice.id}, transaction});
            if (!payment || payment.status !== 'POSTED') treasuryError('L’incasso è stato modificato: aggiorna la posizione', 409);
            return {kind: 'replayed', payment, summary: await syncInvoicePaymentStatus(schema, invoice.id, transaction)} as const;
        }
        // Preserve retries issued before the immutable operation registry was introduced.
        const legacyReceipt = await TreasuryMovement.schema(schema).findOne({where: {idempotencyKey}, transaction});
        if (legacyReceipt) {
            const same = legacyReceipt.get('sourceType') === 'INVOICE_PAYMENT' && legacyReceipt.get('invoiceId') === invoice.id
                && (!accountId || legacyReceipt.get('accountId') === accountId)
                && (legacyReceipt.get('paymentMethodId') ?? null) === paymentMethodId
                && Number(legacyReceipt.get('amount')) === Math.round(amount * 100) / 100
                && new Date(legacyReceipt.get('occurredAt') as string).toISOString().slice(0, 10) === paidAt;
            const payment = same ? await InvoicePayment.schema(schema).findOne({where: {
                id: legacyReceipt.get('sourceId') as string, invoiceId: invoice.id}, transaction}) : null;
            if (!payment || payment.status !== 'POSTED' || (payment.note ?? null) !== note
                || (!paymentMethodId && (payment.method ?? null) !== method))
                treasuryError('Questa registrazione è già stata usata o annullata', 409);
            await operation.complete({paymentId: payment.id});
            return {kind: 'replayed', payment, summary: await syncInvoicePaymentStatus(schema, invoice.id, transaction)} as const;
        }
        const createOptions: InvoicePaymentCreateOptions = { transaction, treasuryContext: {
            accountId: accountId ?? undefined, structureId, paymentMethodId, idempotencyKey
        }};
        const summary = await syncInvoicePaymentStatus(schema, invoice.id, transaction);
        if (amount > summary.balance + 0.009) {
            return { kind: 'overpayment', balance: summary.balance } as const;
        }
        if (invoice.patientID && !invoice.carePackageId) {
            if (!structureId) treasuryError('Verifica la sede del documento prima di registrare il pagamento', 409);
            await assertPatientSettlementAllocations(schema, {
                patientId: invoice.patientID, structureId: structureId!, referenceInvoiceId: invoice.id
            }, [{ kind: 'INVOICE', targetId: invoice.id, amount: Math.round(amount * 100) / 100 }], transaction);
        }

        const payment = await InvoicePayment.schema(schema).create(
            {
                invoiceId: invoice.id,
                carePackageId: invoice.carePackageId ?? null,
                amount: Math.round(amount * 100) / 100,
                paidAt: new Date(`${paidAt}T12:00:00.000Z`),
                method: selectedMethod ? String(selectedMethod.get('label')) : method,
                note,
                source: invoice.carePackageId ? 'PACKAGE_PURCHASE' : 'USER',
                status: 'POSTED',
                createdByUserId: getUserId(req)
            },
            createOptions
        );
        const updatedSummary = await syncInvoicePaymentStatus(schema, invoice.id, transaction);
        await operation.complete({paymentId: payment.id});
        return { kind: 'created', payment, summary: updatedSummary } as const;
    });

    if (result.kind === 'not-found') return sendErrorResponse(res, 404, 'Fattura non trovata');
    if (result.kind === 'void') return sendErrorResponse(res, 409, 'La fattura è annullata');
    if (result.kind === 'credit-note') return sendErrorResponse(res, 409, 'Una nota di credito non riceve pagamenti');
    if (result.kind === 'overpayment') {
        return sendErrorResponse(res, 409, `Il residuo da incassare è € ${result.balance.toFixed(2)}`);
    }
    return sendSuccessResponse(res, result.kind === 'replayed' ? 200 : 201, result, result.kind === 'replayed' ? 'Incasso già registrato' : 'Pagamento registrato');
});

export const voidPayment = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < 3) return sendErrorResponse(res, 400, 'Indica il motivo dell’annullamento');
    if (!UUID_REGEX.test(req.params.paymentId)) return sendErrorResponse(res, 400, 'Pagamento non valido');
    // Opzione esplicita: il denaro incassato resta disponibile come credito del paziente.
    const convertToCredit = req.body?.convertToCredit === true;

    const invoice = await findScopedInvoice(req);
    if (!invoice) return sendErrorResponse(res, 404, 'Fattura non trovata');
    if (convertToCredit && invoice.carePackageId) return sendErrorResponse(res, 409, 'Gli incassi del pacchetto possono essere annullati; la conversione a credito non è prevista per questo acquisto');

    const result = await sequelize.transaction(async (transaction) => {
        // Serialize the patient's position before document, movement and event locks.
        if (invoice.patientID) await lockPatientSettlement(schema, invoice.patientID, transaction);
        const lockedInvoice = await Invoice.schema(schema).findOne({
            where: { id: invoice.id, ...patientScopeWhere(req, schema, 'patientID') },
            transaction, lock: transaction.LOCK.UPDATE
        });
        if (!lockedInvoice) return { kind: 'not-found' } as const;
        if (lockedInvoice.patientID !== invoice.patientID) treasuryError('Il paziente del documento è cambiato: ricarica la posizione', 409);
        const payment = await InvoicePayment.schema(schema).findOne({
            where: { id: req.params.paymentId, invoiceId: invoice.id },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!payment) return { kind: 'not-found' } as const;
        if (payment.status !== 'POSTED') return { kind: 'already-void' } as const;
        if (payment.source === 'PACKAGE') return { kind: 'package-coverage' } as const;
        if (payment.source === 'CREDIT') return { kind: 'credit-application' } as const;
        if (payment.source === 'OPENING_BALANCE' && convertToCredit) return { kind: 'opening-balance' } as const;

        const voidedAmount = Number(payment.get('amount')) || 0;
        const patientId = lockedInvoice.get('patientID') as string | null;
        let structureId = lockedInvoice.get('structureId') as string | null;
        if (convertToCredit) {
            if (!patientId || voidedAmount <= 0) return { kind: 'credit-unavailable' } as const;
            // A retained credit needs a real receipt that has not already been refunded.
            const receipt = await TreasuryMovement.schema(schema).findOne({
                where: { sourceType: 'INVOICE_PAYMENT_CORRECTION', sourceId: payment.id, status: 'POSTED' },
                transaction, lock: transaction.LOCK.UPDATE
            }) ?? await TreasuryMovement.schema(schema).findOne({
                where: { sourceType: 'INVOICE_PAYMENT', sourceId: payment.id, status: 'POSTED' },
                transaction, lock: transaction.LOCK.UPDATE
            });
            if (!receipt || await TreasuryMovement.schema(schema).count({
                where: { reversalOfId: receipt.get('id'), status: 'POSTED' }, transaction
            })) return { kind: 'credit-unavailable' } as const;
            structureId = structureId ?? receipt.get('structureId') as string | null;
            if (!structureId) return { kind: 'credit-unavailable' } as const;
        }
        await payment.update(
            {
                status: convertToCredit ? 'CREDIT' : 'VOID',
                voidedAt: new Date(),
                voidedByUserId: getUserId(req),
                voidReason: reason
            },
            { transaction }
        );
        if (['APPOINTMENT', 'OPENING_BALANCE'].includes(payment.source) && payment.agendaEventId) {
            const event = await AgendaEvent.schema(schema).findByPk(payment.agendaEventId, {
                transaction, lock: transaction.LOCK.UPDATE
            });
            if (event) await syncAppointmentPaymentStatus(schema, event, transaction, getUserId(req));
        }
        // Il credito è collegato al movimento originale e creato nella stessa transazione.
        if (convertToCredit) {
            await PatientCredit.schema(schema).create({
                structureId, patientId: patientId!, amount: voidedAmount, remainingAmount: voidedAmount, status: 'ACTIVE',
                sourceType: 'VOID_CREDIT', sourceId: payment.id,
                note: `Credito da storno incasso: ${reason}`
            }, { transaction });
        }
        const summary = await syncInvoicePaymentStatus(schema, invoice.id, transaction);
        return { kind: 'voided', payment, summary, creditCreated: convertToCredit } as const;
    });
    if (result.kind === 'not-found') return sendErrorResponse(res, 404, 'Pagamento non trovato');
    if (result.kind === 'already-void') return sendErrorResponse(res, 409, 'Movimento già annullato o trasferito a credito');
    if (result.kind === 'package-coverage') return sendErrorResponse(res, 409, 'La copertura da pacchetto non è uno storno di incasso');
    if (result.kind === 'credit-application') return sendErrorResponse(res, 409, 'La copertura da credito va gestita dal registro crediti');
    if (result.kind === 'opening-balance') return sendErrorResponse(res, 409, 'Il pagamento precedente non è un nuovo incasso da trasferire a credito');
    if (result.kind === 'credit-unavailable') return sendErrorResponse(res, 409, 'Credito non disponibile: serve un incasso effettivo non rimborsato e una sede associata');
    return sendSuccessResponse(res, 200, result, result.creditCreated ? 'Incasso trasferito a credito del paziente' : 'Pagamento annullato');
});

export const setLegacyPaymentDate = asyncHandler(async (req: Request, res: Response) => {
    if (!UUID_REGEX.test(req.params.paymentId)) return sendErrorResponse(res, 400, 'Pagamento non valido');
    const paidAt = req.body?.paidAt;
    if (!isValidDateOnly(paidAt)) {
        return sendErrorResponse(res, 400, 'Data di pagamento non valida');
    }
    if (paidAt > todayInRome()) {
        return sendErrorResponse(res, 400, 'La data del pagamento non può essere futura');
    }
    const invoice = await findScopedInvoice(req);
    if (!invoice) return sendErrorResponse(res, 404, 'Fattura non trovata');

    const result = await sequelize.transaction(async transaction => {
        if (invoice.patientID) await lockPatientSettlement(req.tenantSchema!, invoice.patientID, transaction);
        const lockedInvoice = await Invoice.schema(req.tenantSchema!).findOne({
            where: { id: invoice.id, ...patientScopeWhere(req, req.tenantSchema!, 'patientID') },
            transaction, lock: transaction.LOCK.UPDATE
        });
        if (!lockedInvoice) return { kind: 'missing' } as const;
        const payment = await InvoicePayment.schema(req.tenantSchema!).findOne({
            where: { id: req.params.paymentId, invoiceId: invoice.id }, transaction, lock: transaction.LOCK.UPDATE
        });
        if (!payment) return { kind: 'missing' } as const;
        if (payment.source !== 'LEGACY_IMPORT' || payment.status !== 'POSTED') return { kind: 'immutable' } as const;
        if (payment.paidAt) return new Date(payment.paidAt).toISOString().slice(0, 10) === paidAt
            ? {kind: 'updated', payment} as const : {kind: 'immutable'} as const;
        const original = await TreasuryMovement.schema(req.tenantSchema!).findOne({where: {
            sourceType: 'INVOICE_PAYMENT', sourceId: payment.id, status: 'POSTED'}, transaction, lock: transaction.LOCK.UPDATE});
        if (original) {
            const originalDate = new Date(original.get('occurredAt') as string);
            if (Number(original.get('amount')) !== Number(payment.amount) || !Number.isFinite(originalDate.getTime())
                || await TreasuryMovement.schema(req.tenantSchema!).count({where: {reversalOfId: original.get('id'), status:'POSTED'}, transaction}))
                treasuryError('L’incasso storico richiede riconciliazione prima di completare la data', 409);
            if (originalDate.toLocaleDateString('en-CA', {timeZone:'Europe/Rome'}) !== paidAt) {
                const common = {accountId: original.get('accountId'), structureId: original.get('structureId'),
                    amount: original.get('amount'), invoiceId: original.get('invoiceId') ?? invoice.id,
                    paymentMethodId: original.get('paymentMethodId') ?? null, counterparty: original.get('counterparty') ?? null,
                    status: 'POSTED', sourceId: payment.id, createdByUserId: getUserId(req)};
                await original.update({status:'VOID', voidReason:'Completamento data incasso storico'}, {transaction});
                await TreasuryMovement.schema(req.tenantSchema!).create({...common, direction:'OUT', category:'PAYMENT_DATE_CORRECTION',
                    occurredAt: original.get('occurredAt'), reversalOfId: original.get('id'), sourceType:'INVOICE_PAYMENT_DATE_VOID',
                    description:'Rettifica data incasso precedente', idempotencyKey:`legacy_date_${payment.id}_void`}, {transaction});
                await TreasuryMovement.schema(req.tenantSchema!).create({...common, direction:'IN', category:'INVOICE_PAYMENT',
                    occurredAt:new Date(`${paidAt}T12:00:00.000Z`), sourceType:'INVOICE_PAYMENT_CORRECTION',
                    description:'Data incasso precedente completata', idempotencyKey:`legacy_date_${payment.id}_corrected`}, {transaction});
            }
        }
        await payment.update({ paidAt: new Date(`${paidAt}T12:00:00.000Z`) }, { transaction, completeHistoricalDate: true } as any);
        return { kind: 'updated', payment } as const;
    });
    if (result.kind === 'missing') return sendErrorResponse(res, 404, 'Pagamento non trovato');
    if (result.kind === 'immutable') {
        return sendErrorResponse(res, 409, 'La data è modificabile solo sui pagamenti legacy senza data');
    }
    return sendSuccessResponse(res, 200, { payment: result.payment }, 'Data del pagamento completata');
});

export default { listPayments, createPayment, voidPayment, setLegacyPaymentDate };
