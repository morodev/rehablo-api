import {createHash, randomUUID} from 'node:crypto';
import {Request} from 'express';
import {Op, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {getUserId} from '../../../middleware/rbac.js';
import {canAccessAppointmentFinance} from '../../agenda/services/appointmentFinancialAccess.service.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import {PatientCredit} from '../../administration/models/index.js';
import {PatientCreditMovement} from '../../administration/models/patientCreditMovement.model.js';
import {validateTreasuryAccount, validateTreasuryMethod} from '../../administration/services/treasuryValidation.service.js';
import {InvoicePaymentCreateOptions} from '../../administration/services/invoicePaymentTreasury.service.js';
import {appointmentPricesByEvent, ensureAppointmentPaymentHistory, isValidPaymentDate, paymentMoney,
    appointmentPriceFields, syncAppointmentPaymentStatus, isAppointmentPaymentHistoryKnown} from '../../invoice/services/appointmentPayment.service.js';
import {syncInvoicePaymentStatus} from '../../invoice/services/payment.service.js';
import {AppointmentAdjustmentError, AppointmentPricingInput, resolveAppointmentPricing} from '../../invoice/utils/appointmentAdjustment.js';
import {getLinkedInvoiceId} from '../../invoice/services/invoiceAgendaEvent.service.js';
import {PatientSettlementOperation} from '../models/patientSettlementOperation.model.js';
import {PatientSettlementAllocation, PatientSettlementObligation, loadPatientSettlementPosition,
    lockPatientSettlement, settlementFail, validatePatientSettlementAllocations} from './patientSettlementPolicy.service.js';
import {AuthorizedSettlementContext, SETTLEMENT_UUID, patientSettlementPositionView, resolvePatientSettlementContext,
    settlementAdministrationEnabled, settlementCanCash, settlementCanRead, settlementCanUseCredit,
    settlementRecordAccess, verifiedSettlementCredit} from './patientSettlementAccess.service.js';

export interface PatientSettlementOpeningBalance {
    agendaEventId: string;
    expectedAmount?: number;
    previouslyPaidAmount: number;
    paidAt: string | null;
    method: string | null;
}
export interface PatientSettlementRequest {
    referenceAgendaEventId?: string;
    referenceInvoiceId?: string;
    structureId?: string;
    allocations: PatientSettlementAllocation[];
    credits: Array<{creditId: string; amount: number}>;
    cash: {amount: number; paidAt: string | null; method: string | null; note: string | null;
        accountId: string | null; paymentMethodId: string | null};
    completeReference: boolean;
    pricing?: AppointmentPricingInput;
    openingBalances: PatientSettlementOpeningBalance[];
}
interface SettlementOpeningBalanceResult {
    agendaEventId: string;
    paymentId: string | null;
    before: {expectedAmount: number | null; paidAmount: number; historyKnown: boolean};
    after: {expectedAmount: number; paidAmount: number; historyKnown: true};
    priceDefined: boolean;
}
interface SettlementOperationResult {
    cashAmount: number; creditAmount: number;
    allocations: Array<{kind: 'APPOINTMENT' | 'INVOICE'; targetId: string; paymentIds: string[]; creditMovementIds: string[]}>;
    agendaEventIds: string[]; invoiceIds: string[];
    openingBalances?: SettlementOpeningBalanceResult[];
}

const amount = (value: unknown, allowZero = false): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value > 99999999.99 || value < (allowZero ? 0 : 0.01)
        || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) settlementFail(400, 'Inserisci importi validi con al massimo due decimali');
    return paymentMoney(value);
};
const note = (value: unknown, max = 2000): string | null => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || value.length > max) settlementFail(400, 'Metodo o nota non validi');
    return value.trim() || null;
};
const optionalUuid = (value: unknown): string | undefined => {
    if (value == null || value === '') return undefined;
    if (typeof value !== 'string' || !SETTLEMENT_UUID.test(value)) settlementFail(400, 'Identificativo non valido');
    return value;
};

export function normalizePatientSettlementRequest(body: Record<string, any>): PatientSettlementRequest {
    if (body.referenceOccurrenceStart != null) settlementFail(400, 'La data dell’occorrenza è ammessa soltanto nella consultazione');
    if (body.openingBalances != null && !Array.isArray(body.openingBalances)) settlementFail(400, 'Dati precedenti della seduta non validi');
    const openingBalances: PatientSettlementOpeningBalance[] = (body.openingBalances ?? []).map((row: any) => {
        if (!row || !optionalUuid(row.agendaEventId)) settlementFail(400, 'Seduta precedente non valida');
        const previouslyPaidAmount = amount(row.previouslyPaidAmount, true);
        const paidAt = row.paidAt ?? null;
        if (paidAt !== null && (!previouslyPaidAmount || !isValidPaymentDate(paidAt))) settlementFail(400, 'Inserisci una data precedente valida e non futura');
        return {agendaEventId: row.agendaEventId,
            ...(row.expectedAmount !== undefined ? {expectedAmount: amount(row.expectedAmount)} : {}),
            previouslyPaidAmount, paidAt, method: previouslyPaidAmount ? note(row.method, 255) : null};
    }).sort((a: PatientSettlementOpeningBalance, b: PatientSettlementOpeningBalance) => a.agendaEventId.localeCompare(b.agendaEventId));
    if (openingBalances.length > 100 || new Set(openingBalances.map(row => row.agendaEventId)).size !== openingBalances.length) {
        settlementFail(400, 'Ogni seduta precedente può comparire una sola volta, fino a cento sedute');
    }
    if (!Array.isArray(body.allocations) || body.allocations.length > 100 || (!body.allocations.length && !openingBalances.length)) {
        settlementFail(400, 'Seleziona da una a cento righe da saldare o completa i dati precedenti');
    }
    const allocations = body.allocations.map((row: any) => {
        if (!row || !['APPOINTMENT', 'INVOICE'].includes(row.kind) || !optionalUuid(row.targetId)) settlementFail(400, 'Attribuzione del saldo non valida');
        return {kind: row.kind as 'APPOINTMENT' | 'INVOICE', targetId: row.targetId, amount: amount(row.amount)};
    }).sort((a: PatientSettlementAllocation, b: PatientSettlementAllocation) => `${a.kind}:${a.targetId}`.localeCompare(`${b.kind}:${b.targetId}`));
    if (new Set(allocations.map((row: PatientSettlementAllocation) => `${row.kind}:${row.targetId}`)).size !== allocations.length) settlementFail(400, 'Ogni obbligo può comparire una sola volta');
    if (body.credits != null && !Array.isArray(body.credits)) settlementFail(400, 'Selezione del credito non valida');
    const credits = (body.credits ?? []).map((row: any) => {
        if (!row || !optionalUuid(row.creditId)) settlementFail(400, 'Credito non valido');
        return {creditId: row.creditId as string, amount: amount(row.amount)};
    }).sort((a: {creditId: string}, b: {creditId: string}) => a.creditId.localeCompare(b.creditId));
    if (credits.length > 100 || new Set(credits.map((row: {creditId: string}) => row.creditId)).size !== credits.length) settlementFail(400, 'Selezione del credito non valida');
    const cash = body.cash == null ? {} : body.cash;
    if (typeof cash !== 'object' || Array.isArray(cash)) settlementFail(400, 'Dati dell’incasso non validi');
    const cashAmount = cash.amount == null ? 0 : amount(cash.amount, true);
    const paidAt = cashAmount > 0 ? cash.paidAt : null;
    if (cashAmount > 0 && !isValidPaymentDate(paidAt)) settlementFail(400, 'Inserisci una data di incasso valida e non futura');
    const accountId = optionalUuid(cash.accountId) ?? null;
    const paymentMethodId = optionalUuid(cash.paymentMethodId) ?? null;
    const total = paymentMoney(allocations.reduce((sum: number, row: PatientSettlementAllocation) => sum + row.amount, 0));
    if (Math.abs(total - paymentMoney(cashAmount + credits.reduce((sum: number, row: {amount: number}) => sum + row.amount, 0))) > 0.009) {
        settlementFail(400, 'Credito e nuovo denaro devono corrispondere al totale attribuito');
    }
    const result: PatientSettlementRequest = {referenceAgendaEventId: optionalUuid(body.referenceAgendaEventId),
        referenceInvoiceId: optionalUuid(body.referenceInvoiceId), structureId: optionalUuid(body.structureId), allocations, credits,
        cash: {amount: cashAmount, paidAt, method: note(cash.method, 255), note: note(cash.note), accountId, paymentMethodId},
        completeReference: body.completeReference === true, openingBalances};
    if (body.pricing != null) {
        const pricing = body.pricing;
        if (typeof pricing !== 'object' || Array.isArray(pricing) || ![null, 'DISCOUNT', 'COMPLIMENTARY'].includes(pricing.adjustment)) settlementFail(400, 'Prezzo non valido');
        if (pricing.confirmHistory !== undefined && typeof pricing.confirmHistory !== 'boolean') settlementFail(400, 'La conferma dello storico non è valida');
        result.pricing = {...(pricing.baseAmount !== undefined ? {baseAmount: amount(pricing.baseAmount)} : {}),
            ...(pricing.confirmHistory !== undefined ? {confirmHistory: pricing.confirmHistory} : {}), adjustment: pricing.adjustment,
            discountAmount: pricing.adjustment === 'DISCOUNT' ? amount(pricing.discountAmount) : null, note: note(pricing.note)};
    }
    if (result.pricing && openingBalances.some(row => row.agendaEventId === result.referenceAgendaEventId)) {
        settlementFail(400, 'Completa il prezzo nei dati precedenti della seduta');
    }
    return result;
}

/** Source rights are independent: quote:update can cover a readable target without cash update. */
export function settlementFundingPlan(rows: Array<{key: string; amount: number; canCash: boolean; canUseCredit: boolean}>,
    creditAmount: number): Map<string, {cash: number; credit: number}> {
    const requiredCredit = paymentMoney(rows.filter(row => !row.canCash).reduce((sum, row) => sum + row.amount, 0));
    if (requiredCredit > creditAmount + 0.009 || rows.some(row => !row.canCash && !row.canUseCredit)) {
        settlementFail(403, 'Non hai il permesso di registrare denaro su uno degli obblighi: serve una copertura autorizzata sufficiente');
    }
    const creditCapacity = paymentMoney(rows.filter(row => row.canUseCredit).reduce((sum, row) => sum + row.amount, 0));
    if (creditAmount > creditCapacity + 0.009) settlementFail(403, 'Il credito selezionato supera gli obblighi su cui puoi applicarlo');
    let remainder = paymentMoney(creditAmount - requiredCredit);
    return new Map(rows.map(row => {
        const credit = paymentMoney(!row.canCash ? row.amount : row.canUseCredit ? Math.min(row.amount, remainder) : 0);
        if (row.canCash && row.canUseCredit) remainder = paymentMoney(remainder - credit);
        return [row.key, {credit, cash: paymentMoney(row.amount - credit)}];
    }));
}

async function applyPricing(req: Request, context: AuthorizedSettlementContext, request: PatientSettlementRequest,
    events: Map<string, AgendaEvent>, transaction: Transaction): Promise<void> {
    if (!request.pricing) return;
    const event = events.get(context.referenceAgendaEventId ?? '');
    if (!event || !canAccessAppointmentFinance(req, event.get({plain: true}), 'appointment_pricing', 'update')) settlementFail(403, 'Non puoi modificare il prezzo della seduta');
    if (await getLinkedInvoiceId(req.tenantSchema!, event.id, event.invoiceId)
        || (event.carePackageId && ['RESERVED', 'CONSUMED'].includes(String(event.packageReservationStatus)))
        || event.recurrence || event.recurringEventId || !['CONFIRMED', 'COMPLETED'].includes(String(event.status).toUpperCase())
        || !Number.isFinite(Date.parse(event.start ?? '')) || Date.parse(event.start!) > Date.now()) settlementFail(409, 'Il prezzo della seduta non è modificabile');
    const price = (await appointmentPricesByEvent(req.tenantSchema!, [event.get({plain: true})], transaction)).get(event.id)!;
    const history = await ensureAppointmentPaymentHistory(req.tenantSchema!, event, transaction);
    const original = event.appointmentOriginalAmount == null ? event.appointmentPriceAdjustment || price.estimated ? null : price.amount : paymentMoney(event.appointmentOriginalAmount);
    const paid = paymentMoney(history.filter(row => row.status === 'POSTED').reduce((sum, row) => sum + Number(row.amount), 0));
    let adjusted: ReturnType<typeof resolveAppointmentPricing>;
    try {adjusted = resolveAppointmentPricing(original, request.pricing, paid, price.estimated ? null : price.vatRate, isAppointmentPaymentHistoryKnown(event.get({plain: true}), history));}
    catch (error) {if (error instanceof AppointmentAdjustmentError) settlementFail(error.status, error.message); throw error;}
    await event.update({appointmentOriginalAmount: adjusted.originalAmount, appointmentPriceAdjustment: adjusted.adjustment,
        appointmentExpectedAmount: adjusted.amount, appointmentNetAmount: adjusted.netAmount,
        appointmentPriceAdjustmentNote: request.pricing.note, appointmentPriceAdjustedBy: getUserId(req),
        appointmentPriceAdjustedAt: new Date(), appointmentPriceRecordedAt: new Date(), appointmentPaymentHistoryKnown: adjusted.historyKnown}, {transaction});
}

async function applyOpeningBalances(req: Request, context: AuthorizedSettlementContext, request: PatientSettlementRequest,
    events: Map<string, AgendaEvent>, transaction: Transaction): Promise<SettlementOpeningBalanceResult[]> {
    const completed: SettlementOpeningBalanceResult[] = [];
    for (const opening of request.openingBalances) {
        const event = events.get(opening.agendaEventId)!;
        const plain = event.get({plain: true});
        if (!settlementRecordAccess(req, context, 'APPOINTMENT', plain, 'update')) {
            settlementFail(403, 'Non puoi completare gli incassi precedenti della seduta');
        }
        const history = await InvoicePayment.schema(req.tenantSchema!).findAll({where: {agendaEventId: event.id}, transaction});
        if (isAppointmentPaymentHistoryKnown(plain, history)) settlementFail(409, 'I dati della seduta sono cambiati: aggiorna la posizione');
        if (!['CONFIRMED', 'COMPLETED'].includes(String(event.status).toUpperCase())
            || event.recurrence || event.recurringEventId
            || !Number.isFinite(Date.parse(event.start ?? '')) || Date.parse(event.start!) > Date.now()
            || event.appointmentPriceAdjustment === 'COMPLIMENTARY') {
            settlementFail(409, 'I dati precedenti non sono disponibili per questa seduta');
        }
        const reverseInvoices = await Invoice.schema(req.tenantSchema!).findAll({where: {agendaEventId: event.id}, transaction});
        if (await getLinkedInvoiceId(req.tenantSchema!, event.id, event.invoiceId)
            || reverseInvoices.some(invoice => String(invoice.status).toLowerCase() !== 'void')) {
            settlementFail(409, 'La seduta è collegata a una fattura: aggiorna la posizione');
        }
        const finalSnapshot = event.appointmentExpectedAmount == null ? null : paymentMoney(event.appointmentExpectedAmount);
        if (finalSnapshot !== null && opening.expectedAmount !== undefined && Math.abs(finalSnapshot - opening.expectedAmount) > 0.009) {
            settlementFail(409, 'Il prezzo della seduta è cambiato: aggiorna la posizione');
        }
        const expectedAmount = finalSnapshot ?? opening.expectedAmount;
        if (expectedAmount === undefined || expectedAmount === null || expectedAmount <= 0) settlementFail(400, 'Definisci il prezzo definitivo della seduta');
        const priceDefined = finalSnapshot === null;
        if (priceDefined && !canAccessAppointmentFinance(req, plain, 'appointment_pricing', 'update')) {
            settlementFail(403, 'Non puoi definire il prezzo della seduta');
        }
        if (opening.previouslyPaidAmount > expectedAmount + 0.009) settlementFail(400, 'Gli incassi precedenti superano il prezzo della seduta');
        const before = {expectedAmount: finalSnapshot, paidAmount: paymentMoney(event.appointmentPaidAmount), historyKnown: false};
        await event.update({...(priceDefined ? {
            ...appointmentPriceFields({amount: expectedAmount, netAmount: null, vatRate: null, source: 'SNAPSHOT', estimated: false}),
            appointmentOriginalAmount: expectedAmount, appointmentPriceAdjustedBy: getUserId(req), appointmentPriceAdjustedAt: new Date()} : {}),
            appointmentPaymentHistoryKnown: true}, {transaction});
        let paymentId: string | null = null;
        if (opening.previouslyPaidAmount > 0) {
            const payment = await InvoicePayment.schema(req.tenantSchema!).create({id: randomUUID(), invoiceId: null,
                agendaEventId: event.id, amount: opening.previouslyPaidAmount, paidAt: opening.paidAt ? new Date(opening.paidAt + 'T12:00:00.000Z') : null,
                method: opening.method, source: 'OPENING_BALANCE', status: 'POSTED', createdByUserId: getUserId(req)}, {transaction});
            paymentId = payment.id;
        }
        await syncAppointmentPaymentStatus(req.tenantSchema!, event, transaction, getUserId(req));
        completed.push({agendaEventId: event.id, paymentId, before,
            after: {expectedAmount, paidAmount: opening.previouslyPaidAmount, historyKnown: true}, priceDefined});
    }
    return completed;
}

async function responseForOperation(req: Request, context: AuthorizedSettlementContext, operationId: string,
    result: SettlementOperationResult, replayed: boolean, transaction: Transaction) {
    const [events, invoices] = await Promise.all([
        result.agendaEventIds.length ? AgendaEvent.schema(req.tenantSchema!).findAll({where: {id: {[Op.in]: result.agendaEventIds}}, transaction}) : Promise.resolve([]),
        result.invoiceIds.length ? Invoice.schema(req.tenantSchema!).findAll({where: {id: {[Op.in]: result.invoiceIds}}, transaction}) : Promise.resolve([])
    ]);
    const invoiceViews: Array<Record<string, any>> = [];
    for (const invoice of invoices) {
        const summary = await syncInvoicePaymentStatus(req.tenantSchema!, invoice.id, transaction);
        invoiceViews.push({id: invoice.id, ...summary, documentNumber: invoice.documentNumber, documentYear: invoice.documentYear});
    }
    return {operationId, replayed, cashAmount: result.cashAmount, creditAmount: result.creditAmount, allocations: result.allocations,
        openingBalances: result.openingBalances ?? [], agendaEvents: events.map(event => event.get({plain: true})), invoices: invoiceViews,
        position: await patientSettlementPositionView(req, context, {transaction})};
}

export async function executePatientSettlement(req: Request) {
    const request = normalizePatientSettlementRequest(req.body ?? {});
    const idempotencyKey = String(req.header('Idempotency-Key') ?? '').trim();
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(idempotencyKey)) settlementFail(400, 'Identificativo della registrazione obbligatorio e non valido');
    const schema = req.tenantSchema!;
    const initialContext = await resolvePatientSettlementContext(req, request);
    // Keep the retry identity of requests recorded before opening balances were supported.
    const {openingBalances: openingFingerprint, ...existingFingerprint} = request;
    const requestHash = createHash('sha256').update(JSON.stringify({patientId: initialContext.patientId,
        structureId: initialContext.structureId, ...existingFingerprint,
        ...(openingFingerprint.length ? {openingBalances: openingFingerprint} : {})})).digest('hex');
    return sequelize.transaction(async transaction => {
        await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', {
            transaction, replacements: {lockKey: `${schema}:settlement-operation:${idempotencyKey}`}
        });
        await lockPatientSettlement(schema, initialContext.patientId, transaction);
        const context = await resolvePatientSettlementContext(req, request, transaction);
        if (context.structureId !== initialContext.structureId) settlementFail(409, 'La sede del riferimento è cambiata: aggiorna la posizione');
        const Operations = PatientSettlementOperation.schema(schema);
        const existing = await Operations.findOne({where: {idempotencyKey}, transaction});
        const administrationEnabled = await settlementAdministrationEnabled(req, transaction);
        if (existing) {
            if (existing.get('patientId') !== context.patientId || existing.get('structureId') !== context.structureId
                || existing.get('createdByUserId') !== getUserId(req) || existing.get('requestHash') !== requestHash) settlementFail(409, 'Questa registrazione è già stata usata con dati diversi');
            const raw = await loadPatientSettlementPosition(schema, context, {transaction});
            // Paid rows can disappear from the queue; authorize the persisted targets directly.
            for (const allocation of request.allocations) {
                const model = allocation.kind === 'APPOINTMENT' ? await AgendaEvent.schema(schema).findByPk(allocation.targetId, {transaction})
                    : await Invoice.schema(schema).findByPk(allocation.targetId, {transaction});
                if (!model || !settlementRecordAccess(req, context, allocation.kind, model.get({plain: true}), 'read')
                    || (request.cash.amount > 0 && !settlementRecordAccess(req, context, allocation.kind, model.get({plain: true}), 'update'))
                    || (request.pricing && allocation.kind === 'APPOINTMENT' && !canAccessAppointmentFinance(req, model.get({plain: true}), 'appointment_pricing', 'update'))) settlementFail(403, 'La registrazione non è più accessibile');
            }
            for (const opening of request.openingBalances) {
                const model = await AgendaEvent.schema(schema).findByPk(opening.agendaEventId, {transaction});
                const priceDefined = (existing.get('result') as SettlementOperationResult).openingBalances?.find(row => row.agendaEventId === opening.agendaEventId)?.priceDefined;
                if (!model || (model.patientId ?? model.patient?.id) !== context.patientId
                    || (model.structureId ?? context.structureId) !== context.structureId
                    || !settlementRecordAccess(req, context, 'APPOINTMENT', model.get({plain: true}), 'read')
                    || !settlementRecordAccess(req, context, 'APPOINTMENT', model.get({plain: true}), 'update')
                    || (priceDefined && !canAccessAppointmentFinance(req, model.get({plain: true}), 'appointment_pricing', 'update'))) {
                    settlementFail(403, 'La registrazione non è più accessibile');
                }
            }
            if (request.credits.length && (!administrationEnabled || !settlementRecordAccess(req, context, 'CREDIT', {structureId: context.structureId}, 'update'))) settlementFail(403, 'La registrazione non è più accessibile');
            void raw;
            return responseForOperation(req, context, String(existing.get('id')), existing.get('result') as SettlementOperationResult, true, transaction);
        }
        const invoiceIds = request.allocations.filter(row => row.kind === 'INVOICE').map(row => row.targetId).sort();
        const eventIds = [...new Set([...request.allocations.filter(row => row.kind === 'APPOINTMENT').map(row => row.targetId),
            ...request.openingBalances.map(row => row.agendaEventId),
            ...(request.pricing && context.referenceAgendaEventId ? [context.referenceAgendaEventId] : [])])].sort();
        const invoiceModels = invoiceIds.length ? await Invoice.schema(schema).findAll({where: {id: {[Op.in]: invoiceIds}}, order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE}) : [];
        const eventModels = eventIds.length ? await AgendaEvent.schema(schema).findAll({where: {id: {[Op.in]: eventIds}}, order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE}) : [];
        if (invoiceModels.length !== invoiceIds.length || eventModels.length !== eventIds.length) settlementFail(404, 'Uno degli obblighi non è disponibile');
        const events = new Map(eventModels.map(event => [event.id, event]));
        const invoices = new Map(invoiceModels.map(invoice => [invoice.id, invoice]));
        for (const event of eventModels) {
            const plain = event.get({plain: true});
            if (plain.carePackageId && ['RESERVED', 'CONSUMED'].includes(String(plain.packageReservationStatus))) settlementFail(409, 'La seduta è inclusa nel pacchetto: gestisci il saldo dall’acquisto');
            if ((plain.patientId ?? plain.patient?.id) !== context.patientId || (plain.structureId ?? context.structureId) !== context.structureId
                || !settlementRecordAccess(req, context, 'APPOINTMENT', plain, 'read')) settlementFail(404, 'Uno degli obblighi non è accessibile');
        }
        for (const invoice of invoiceModels) {
            if (invoice.patientID !== context.patientId || (invoice.structureId ?? context.structureId) !== context.structureId
                || !settlementRecordAccess(req, context, 'INVOICE', invoice.get({plain: true}), 'read')) settlementFail(404, 'Uno degli obblighi non è accessibile');
        }
        const openingBalances = await applyOpeningBalances(req, context, request, events, transaction);
        for (const event of eventModels) {
            await ensureAppointmentPaymentHistory(schema, event, transaction);
        }
        await applyPricing(req, context, request, events, transaction);
        const position = await loadPatientSettlementPosition(schema, context, {transaction});
        if (request.pricing && position.current?.kind === 'INVOICE') settlementFail(409, 'La seduta è già fatturata: il prezzo non è modificabile');
        const ordered = request.allocations.length ? validatePatientSettlementAllocations(position.queue, request.allocations) : [];
        const selected = ordered.map(allocation => position.queue.find(row => row.key === `${allocation.kind}:${allocation.targetId}`)!);
        if (selected.some(row => !settlementCanRead(req, context, row))) settlementFail(403, 'Un obbligo precedente richiede un operatore autorizzato');
        const creditAmount = paymentMoney(request.credits.reduce((sum, credit) => sum + credit.amount, 0));
        const plan = settlementFundingPlan(selected.map((row, index) => ({key: row.key, amount: ordered[index].amount,
            canCash: settlementCanCash(req, context, row), canUseCredit: settlementCanUseCredit(req, context, row, administrationEnabled)})), creditAmount);
        if (request.credits.length && !administrationEnabled) settlementFail(403, 'Il modulo Amministrazione non è attivo');
        const credits = request.credits.length ? await PatientCredit.schema(schema).findAll({where: {id: {[Op.in]: request.credits.map(row => row.creditId)}},
            order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE}) : [];
        if (credits.length !== request.credits.length) settlementFail(404, 'Uno dei crediti non è disponibile');
        const preparedCredits = request.credits.map(use => ({use, model: credits.find(model => model.get('id') === use.creditId)!, left: use.amount}));
        for (const prepared of preparedCredits) {
            const credit = prepared.model.get({plain: true});
            if (credit.patientId !== context.patientId || credit.structureId !== context.structureId
                || !settlementRecordAccess(req, context, 'CREDIT', credit, 'read')
                || !settlementRecordAccess(req, context, 'CREDIT', credit, 'update')) settlementFail(404, 'Credito non accessibile');
            if (credit.status !== 'ACTIVE' || Number(credit.remainingAmount) + 0.009 < prepared.use.amount) settlementFail(409, 'Credito residuo insufficiente');
            if (!await verifiedSettlementCredit(schema, credit, transaction)) settlementFail(409, 'Il credito storico non è riconciliato con un incasso');
        }
        let method = request.cash.method;
        if (request.cash.paymentMethodId) {
            const selectedMethod = await validateTreasuryMethod(schema, request.cash.paymentMethodId, transaction);
            if (!selectedMethod) settlementFail(400, 'Metodo di pagamento non disponibile');
            method = String(selectedMethod.get('label'));
        }
        if (request.cash.accountId) await validateTreasuryAccount(schema, request.cash.accountId, context.structureId, transaction);
        const operationId = randomUUID();
        const result: SettlementOperationResult = {cashAmount: request.cash.amount, creditAmount, allocations: [],
            agendaEventIds: openingBalances.map(row => row.agendaEventId), invoiceIds: [], openingBalances};
        for (let index = 0; index < ordered.length; index++) {
            const allocation = ordered[index];
            const row = selected[index];
            const split = plan.get(row.key)!;
            const entry = {kind: allocation.kind, targetId: allocation.targetId, paymentIds: [] as string[], creditMovementIds: [] as string[]};
            if (row.kind === 'APPOINTMENT' && row.expectedAmount === null) {
                if (!canAccessAppointmentFinance(req, row.record, 'appointment_pricing', 'update')) settlementFail(403, 'Il prezzo deve essere definito da un operatore autorizzato');
                const finalAmount = paymentMoney(row.paidAmount + allocation.amount);
                await events.get(row.targetId)!.update({
                    ...appointmentPriceFields({amount: finalAmount, netAmount: null, vatRate: null, source: 'SNAPSHOT', estimated: false}),
                    appointmentOriginalAmount: finalAmount, appointmentPaymentHistoryKnown: true}, {transaction});
            }
            let creditLeft = split.credit;
            for (const credit of preparedCredits) {
                const use = paymentMoney(Math.min(creditLeft, credit.left));
                if (!use) continue;
                const payment = await InvoicePayment.schema(schema).create({id: randomUUID(),
                    invoiceId: row.kind === 'INVOICE' ? row.targetId : null, agendaEventId: row.kind === 'APPOINTMENT' ? row.targetId : null,
                    carePackageId: row.kind === 'INVOICE' ? invoices.get(row.targetId)?.carePackageId ?? null : null,
                    amount: use, paidAt: new Date(), method: 'Credito paziente', note: request.cash.note,
                    source: 'CREDIT', status: 'POSTED', createdByUserId: getUserId(req)}, {transaction});
                const movementId = randomUUID();
                const movement = await PatientCreditMovement.schema(schema).create({id: movementId, creditId: credit.use.creditId,
                    type: `APPLY_${row.kind}`, amount: use, targetId: row.targetId, invoicePaymentId: payment.id,
                    idempotencyKey: `settlement_${operationId}_${movementId}`, createdByUserId: getUserId(req)}, {transaction});
                entry.paymentIds.push(payment.id); entry.creditMovementIds.push(String(movement.get('id')));
                credit.left = paymentMoney(credit.left - use); creditLeft = paymentMoney(creditLeft - use);
            }
            if (split.cash > 0) {
                const paymentId = randomUUID();
                const options: InvoicePaymentCreateOptions = {transaction, treasuryContext: {
                    accountId: request.cash.accountId ?? undefined, structureId: context.structureId,
                    paymentMethodId: request.cash.paymentMethodId, idempotencyKey: `settlement_${operationId}_${paymentId}`}};
                const payment = await InvoicePayment.schema(schema).create({id: paymentId,
                    invoiceId: row.kind === 'INVOICE' ? row.targetId : null, agendaEventId: row.kind === 'APPOINTMENT' ? row.targetId : null,
                    carePackageId: row.kind === 'INVOICE' ? invoices.get(row.targetId)?.carePackageId ?? null : null,
                    amount: split.cash, paidAt: new Date(request.cash.paidAt + 'T12:00:00.000Z'), method, note: request.cash.note,
                    source: row.kind === 'INVOICE' ? invoices.get(row.targetId)?.carePackageId ? 'PACKAGE_PURCHASE' : 'USER' : 'APPOINTMENT', status: 'POSTED', createdByUserId: getUserId(req)}, options);
                entry.paymentIds.push(payment.id);
            }
            if (row.kind === 'APPOINTMENT') {
                const event = events.get(row.targetId)!;
                if (split.cash > 0 && request.completeReference && row.targetId === context.referenceAgendaEventId) {
                    if (!canAccessAppointmentFinance(req, event.get({plain: true}), 'agenda', 'update')) settlementFail(403, 'Non puoi modificare la presenza della seduta');
                    const patch: Record<string, any> = {};
                    if (String(event.status).toUpperCase() === 'CONFIRMED') patch.status = 'COMPLETED';
                    if (event.missedArrivalReportedAt && !event.missedArrivalResolvedAt) Object.assign(patch,
                        {missedArrivalResolvedAt: new Date(), missedArrivalResolvedBy: getUserId(req), missedArrivalResolution: 'COMPLETED'});
                    if (Object.keys(patch).length) await event.update(patch, {transaction});
                }
                await syncAppointmentPaymentStatus(schema, event, transaction, getUserId(req));
                if (!result.agendaEventIds.includes(event.id)) result.agendaEventIds.push(event.id);
            } else {
                await syncInvoicePaymentStatus(schema, row.targetId, transaction); result.invoiceIds.push(row.targetId);
            }
            result.allocations.push(entry);
        }
        for (const prepared of preparedCredits) {
            const remainingAmount = paymentMoney(Number(prepared.model.get('remainingAmount')) - prepared.use.amount);
            await prepared.model.update({remainingAmount, status: remainingAmount <= 0 ? 'EXHAUSTED' : 'ACTIVE'}, {transaction});
        }
        await Operations.create({id: operationId, patientId: context.patientId, structureId: context.structureId, idempotencyKey,
            requestHash, result, createdByUserId: getUserId(req)}, {transaction});
        return responseForOperation(req, context, operationId, result, false, transaction);
    });
}
