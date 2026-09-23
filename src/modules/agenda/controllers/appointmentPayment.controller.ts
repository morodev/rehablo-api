import { Request, Response } from 'express';
import { Op } from 'sequelize';
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
    AppointmentPrice, appointmentPricesByEvent, ensureAppointmentPaymentHistory, paymentMoney,
    snapshotAppointmentPrice, summarizeAppointmentPayments, syncAppointmentPaymentStatus
} from '../../invoice/services/appointmentPayment.service.js';
import { patientPaymentPositionsByReferenceEvents } from '../services/patientPaymentPosition.service.js';

const SCOPE = { ownerField: 'calendarId', structureField: 'structureId', includeUnassigned: false };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class PaymentError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
const fail = (status: number, message: string): never => { throw new PaymentError(status, message); };

interface SequentialSettlementRow {
    id: string;
    title: string;
    balance: number | null;
}

interface SequentialSettlementAllocation {
    agendaEventId: string;
    amount: number;
}

/** Guards the same oldest-first rule exposed by the UI, independently from request order. */
export function validateSequentialAppointmentAllocations(
    sequence: SequentialSettlementRow[],
    allocations: SequentialSettlementAllocation[]
): SequentialSettlementAllocation[] {
    const allocationById = new Map(allocations.map(allocation => [allocation.agendaEventId, allocation]));
    const ordered = sequence
        .filter(row => allocationById.has(row.id))
        .map(row => allocationById.get(row.id)!);
    if (ordered.length !== allocations.length) {
        fail(409, 'Una delle sedute selezionate non è più disponibile per l’incasso');
    }
    for (let index = 0; index < ordered.length; index += 1) {
        if (ordered[index].agendaEventId !== sequence[index]?.id) {
            fail(409, 'Salda prima la seduta precedente più vecchia');
        }
        const row = sequence[index];
        const amount = ordered[index].amount;
        if (row.balance === null) continue;
        if (amount > row.balance + 0.009) {
            fail(409, `L’importo supera il residuo della seduta ${row.title}`.trim());
        }
        if (amount < row.balance - 0.009 && (ordered.length === 1 || index !== ordered.length - 1)) {
            fail(409, ordered.length === 1
                ? `Per questa operazione devi saldare l’intero residuo di ${row.title}: minimo € ${row.balance.toFixed(2)}`
                : 'Salda interamente le sedute precedenti; solo l’ultima seduta selezionata può restare parzialmente aperta');
        }
    }
    return ordered;
}

function patientIdOf(event: Record<string, any>): string | null {
    const snapshot = event.patient && typeof event.patient === 'object' ? event.patient : null;
    return event.patientId ?? snapshot?.id ?? null;
}

async function completeAppointmentAfterPayment(
    event: AgendaEvent,
    userId: string,
    transaction: any
): Promise<void> {
    const update: Record<string, any> = {};
    if (String(event.status ?? '').toUpperCase() === 'CONFIRMED') {
        update.status = 'COMPLETED';
    }
    if (event.missedArrivalReportedAt && !event.missedArrivalResolvedAt) {
        update.missedArrivalResolvedAt = new Date();
        update.missedArrivalResolvedBy = userId;
        update.missedArrivalResolution = 'COMPLETED';
    }
    if (Object.keys(update).length > 0) {
        await event.update(update, { transaction });
    }
}

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
            let expected = (await appointmentPricesByEvent(schema, [event.get({ plain: true })], transaction)).get(event.id)!;
            let previous = summarizeAppointmentPayments(expected.amount, history.map(payment => payment.get({ plain: true })));
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
                const position = (await patientPaymentPositionsByReferenceEvents(
                    schema, [event.get({ plain: true })], scopeWhere(req, SCOPE),
                    { itemLimit: null, includeInvoices: false, transaction, lockRows: true }
                )).get(event.id);
                const oldestDebt = position?.items.find(item => item.kind === 'APPOINTMENT' && item.selectable);
                if (oldestDebt) fail(409, `Salda prima la seduta precedente del ${oldestDebt.date ?? 'periodo precedente'}`);
                if (expected.amount !== null && amount < (previous.balance ?? 0) - 0.009) {
                    fail(409, `Per questa operazione devi saldare l’intero residuo: minimo € ${(previous.balance ?? 0).toFixed(2)}`);
                }
                if (expected.amount === null) {
                    const finalAmount = paymentMoney(previous.paidAmount + amount);
                    await event.update({
                        appointmentExpectedAmount: finalAmount,
                        appointmentOriginalAmount: finalAmount,
                        appointmentNetAmount: null,
                        appointmentVatRate: null,
                        appointmentPriceRecordedAt: new Date(),
                        appointmentPaymentHistoryKnown: true
                    }, { transaction });
                    expected = (await appointmentPricesByEvent(schema, [event.get({ plain: true })], transaction)).get(event.id)!;
                    previous = summarizeAppointmentPayments(expected.amount, history.map(payment => payment.get({ plain: true })));
                }
                validateMovement(req.body);
                payment = await InvoicePayment.schema(schema).create({
                    invoiceId: null, agendaEventId: event.id, amount,
                    paidAt: new Date(req.body.paidAt + 'T12:00:00.000Z'),
                    method: req.body.method?.trim() || null, note: req.body.note?.trim() || null,
                    source: 'APPOINTMENT', status: 'POSTED', createdByUserId: getUserId(req)
                }, { transaction });
            }
            if (req.body?.markCompleted === true) {
                await completeAppointmentAfterPayment(event, getUserId(req), transaction);
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

/**
 * Records one physical collection as independent appointment movements. The rows stay individually
 * voidable, while creation is atomic so a multi-session allocation can never be saved halfway.
 */
export const createBulkAppointmentPayments = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    if (!UUID.test(req.params.agendaEventId)) return sendErrorResponse(res, 400, 'Appuntamento non valido');
    const rawAllocations = req.body?.allocations;
    if (!Array.isArray(rawAllocations) || rawAllocations.length < 1 || rawAllocations.length > 100) {
        return sendErrorResponse(res, 400, 'Seleziona da una a cento sedute da incassare');
    }
    const allocations = rawAllocations.map((allocation: any) => ({
        agendaEventId: String(allocation?.agendaEventId ?? ''),
        amount: paymentMoney(allocation?.amount)
    }));
    if (allocations.some(allocation => !UUID.test(allocation.agendaEventId)
        || !Number.isFinite(Number(allocation.amount)) || allocation.amount < 0.01)) {
        return sendErrorResponse(res, 400, 'Attribuzione incasso non valida');
    }
    if (new Set(allocations.map(allocation => allocation.agendaEventId)).size !== allocations.length) {
        return sendErrorResponse(res, 400, 'Ogni seduta può comparire una sola volta');
    }
    try {
        validateMovement(req.body);
        const result = await sequelize.transaction(async transaction => {
            const requestedIds = [...new Set([
                req.params.agendaEventId,
                ...allocations.map(allocation => allocation.agendaEventId)
            ])].sort();
            const events = await AgendaEvent.schema(schema).findAll({
                where: { id: { [Op.in]: requestedIds }, ...scopeWhere(req, SCOPE) },
                order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE
            });
            if (events.length !== requestedIds.length) fail(404, 'Una o più sedute non sono accessibili');
            const eventById = new Map(events.map(event => [event.id, event]));
            const reference = eventById.get(req.params.agendaEventId)!;
            const referencePatientId = patientIdOf(reference.get({ plain: true }));
            if (!referencePatientId) fail(422, 'L’incasso richiede una seduta con paziente');
            const referenceTime = Date.parse(reference.start ?? '');
            if (!Number.isFinite(referenceTime)) fail(409, 'Data della seduta non valida');
            const patientPosition = (await patientPaymentPositionsByReferenceEvents(
                schema, [reference.get({ plain: true })], scopeWhere(req, SCOPE),
                { itemLimit: null, includeInvoices: false, transaction, lockRows: true }
            )).get(reference.id);

            const histories = new Map<string, InvoicePayment[]>();
            for (const allocation of allocations) {
                const event = eventById.get(allocation.agendaEventId)!;
                const plain = event.get({ plain: true }) as Record<string, any>;
                if (patientIdOf(plain) !== referencePatientId) fail(409, 'Le sedute selezionate devono appartenere allo stesso paziente');
                const start = Date.parse(event.start ?? '');
                if (!Number.isFinite(start) || start > Date.now() || start > referenceTime) {
                    fail(409, 'Sono selezionabili soltanto la seduta corrente e quelle precedenti');
                }
                if (event.recurrence || event.recurringEventId) fail(422, 'Separa le singole occorrenze prima di registrare gli incassi');
                if (!['CONFIRMED', 'COMPLETED'].includes(String(event.status ?? '').toUpperCase())) {
                    fail(409, 'Una delle sedute selezionate non può ricevere incassi');
                }
                if (event.appointmentPriceAdjustment === 'COMPLIMENTARY') fail(409, 'Una seduta omaggio non può ricevere incassi');
                if (await getLinkedInvoiceId(schema, event.id, event.invoiceId)) {
                    fail(409, 'Una seduta selezionata è già fatturata: gestisci il pagamento dalla fattura');
                }
                const history = await ensureAppointmentPaymentHistory(schema, event, transaction);
                if (!event.appointmentPaymentHistoryKnown && history.length === 0) {
                    fail(409, 'Una seduta storica richiede una verifica prima di registrare l’incasso');
                }
                histories.set(event.id, history);
                if (event.appointmentExpectedAmount == null) {
                    await event.update(await snapshotAppointmentPrice(schema, plain, transaction), { transaction });
                }
            }

            const pricing = req.body?.pricing;
            if (pricing !== undefined) {
                if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) fail(400, 'Prezzo non valido');
                if (pricing.note != null && (typeof pricing.note !== 'string' || pricing.note.length > 2000)) {
                    fail(400, 'La nota può contenere al massimo 2000 caratteri');
                }
                const history = histories.get(reference.id)
                    ?? await ensureAppointmentPaymentHistory(schema, reference, transaction);
                const price = (await appointmentPricesByEvent(schema, [reference.get({ plain: true })], transaction)).get(reference.id)!;
                const original = reference.appointmentOriginalAmount == null
                    ? reference.appointmentPriceAdjustment ? null : price.amount
                    : paymentMoney(reference.appointmentOriginalAmount);
                const paid = summarizeAppointmentPayments(price.amount, history.map(payment => payment.get({ plain: true }))).paidAmount;
                const adjusted = resolveAppointmentAdjustment(original, pricing.adjustment, pricing.discountAmount, paid, price.vatRate);
                await reference.update({
                    appointmentOriginalAmount: original,
                    appointmentPriceAdjustment: adjusted.adjustment,
                    appointmentExpectedAmount: adjusted.amount,
                    appointmentNetAmount: adjusted.netAmount,
                    appointmentPriceAdjustmentNote: pricing.note?.trim() || null,
                    appointmentPriceAdjustedBy: getUserId(req), appointmentPriceAdjustedAt: new Date(),
                    appointmentPriceRecordedAt: new Date(), appointmentPaymentHistoryKnown: true
                }, { transaction });
            }

            const prepared = [] as Array<{
                allocation: SequentialSettlementAllocation;
                event: AgendaEvent;
                history: InvoicePayment[];
                price: AppointmentPrice;
                previous: ReturnType<typeof summarizeAppointmentPayments>;
            }>;
            for (const allocation of allocations) {
                const event = eventById.get(allocation.agendaEventId)!;
                const history = histories.get(event.id)!;
                const price = (await appointmentPricesByEvent(schema, [event.get({ plain: true })], transaction)).get(event.id)!;
                const previous = summarizeAppointmentPayments(price.amount, history.map(payment => payment.get({ plain: true })));
                if (price.amount !== null && allocation.amount > (previous.balance ?? 0) + 0.009) {
                    fail(409, `L’importo supera il residuo della seduta ${event.title || ''}`.trim());
                }
                prepared.push({ allocation, event, history, price, previous });
            }
            const preparedById = new Map(prepared.map(item => [item.event.id, item]));
            const priorityRows: SequentialSettlementRow[] = (patientPosition?.items ?? [])
                .filter(item => item.kind === 'APPOINTMENT' && item.selectable && item.agendaEventId)
                .map(item => ({ id: item.agendaEventId!, title: item.title, balance: item.balance }));
            priorityRows.push({
                id: reference.id,
                title: reference.title || 'Seduta corrente',
                balance: preparedById.get(reference.id)?.previous.balance ?? null
            });
            prepared.forEach(item => {
                const row = priorityRows.find(candidate => candidate.id === item.event.id);
                if (row) row.balance = item.previous.balance;
            });
            const orderedAllocations = validateSequentialAppointmentAllocations(priorityRows, allocations);

            const created: Array<{payment: InvoicePayment; summary: any; agendaEvent: Record<string, any>}> = [];
            for (const allocation of orderedAllocations) {
                const preparedItem = preparedById.get(allocation.agendaEventId)!;
                const { event, history, previous } = preparedItem;
                let { price } = preparedItem;
                if (price.amount === null) {
                    const finalAmount = paymentMoney(previous.paidAmount + allocation.amount);
                    await event.update({
                        appointmentExpectedAmount: finalAmount,
                        appointmentOriginalAmount: finalAmount,
                        appointmentNetAmount: null,
                        appointmentVatRate: null,
                        appointmentPriceRecordedAt: new Date(),
                        appointmentPaymentHistoryKnown: true
                    }, { transaction });
                    price = (await appointmentPricesByEvent(schema, [event.get({ plain: true })], transaction)).get(event.id)!;
                }
                const payment = await InvoicePayment.schema(schema).create({
                    invoiceId: null, agendaEventId: event.id, amount: allocation.amount,
                    paidAt: new Date(req.body.paidAt + 'T12:00:00.000Z'),
                    method: req.body.method?.trim() || null, note: req.body.note?.trim() || null,
                    source: 'APPOINTMENT', status: 'POSTED', createdByUserId: getUserId(req)
                }, { transaction });
                if (req.body?.markReferenceCompleted === true && event.id === reference.id) {
                    await completeAppointmentAfterPayment(event, getUserId(req), transaction);
                }
                const summary = await syncAppointmentPaymentStatus(schema, event, transaction, getUserId(req));
                created.push({ payment, summary, agendaEvent: {
                    ...event.get({ plain: true }),
                    appointmentExpectedAmount: price.amount,
                    appointmentPriceSource: price.source
                } });
            }
            const referenceResult = created.find(item => item.agendaEvent.id === reference.id);
            const referenceHistory = histories.get(reference.id)
                ?? await ensureAppointmentPaymentHistory(schema, reference, transaction);
            const referencePrice = (await appointmentPricesByEvent(schema, [reference.get({ plain: true })], transaction)).get(reference.id)!;
            const referenceSummary = referenceResult?.summary
                ?? summarizeAppointmentPayments(referencePrice.amount, referenceHistory.map(payment => payment.get({ plain: true })));
            return {
                allocations: created,
                referenceSummary,
                referenceAgendaEvent: referenceResult?.agendaEvent ?? {
                    ...reference.get({ plain: true }),
                    appointmentExpectedAmount: referencePrice.amount,
                    appointmentPriceSource: referencePrice.source
                }
            };
        });
        return sendSuccessResponse(res, 201, result, allocations.length === 1
            ? 'Incasso registrato' : `${allocations.length} incassi registrati`);
    } catch (error) {
        if (error instanceof AppointmentAdjustmentError) return sendErrorResponse(res, 400, error.message);
        if (error instanceof PaymentError) return sendErrorResponse(res, error.status, error.message);
        throw error;
    }
});

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
        patientPaymentPositionsByReferenceEvents(schema, [plainEvent], scopeWhere(req, SCOPE), {
            itemLimit: null,
            includeInvoices: canReadFinance
        })
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
            if (payment.status !== 'POSTED') fail(409, 'Pagamento già annullato o trasferito a credito');
            if (payment.source === 'PACKAGE') fail(409, 'La copertura da pacchetto non è uno storno di incasso');
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
