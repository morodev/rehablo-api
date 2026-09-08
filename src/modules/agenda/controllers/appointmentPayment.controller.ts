import { Request, Response } from 'express';
import { sequelize } from '../../../config/database.js';
import { getGrantedPermissions, scopeWhere, getUserId } from '../../../middleware/rbac.js';
import { hasPermission } from '../../auth/rbac/permissions.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import AgendaEvent from '../models/agendaEvent.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import { AppointmentAdjustmentError, resolveAppointmentAdjustment } from '../../invoice/utils/appointmentAdjustment.js';
import { getLinkedInvoiceId } from '../../invoice/services/invoiceAgendaEvent.service.js';
import {
    appointmentPricesByEvent, ensureAppointmentPaymentHistory, paymentMoney,
    snapshotAppointmentPrice, summarizeAppointmentPayments, syncAppointmentPaymentStatus
} from '../../invoice/services/appointmentPayment.service.js';
import { patientPaymentPositionsByReferenceEvents } from '../services/patientPaymentPosition.service.js';

const SCOPE = { ownerField: 'calendarId', structureField: 'structureId', includeUnassigned: false };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class PaymentError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
const fail = (status: number, message: string): never => { throw new PaymentError(status, message); };

function validateMovement(body: Record<string, any>): void {
    const paidAt = body.paidAt;
    const date = typeof paidAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(paidAt)
        ? new Date(paidAt + 'T12:00:00.000Z') : null;
    if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== paidAt) {
        fail(400, 'La data di incasso deve essere una data valida');
    }
    if (paidAt > new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' })) {
        fail(400, 'La data di incasso non può essere futura');
    }
    if (body.method != null && (typeof body.method !== 'string' || body.method.length > 255)) {
        fail(400, 'Metodo di pagamento non valido');
    }
    if (body.note != null && (typeof body.note !== 'string' || body.note.length > 2000)) {
        fail(400, 'La nota può contenere al massimo 2000 caratteri');
    }
}

async function writePayment(req: Request, res: Response, cumulative: boolean, pricingOnly = false) {
    const schema = req.tenantSchema!;
    if (!UUID.test(req.params.agendaEventId)) return sendErrorResponse(res, 400, 'Appuntamento non valido');
    try {
        const result = await sequelize.transaction(async transaction => {
            const event = await AgendaEvent.schema(schema).findOne({
                where: { id: req.params.agendaEventId, ...scopeWhere(req, SCOPE) },
                transaction, lock: transaction.LOCK.UPDATE
            });
            if (!event) return fail(404, 'Appuntamento non trovato o non accessibile');
            const linkedInvoice = await getLinkedInvoiceId(schema, event.id, event.invoiceId);
            if (linkedInvoice) fail(409, 'Appuntamento fatturato: gestisci i pagamenti dalla fattura');
            if (event.recurrence || event.recurringEventId) fail(422, 'Separa la singola occorrenza dalla serie prima di registrare incassi');
            if (!['CONFIRMED', 'COMPLETED'].includes(String(event.status ?? '').toUpperCase())) {
                fail(409, 'Incasso disponibile solo per sedute confermate o effettuate');
            }
            if (!event.patientId && !event.patient?.id) fail(422, 'L’incasso richiede una seduta con paziente');
            if (!Number.isFinite(Date.parse(event.start ?? '')) || Date.parse(event.start!) > Date.now()) {
                fail(409, 'Non è possibile incassare una seduta futura');
            }
            const history = await ensureAppointmentPaymentHistory(schema, event, transaction);
            if (event.appointmentExpectedAmount == null) {
                await event.update(await snapshotAppointmentPrice(schema, event.get({ plain: true }), transaction), { transaction });
            }
            const pricing = pricingOnly ? req.body : req.body?.pricing;
            if (pricingOnly || pricing !== undefined) {
                if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) fail(400, 'Prezzo non valido');
                if (pricing.note != null && (typeof pricing.note !== 'string' || pricing.note.length > 2000)) {
                    fail(400, 'La nota può contenere al massimo 2000 caratteri');
                }
                const price = (await appointmentPricesByEvent(schema, [event.get({ plain: true })], transaction)).get(event.id)!;
                const original = event.appointmentOriginalAmount == null
                    ? event.appointmentPriceAdjustment ? null : price.amount
                    : paymentMoney(event.appointmentOriginalAmount);
                const paid = summarizeAppointmentPayments(price.amount, history.map(payment => payment.get({ plain: true }))).paidAmount;
                const adjusted = resolveAppointmentAdjustment(original, pricing.adjustment, pricing.discountAmount, paid, price.vatRate);
                await event.update({
                    appointmentOriginalAmount: original,
                    appointmentPriceAdjustment: adjusted.adjustment,
                    appointmentExpectedAmount: adjusted.amount,
                    appointmentNetAmount: adjusted.netAmount,
                    appointmentPriceAdjustmentNote: pricing.note?.trim() || null,
                    appointmentPriceAdjustedBy: getUserId(req), appointmentPriceAdjustedAt: new Date(),
                    appointmentPriceRecordedAt: new Date(), appointmentPaymentHistoryKnown: true
                }, { transaction });
            }
            const expected = (await appointmentPricesByEvent(schema, [event.get({ plain: true })], transaction)).get(event.id)!;
            const previous = summarizeAppointmentPayments(expected.amount, history.map(payment => payment.get({ plain: true })));
            const requestedStatus = String(req.body?.status ?? '').toLowerCase();
            if (cumulative && !['paid', 'partial', 'unpaid'].includes(requestedStatus)) fail(400, 'Stato incasso non valido');
            const rawAmount = req.body?.amount;
            const target = pricingOnly ? 0 : cumulative && requestedStatus === 'unpaid' ? 0
                : cumulative && requestedStatus === 'paid' && (rawAmount == null || rawAmount === '')
                    ? expected.amount : Number(rawAmount);
            if (target == null || !Number.isFinite(target) || target < 0) fail(400, 'Importo incasso non valido');
            const amount = paymentMoney(Number(target) - (cumulative ? previous.paidAmount : 0));
            if (cumulative && amount < 0) fail(409, 'Per correggere gli incassi annulla i singoli movimenti indicando il motivo');
            if (cumulative && amount === 0 && previous.paidAmount > 0 && [
                ['paidAt', event.appointmentPaidAt], ['method', event.appointmentPaymentMethod], ['note', event.appointmentPaymentNote]
            ].some(([field, existing]) => Object.prototype.hasOwnProperty.call(req.body, field!)
                && String(req.body[field!] ?? '').trim() !== String(existing ?? '').trim())) {
                fail(409, 'Importo e dati dei movimenti sono conservati: per correggerli annulla il movimento e registralo nuovamente');
            }
            if (!pricingOnly && event.appointmentPriceAdjustment === 'COMPLIMENTARY') fail(409, 'La seduta è omaggio: non sono previsti incassi');
            if (!pricingOnly && !cumulative && amount <= 0) fail(400, 'L’importo deve essere almeno 0,01 euro');
            if (expected.amount !== null && previous.paidAmount + amount > expected.amount + 0.009) {
                fail(409, 'L’importo supera il residuo della seduta di € ' + (previous.balance ?? 0).toFixed(2));
            }
            let payment: InvoicePayment | null = null;
            if (amount > 0) {
                validateMovement(req.body);
                payment = await InvoicePayment.schema(schema).create({
                    invoiceId: null, agendaEventId: event.id, amount,
                    paidAt: new Date(req.body.paidAt + 'T12:00:00.000Z'),
                    method: req.body.method?.trim() || null, note: req.body.note?.trim() || null,
                    source: 'APPOINTMENT', status: 'POSTED', createdByUserId: getUserId(req)
                }, { transaction });
            }
            if (req.body?.markCompleted === true && String(event.status).toUpperCase() === 'CONFIRMED') {
                await event.update({ status: 'COMPLETED' }, { transaction });
            }
            const summary = await syncAppointmentPaymentStatus(schema, event, transaction, getUserId(req));
            return { payment, summary, agendaEvent: { ...event.get({ plain: true }),
                appointmentExpectedAmount: expected.amount, appointmentPriceSource: expected.source } };
        });
        return sendSuccessResponse(res, cumulative || pricingOnly ? 200 : 201, cumulative ? result.agendaEvent : result,
            pricingOnly ? 'Prezzo della seduta aggiornato' : 'Incasso registrato');
    } catch (error) {
        if (error instanceof AppointmentAdjustmentError) return sendErrorResponse(res, 400, error.message);
        if (error instanceof PaymentError) return sendErrorResponse(res, error.status, error.message);
        throw error;
    }
}

export const createAppointmentPayment = asyncHandler((req, res) => writePayment(req, res, false));
export const updateAppointmentPaymentCompatibility = asyncHandler((req, res) => writePayment(req, res, true));
export const updateAppointmentPricing = asyncHandler((req, res) => writePayment(req, res, false, true));

export const listAppointmentPayments = asyncHandler(async (req, res) => {
    if (!UUID.test(req.params.agendaEventId)) return sendErrorResponse(res, 400, 'Appuntamento non valido');
    const schema = req.tenantSchema!;
    const event = await AgendaEvent.schema(schema).findOne({
        where: { id: req.params.agendaEventId, ...scopeWhere(req, SCOPE) }
    });
    if (!event) return sendErrorResponse(res, 404, 'Appuntamento non trovato o non accessibile');
    const plainEvent = event.get({ plain: true }) as Record<string, any>;
    const canReadFinance = Boolean(req.user?.isSuperAdmin)
        || hasPermission(getGrantedPermissions(req), 'invoice', 'read');
    const [payments, priceMap, positionMap] = await Promise.all([
        InvoicePayment.schema(schema).findAll({
            where: { agendaEventId: event.id }, order: [['createdAt', 'DESC']]
        }),
        appointmentPricesByEvent(schema, [plainEvent]),
        canReadFinance
            ? patientPaymentPositionsByReferenceEvents(schema, [plainEvent], scopeWhere(req, SCOPE))
            : Promise.resolve(new Map())
    ]);
    const price = priceMap.get(event.id)!;
    return sendSuccessResponse(res, 200, { payments,
        pricing: {
            originalAmount: event.appointmentOriginalAmount == null
                ? event.appointmentPriceAdjustment ? null : price.amount : paymentMoney(event.appointmentOriginalAmount),
            adjustment: event.appointmentPriceAdjustment ?? null,
            note: event.appointmentPriceAdjustmentNote ?? null,
            editable: !await getLinkedInvoiceId(schema, event.id, event.invoiceId)
                && !event.recurrence && !event.recurringEventId
                && ['CONFIRMED', 'COMPLETED'].includes(String(event.status).toUpperCase())
                && !!(event.patientId || event.patient?.id)
                && Number.isFinite(Date.parse(event.start ?? '')) && Date.parse(event.start!) <= Date.now()
        },
        summary: summarizeAppointmentPayments(price.amount, payments.map(payment => payment.get({ plain: true }))),
        patientPosition: positionMap.get(event.id) ?? null },
    'Movimenti incasso caricati');
});

export const voidAppointmentPayment = asyncHandler(async (req, res) => {
    const schema = req.tenantSchema!;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!UUID.test(req.params.agendaEventId) || !UUID.test(req.params.paymentId)) {
        return sendErrorResponse(res, 400, 'Movimento non valido');
    }
    if (reason.length < 3 || reason.length > 2000) return sendErrorResponse(res, 400, 'Indica un motivo di annullamento da 3 a 2000 caratteri');
    try {
        const result = await sequelize.transaction(async transaction => {
            const event = await AgendaEvent.schema(schema).findOne({
                where: { id: req.params.agendaEventId, ...scopeWhere(req, SCOPE) },
                transaction, lock: transaction.LOCK.UPDATE
            });
            if (!event) return fail(404, 'Appuntamento non trovato o non accessibile');
            if (await getLinkedInvoiceId(schema, event.id, event.invoiceId)) {
                fail(409, 'Incasso collegato a fattura: annulla il movimento dalla fattura');
            }
            const payment = await InvoicePayment.schema(schema).findOne({
                where: { id: req.params.paymentId, agendaEventId: event.id, invoiceId: null },
                transaction, lock: transaction.LOCK.UPDATE
            });
            if (!payment) return fail(404, 'Pagamento non trovato');
            if (payment.status === 'VOID') fail(409, 'Pagamento già annullato');
            await payment.update({ status: 'VOID', voidedAt: new Date(), voidedByUserId: getUserId(req), voidReason: reason }, { transaction });
            const summary = await syncAppointmentPaymentStatus(schema, event, transaction, getUserId(req));
            return { payment, summary, agendaEvent: event };
        });
        return sendSuccessResponse(res, 200, result, 'Registrazione annullata');
    } catch (error) {
        if (error instanceof PaymentError) return sendErrorResponse(res, error.status, error.message);
        throw error;
    }
});
