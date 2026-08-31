import { Request, Response } from 'express';
import { sequelize } from '../../../config/database.js';
import { patientScopeWhere, getUserId } from '../../../middleware/rbac.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import Invoice from '../models/invoice.model.js';
import InvoicePayment from '../models/invoicePayment.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import { syncInvoicePaymentStatus } from '../services/payment.service.js';

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
    const amount = Number(req.body?.amount);
    const paidAt = req.body?.paidAt;
    if (!Number.isFinite(amount) || amount <= 0) {
        return sendErrorResponse(res, 400, 'L’importo del pagamento deve essere maggiore di zero');
    }
    if (!isValidDateOnly(paidAt)) {
        return sendErrorResponse(res, 400, 'La data del pagamento è obbligatoria');
    }
    if (paidAt > todayInRome()) {
        return sendErrorResponse(res, 400, 'La data del pagamento non può essere futura');
    }

    const result = await sequelize.transaction(async (transaction) => {
        const invoice = await Invoice.schema(schema).findOne({
            where: {
                id: req.params.invoiceId,
                ...patientScopeWhere(req, schema, 'patientID')
            },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!invoice) return { kind: 'not-found' } as const;
        if (String(invoice.status).toLowerCase() === 'void') return { kind: 'void' } as const;
        if (invoice.documentType === 'nota_di_credito') return { kind: 'credit-note' } as const;

        const summary = await syncInvoicePaymentStatus(schema, invoice.id, transaction);
        if (amount > summary.balance + 0.009) {
            return { kind: 'overpayment', balance: summary.balance } as const;
        }

        const payment = await InvoicePayment.schema(schema).create(
            {
                invoiceId: invoice.id,
                amount: Math.round(amount * 100) / 100,
                paidAt: new Date(`${paidAt}T12:00:00.000Z`),
                method: typeof req.body?.method === 'string' ? req.body.method.trim() || null : null,
                note: typeof req.body?.note === 'string' ? req.body.note.trim() || null : null,
                source: 'USER',
                status: 'POSTED',
                createdByUserId: getUserId(req)
            },
            { transaction }
        );
        const updatedSummary = await syncInvoicePaymentStatus(schema, invoice.id, transaction);
        return { kind: 'created', payment, summary: updatedSummary } as const;
    });

    if (result.kind === 'not-found') return sendErrorResponse(res, 404, 'Fattura non trovata');
    if (result.kind === 'void') return sendErrorResponse(res, 409, 'La fattura è annullata');
    if (result.kind === 'credit-note') return sendErrorResponse(res, 409, 'Una nota di credito non riceve pagamenti');
    if (result.kind === 'overpayment') {
        return sendErrorResponse(res, 409, `Il residuo da incassare è € ${result.balance.toFixed(2)}`);
    }
    return sendSuccessResponse(res, 201, result, 'Pagamento registrato');
});

export const voidPayment = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < 3) return sendErrorResponse(res, 400, 'Indica il motivo dell’annullamento');
    if (!UUID_REGEX.test(req.params.paymentId)) return sendErrorResponse(res, 400, 'Pagamento non valido');

    const invoice = await findScopedInvoice(req);
    if (!invoice) return sendErrorResponse(res, 404, 'Fattura non trovata');

    const result = await sequelize.transaction(async (transaction) => {
        const payment = await InvoicePayment.schema(schema).findOne({
            where: { id: req.params.paymentId, invoiceId: invoice.id },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!payment) return { kind: 'not-found' } as const;
        if (payment.status === 'VOID') return { kind: 'already-void' } as const;

        await payment.update(
            {
                status: 'VOID',
                voidedAt: new Date(),
                voidedByUserId: getUserId(req),
                voidReason: reason
            },
            { transaction }
        );
        if (payment.source === 'APPOINTMENT' && payment.agendaEventId) {
            await AgendaEvent.schema(schema).update(
                {
                    appointmentPaymentStatus: 'unpaid',
                    appointmentPaidAmount: null,
                    appointmentPaidAt: null,
                    appointmentPaymentMethod: null,
                    appointmentPaymentNote: null,
                    appointmentPaymentRecordedBy: getUserId(req)
                },
                { where: { id: payment.agendaEventId }, transaction }
            );
        }
        const summary = await syncInvoicePaymentStatus(schema, invoice.id, transaction);
        return { kind: 'voided', payment, summary } as const;
    });
    if (result.kind === 'not-found') return sendErrorResponse(res, 404, 'Pagamento non trovato');
    if (result.kind === 'already-void') return sendErrorResponse(res, 409, 'Pagamento già annullato');
    return sendSuccessResponse(res, 200, result, 'Pagamento annullato');
});

export const setLegacyPaymentDate = asyncHandler(async (req: Request, res: Response) => {
    const paidAt = req.body?.paidAt;
    if (!isValidDateOnly(paidAt)) {
        return sendErrorResponse(res, 400, 'Data di pagamento non valida');
    }
    if (paidAt > todayInRome()) {
        return sendErrorResponse(res, 400, 'La data del pagamento non può essere futura');
    }
    const invoice = await findScopedInvoice(req);
    if (!invoice) return sendErrorResponse(res, 404, 'Fattura non trovata');

    const payment = await InvoicePayment.schema(req.tenantSchema!).findOne({
        where: { id: req.params.paymentId, invoiceId: invoice.id }
    });
    if (!payment) return sendErrorResponse(res, 404, 'Pagamento non trovato');
    if (payment.source !== 'LEGACY_IMPORT' || payment.paidAt) {
        return sendErrorResponse(res, 409, 'La data è modificabile solo sui pagamenti legacy senza data');
    }
    await payment.update({ paidAt: new Date(`${paidAt}T12:00:00.000Z`) });
    return sendSuccessResponse(res, 200, { payment }, 'Data del pagamento completata');
});

export default { listPayments, createPayment, voidPayment, setLegacyPaymentDate };
