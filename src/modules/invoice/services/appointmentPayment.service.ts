import { Op, Transaction } from 'sequelize';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import EventType from '../../agenda/models/eventType.model.js';
import Service from '../../products-services/models/service.model.js';
import Tenant from '../../auth/models/tenant.model.js';
import InvoicePayment from '../models/invoicePayment.model.js';
import { getTaxRegime } from '../utils/fiscalRegime.js';

export const paymentMoney = (value: unknown): number => Math.round((Number(value) || 0) * 100) / 100;
export function isValidPaymentDate(value: unknown, today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' })): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value > today) return false;
    const date = new Date(value + 'T12:00:00.000Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const nullableMoney = (value: unknown): number | null =>
    value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0
        ? paymentMoney(value) : null;

export interface AppointmentPrice {
    amount: number | null;
    netAmount: number | null;
    vatRate: number | null;
    source: 'SNAPSHOT' | 'SERVICE' | 'EVENT_TYPE' | null;
    estimated: boolean;
}

/** Pure resolver shared by payments, agenda and reports. Catalogue fallback is explicitly an estimate. */
export function resolveAppointmentPrice(
    event: Record<string, any>,
    eventType?: Record<string, any> | null,
    service?: Record<string, any> | null,
    appliesVat = true
): AppointmentPrice {
    const frozen = nullableMoney(event.appointmentExpectedAmount);
    if (frozen !== null) {
        return { amount: frozen, netAmount: nullableMoney(event.appointmentNetAmount),
            vatRate: nullableMoney(event.appointmentVatRate), source: 'SNAPSHOT', estimated: false };
    }
    // A historical full payment is evidence of its agreed customer amount, never of a prior net tariff.
    const knownPaid = nullableMoney(event.appointmentPaidAmount);
    if (event.appointmentPaymentStatus === 'paid' && knownPaid !== null && knownPaid > 0) {
        return { amount: knownPaid, netAmount: null, vatRate: null, source: 'SNAPSHOT', estimated: false };
    }
    if (eventType?.linkedServiceId) {
        const netAmount = nullableMoney(service?.sellingPrice);
        const rawVat = String(service?.productVat ?? '').trim();
        const vatRate = appliesVat && ['4', '5', '10', '22'].includes(rawVat) ? Number(rawVat) : 0;
        return { amount: netAmount === null ? null : paymentMoney(netAmount * (1 + vatRate / 100)),
            netAmount, vatRate: netAmount === null ? null : vatRate,
            source: netAmount === null ? null : 'SERVICE', estimated: true };
    }
    const amount = nullableMoney(eventType?.price);
    return { amount, netAmount: null, vatRate: null, source: amount === null ? null : 'EVENT_TYPE', estimated: true };
}

export async function appointmentPricesByEvent(
    schema: string, events: Array<Record<string, any>>, transaction?: Transaction
): Promise<Map<string, AppointmentPrice>> {
    const ids = [...new Set(events.map(event => event.eventTypeId).filter(Boolean))];
    const types = ids.length ? await EventType.schema(schema).findAll({
        where: { id: { [Op.in]: ids } }, transaction
    }) : [];
    const serviceIds = [...new Set(types.map(type => type.linkedServiceId).filter(Boolean))] as string[];
    const services = serviceIds.length ? await Service.schema(schema).findAll({
        where: { id: { [Op.in]: serviceIds } }, transaction
    }) : [];
    // Tenant schemas encode the tenant UUID without hyphens.
    const hex = schema.replace(/^rehablo_/, '');
    const tenantId = /^[a-f0-9]{32}$/i.test(hex)
        ? [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
        : null;
    const tenant = tenantId ? await Tenant.findByPk(tenantId, { attributes: ['taxRegime'], transaction }) : null;
    const appliesVat = getTaxRegime(tenant?.taxRegime).appliesVat;
    const typesById = new Map(types.map(type => [type.id, type.get({ plain: true })]));
    const servicesById = new Map(services.map(service => [service.id, service.get({ plain: true })]));
    return new Map(events.map(event => {
        const type = typesById.get(event.eventTypeId);
        return [event.id, resolveAppointmentPrice(event, type,
            type?.linkedServiceId ? servicesById.get(type.linkedServiceId) : null, appliesVat)];
    }));
}

export function appointmentPriceFields(price: AppointmentPrice): Record<string, any> {
    return { appointmentExpectedAmount: price.amount, appointmentNetAmount: price.netAmount,
        appointmentVatRate: price.vatRate, appointmentPriceRecordedAt: price.amount === null ? null : new Date() };
}

export async function snapshotAppointmentPrice(schema: string, event: Record<string, any>, transaction?: Transaction) {
    const price = (await appointmentPricesByEvent(schema, [event], transaction)).get(event.id)!;
    return appointmentPriceFields(price);
}

export interface AppointmentPaymentSummary {
    paidAmount: number;
    expectedAmount: number | null;
    balance: number | null;
    paymentStatus: 'unpaid' | 'partial' | 'paid';
    methods: Array<string | null>;
    hasUndatedPayments: boolean;
}

export function summarizeAppointmentPayments(expectedAmount: number | null, payments: Array<Record<string, any>>): AppointmentPaymentSummary {
    const posted = payments.filter(payment => payment.status === 'POSTED');
    const paidAmount = paymentMoney(posted.reduce((sum, payment) => sum + Number(payment.amount), 0));
    const balance = expectedAmount === null ? null : paymentMoney(Math.max(expectedAmount - paidAmount, 0));
    return { paidAmount, expectedAmount, balance,
        paymentStatus: expectedAmount === 0 ? 'paid' : paidAmount <= 0 ? 'unpaid' : balance !== null && balance <= 0.009 ? 'paid' : 'partial',
        methods: [...new Set(posted.map(payment => payment.method || null))],
        hasUndatedPayments: posted.some(payment => !payment.paidAt) };
}

/** Caller holds the event row lock. Also covers deployments where old snapshots predate migration. */
export async function ensureAppointmentPaymentHistory(schema: string, event: AgendaEvent, transaction: Transaction): Promise<InvoicePayment[]> {
    const movements = await InvoicePayment.schema(schema).findAll({
        where: { agendaEventId: event.id }, transaction, order: [['createdAt', 'ASC']]
    });
    const amount = paymentMoney(event.appointmentPaidAmount);
    // Any movement, including VOID, makes the ledger authoritative: never resurrect a corrected payment.
    if (movements.length === 0 && amount > 0 && ['paid', 'partial'].includes(event.appointmentPaymentStatus ?? '')) {
        const movement = await InvoicePayment.schema(schema).create({
            agendaEventId: event.id, invoiceId: event.invoiceId ?? null, amount,
            paidAt: event.appointmentPaidAt ? new Date(event.appointmentPaidAt + 'T12:00:00.000Z') : null,
            method: event.appointmentPaymentMethod, note: event.appointmentPaymentNote,
            source: 'APPOINTMENT', status: 'POSTED', createdByUserId: event.appointmentPaymentRecordedBy
        }, { transaction });
        movements.push(movement);
    }
    return movements;
}

/** Caller holds event locks. Attaches the original IDs, including corrected rows, without creating cash. */
export async function linkAppointmentPayments(schema: string, eventIds: string[], invoiceId: string, transaction: Transaction): Promise<void> {
    if (!eventIds.length) return;
    await InvoicePayment.schema(schema).update({ invoiceId }, {
        where: { agendaEventId: { [Op.in]: eventIds }, invoiceId: null }, transaction
    });
}

/** Compatibility columns are derived only from event-owned movements, including after invoice linking. */
export async function syncAppointmentPaymentStatus(
    schema: string, event: AgendaEvent, transaction: Transaction, recordedBy?: string | null
): Promise<AppointmentPaymentSummary> {
    const movements = await InvoicePayment.schema(schema).findAll({ where: { agendaEventId: event.id }, transaction });
    const plain = movements.map(movement => movement.get({ plain: true }));
    const price = (await appointmentPricesByEvent(schema, [event.get({ plain: true })], transaction)).get(event.id)!;
    const summary = summarizeAppointmentPayments(price.amount, plain);
    const posted = plain.filter(payment => payment.status === 'POSTED');
    const dated = posted.map(payment => String(payment.paidAt ?? '')).filter(Boolean).sort();
    await event.update({
        appointmentPaidAmount: summary.paidAmount, appointmentPaymentStatus: summary.paymentStatus,
        appointmentPaidAt: dated.at(-1) ?? null,
        appointmentPaymentMethod: summary.methods.length === 1 ? summary.methods[0] : null,
        appointmentPaymentNote: posted.length === 1 ? posted[0].note : null,
        appointmentPaymentHistoryKnown: true, appointmentPaymentRecordedBy: recordedBy ?? event.appointmentPaymentRecordedBy
    }, { transaction });
    return summary;
}
