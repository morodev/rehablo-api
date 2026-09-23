import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarizeInvoicePayments } from './payment.service.js';
import {
    resolveAppointmentPrice, summarizeAppointmentPayments, ensureAppointmentPaymentHistory,
    linkAppointmentPayments, isValidPaymentDate
} from './appointmentPayment.service.js';
import InvoicePayment from '../models/invoicePayment.model.js';
import { Op } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import InvoiceAgendaEvent from '../models/invoiceAgendaEvent.model.js';
import {
    createAppointmentPayment, createBulkAppointmentPayments, updateAppointmentPaymentCompatibility,
    validateSequentialAppointmentAllocations, voidAppointmentPayment, updateAppointmentPricing
} from '../../agenda/controllers/appointmentPayment.controller.js';
import { resolveAppointmentAdjustment } from '../utils/appointmentAdjustment.js';
import { saveInvoice, findEligibleAppointments } from '../controllers/invoice.controller.js';
import Invoice from '../models/invoice.model.js';
import InvoiceService from '../models/invoiceService.model.js';
import InvoiceProduct from '../models/invoiceProduct.model.js';
import Service from '../../products-services/models/service.model.js';
import Product from '../../products-services/models/product.model.js';
import Patient from '../../patients/models/patient.model.js';
import Tenant from '../../auth/models/tenant.model.js';
import EventType from '../../agenda/models/eventType.model.js';

describe('summarizeInvoicePayments', () => {
    it('derives unpaid, partial and paid states only from posted movements', () => {
        assert.deepEqual(summarizeInvoicePayments({ invoiceTotal: 100, status: 'unpaid' }, []), {
            paidAmount: 0,
            balance: 100,
            paymentStatus: 'unpaid',
            hasUndatedLegacyPayments: false
        });
        assert.equal(summarizeInvoicePayments(
            { invoiceTotal: 100, status: 'partial' },
            [
                { amount: 35, status: 'POSTED', paidAt: '2026-08-10' },
                { amount: 20, status: 'VOID', paidAt: '2026-08-11' }
            ]
        ).paymentStatus, 'partial');
        assert.deepEqual(summarizeInvoicePayments(
            { invoiceTotal: 100, status: 'partial' },
            [{ amount: 100, status: 'POSTED', paidAt: '2026-08-10' }]
        ), {
            paidAmount: 100,
            balance: 0,
            paymentStatus: 'paid',
            hasUndatedLegacyPayments: false
        });
    });

    it('preserves a legacy paid invoice until its migration has created the movement', () => {
        assert.deepEqual(summarizeInvoicePayments({ invoiceTotal: '80.00', status: 'paid' }, []), {
            paidAmount: 80,
            balance: 0,
            paymentStatus: 'paid',
            hasUndatedLegacyPayments: true
        });
    });

    it('neutralises the debt for void documents while retaining actual cash', () => {
        assert.deepEqual(summarizeInvoicePayments(
            { invoiceTotal: 100, status: 'void' },
            [{ amount: 25, status: 'POSTED', paidAt: '2026-08-10' }]
        ), {
            paidAmount: 25,
            balance: 0,
            paymentStatus: 'void',
            hasUndatedLegacyPayments: false
        });
    });

    it('marks credit notes as not applicable without treating them as void documents', () => {
        assert.deepEqual(summarizeInvoicePayments(
            { invoiceTotal: 100, status: 'unpaid', documentType: 'nota_di_credito' }, []
        ), {
            paidAmount: 0,
            balance: 0,
            paymentStatus: 'not_applicable',
            hasUndatedLegacyPayments: false
        });
    });

    it('restores the debt after the last payment is voided, without a legacy fallback', () => {
        assert.deepEqual(summarizeInvoicePayments(
            { invoiceTotal: 100, status: 'paid' },
            [{ amount: 100, status: 'VOID', paidAt: '2026-01-10', source: 'USER' }]
        ), { paidAmount: 0, balance: 100, paymentStatus: 'unpaid', hasUndatedLegacyPayments: false });
    });

    it('uses the patient net amount for documents with withholding', () => {
        assert.equal(summarizeInvoicePayments(
            { invoiceTotal: 100, invoiceNet: 80, status: 'partial' },
            [{ amount: 80, status: 'POSTED', paidAt: '2026-01-10' }]
        ).balance, 0);
    });
});

describe('appointment ledger and agreed prices', () => {
    it('adds VAT to catalogue estimates and follows exempt issuer regimes', () => {
        const type = { linkedServiceId: 'service' };
        const service = { sellingPrice: 100, productVat: '22' };
        assert.equal(resolveAppointmentPrice({}, type, service).amount, 122);
        assert.equal(resolveAppointmentPrice({}, type, service, false).amount, 100);
        assert.equal(resolveAppointmentPrice({}, type, { ...service, sellingPrice: null }).amount, null);
    });

    it('keeps the agreed amount when the catalogue price changes and marks unknown historical tariffs', () => {
        const snapshot = { appointmentExpectedAmount: 122, appointmentNetAmount: 100, appointmentVatRate: 22 };
        const price = resolveAppointmentPrice(snapshot, { linkedServiceId: 'service' }, { sellingPrice: 180, productVat: '22' });
        assert.equal(price.amount, 122);
        assert.equal(price.estimated, false);
        const historical = resolveAppointmentPrice({ appointmentPaidAmount: 95, appointmentPaymentStatus: 'paid' });
        assert.equal(historical.amount, 95);
        assert.equal(historical.netAmount, null);
        assert.equal(historical.vatRate, null);
        assert.equal(resolveAppointmentPrice({ appointmentPaidAmount: 30, appointmentPaymentStatus: 'partial' }).amount, null);
    });

    it('reconciles existing movement IDs without changing deposits, methods, dates or corrected rows', async context => {
        const movements = [
            { id: 'jan', amount: 30, status: 'POSTED', paidAt: '2026-01-10', method: 'Contanti', invoiceId: null },
            { id: 'feb', amount: 70, status: 'POSTED', paidAt: '2026-02-10', method: 'Bonifico', invoiceId: null }
        ];
        const original = structuredClone(movements);
        context.mock.method(InvoicePayment, 'schema', () => ({
            update: async (values: any, options: any) => {
                assert.deepEqual(options.where.agendaEventId[Op.in], ['appointment']);
                assert.equal(options.where.invoiceId, null);
                movements.filter(movement => movement.invoiceId === null).forEach(movement => Object.assign(movement, values));
            }
        }) as any);
        await linkAppointmentPayments('tenant', ['appointment'], 'march-invoice', {} as any);
        await linkAppointmentPayments('tenant', ['appointment'], 'march-invoice', {} as any);
        assert.deepEqual(movements.map(({ invoiceId, ...movement }) => movement), original.map(({ invoiceId, ...movement }) => movement));
        assert.ok(movements.every(movement => movement.invoiceId === 'march-invoice'));
        assert.deepEqual(summarizeAppointmentPayments(100, original), summarizeAppointmentPayments(100, movements));
        assert.equal(summarizeAppointmentPayments(100, [original[0]]).balance, 70);
        assert.equal(summarizeAppointmentPayments(100, [original[0], { ...original[1], status: 'VOID' }]).paidAmount, 30);
        assert.equal(summarizeAppointmentPayments(100, [{ ...original[0], status: 'VOID' }, { ...original[1], status: 'VOID' }]).balance, 100);
        assert.deepEqual(summarizeAppointmentPayments(100, movements).methods, ['Contanti', 'Bonifico']);
    });

    it('imports an undated historical snapshot once and never resurrects a VOID movement', async context => {
        const rows: any[] = [];
        const model = {
            findAll: async () => [...rows],
            create: async (attributes: any) => {
                const row = { ...attributes, id: 'stable-payment-id' };
                rows.push(row);
                return row;
            }
        };
        context.mock.method(InvoicePayment, 'schema', () => model as any);
        const event = { id: 'appointment', appointmentPaidAmount: 100, appointmentPaymentStatus: 'paid',
            appointmentPaidAt: null, appointmentPaymentMethod: null } as any;
        const transaction = {} as any;
        await ensureAppointmentPaymentHistory('tenant', event, transaction);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].paidAt, null);
        assert.equal(rows[0].invoiceId, null);
        assert.equal(rows[0].source, 'APPOINTMENT');
        rows[0].status = 'VOID';
        await ensureAppointmentPaymentHistory('tenant', event, transaction);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, 'VOID');
    });

    it('rejects impossible and future payment dates, including the automatic invoice balance', () => {
        assert.equal(isValidPaymentDate('2026-02-31', '2026-09-07'), false);
        assert.equal(isValidPaymentDate('2026-02-29', '2026-09-07'), false);
        assert.equal(isValidPaymentDate('2026-09-08', '2026-09-07'), false);
        assert.equal(isValidPaymentDate('2024-02-29', '2026-09-07'), true);
    });
});

describe('appointment payment HTTP handlers with an in-memory ledger', () => {
    it('validates discounts, VAT and existing receipts without turning a partial payment into a discount', () => {
        assert.deepEqual(resolveAppointmentAdjustment(50, 'DISCOUNT', 25, 0, 0), {adjustment: 'DISCOUNT', amount: 25, netAmount: 25});
        assert.deepEqual(resolveAppointmentAdjustment(122, 'DISCOUNT', 61, 30, 22), {adjustment: 'DISCOUNT', amount: 61, netAmount: 50});
        assert.equal(resolveAppointmentAdjustment(50, null, null, 25, 0).amount, 50);
        for (const discount of [-5, 0, 0.001, 50, 51, NaN, Infinity, '25']) {
            assert.throws(() => resolveAppointmentAdjustment(50, 'DISCOUNT', discount, 0, 0));
        }
        assert.throws(() => resolveAppointmentAdjustment(50, 'DISCOUNT', 30, 25, 0), /inferiore agli incassi/);
        assert.throws(() => resolveAppointmentAdjustment(50, 'COMPLIMENTARY', null, 1, 0), /inferiore agli incassi/);
        assert.equal(resolveAppointmentAdjustment(null, 'COMPLIMENTARY', null, 0, null).amount, 0);
    });
    it('requires the full residual, refuses destructive compatibility edits and voids only the selected movement', async context => {
        const eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const rows: any[] = [];
        const record = (values: any) => ({
            ...values,
            get() { return Object.fromEntries(Object.entries(this).filter(([, value]) => typeof value !== 'function')); },
            async update(update: any) { Object.assign(this, update); return this; }
        });
        const event = record({ id: eventId, start: '2026-01-05T10:00:00Z', status: 'COMPLETED',
            patientId: 'patient', calendarId: 'owner', appointmentExpectedAmount: 100,
            appointmentNetAmount: 100, appointmentVatRate: 0, appointmentPaidAmount: 0, invoiceId: null,
            missedArrivalReportedAt: '2026-01-05T10:15:00Z', missedArrivalResolvedAt: null });
        context.mock.method(sequelize, 'transaction', async (callback: any) => callback({ LOCK: { UPDATE: 'UPDATE' } }));
        context.mock.method(AgendaEvent, 'schema', () => ({
            findOne: async (options: any) => {
                assert.equal(options.lock, 'UPDATE');
                return options.where.calendarId && options.where.calendarId !== event.calendarId ? null : event;
            },
            findAll: async () => []
        }) as any);
        context.mock.method(InvoiceAgendaEvent, 'schema', () => ({ findOne: async () => null, findAll: async () => [] }) as any);
        context.mock.method(InvoicePayment, 'schema', () => ({
            findAll: async () => [...rows],
            findOne: async (options: any) => rows.find(row => row.id === options.where.id) ?? null,
            create: async (values: any) => {
                const row = record({ ...values, id: 'bbbbbbbb-bbbb-4bbb-8bbb-' + String(rows.length + 1).padStart(12, '0'),
                    paidAt: values.paidAt?.toISOString().slice(0, 10) ?? null });
                rows.push(row);
                return row;
            }
        }) as any);
        const invoke = (handler: any, body: any, paymentId?: string, own = false): Promise<any> => new Promise((resolve, reject) => {
            const response = { code: 0, status(code: number) { this.code = code; return this; },
                json(payload: any) { resolve({ code: this.code, ...payload }); return this; } };
            handler({ tenantSchema: 'test_tenant', params: { agendaEventId: eventId, paymentId }, body,
                user: { sub: 'recorder' }, access: { scope: own ? 'own' : 'tenant', userId: 'someone-else', resource: 'agenda' } },
            response, reject);
        });
        const partial = await invoke(createAppointmentPayment, { amount: 30, paidAt: '2026-01-10', method: 'Contanti' });
        assert.equal(partial.code, 409);
        assert.match(partial.message, /intero residuo/);
        const settled = await invoke(createAppointmentPayment, {
            amount: 100,
            paidAt: '2026-02-10',
            method: 'Bonifico',
            markCompleted: true
        });
        assert.equal(settled.code, 201);
        assert.equal(settled.data.summary.paymentStatus, 'paid');
        assert.ok(event.missedArrivalResolvedAt instanceof Date);
        assert.equal(event.missedArrivalResolvedBy, 'recorder');
        assert.equal(event.missedArrivalResolution, 'COMPLETED');
        assert.deepEqual(rows.map(row => [row.amount, row.paidAt, row.method]), [
            [100, '2026-02-10', 'Bonifico']
        ]);
        assert.equal((await invoke(updateAppointmentPaymentCompatibility, { status: 'unpaid' })).code, 409);
        assert.equal((await invoke(createAppointmentPayment, { amount: 1, paidAt: '2026-02-11' })).code, 409);
        assert.equal((await invoke(createAppointmentPayment, { amount: 1, paidAt: '2026-02-11' }, undefined, true)).code, 404);
        assert.equal(rows.length, 1);
        const corrected = await invoke(voidAppointmentPayment, { reason: 'Registrazione errata' }, rows[0].id);
        assert.equal(corrected.code, 200);
        assert.equal(corrected.data.summary.paidAmount, 0);
        assert.equal(corrected.data.summary.balance, 100);
        assert.equal(rows[0].status, 'VOID');
        assert.equal(event.appointmentPaidAmount, 0);
        assert.equal(event.appointmentPaymentStatus, 'unpaid');
        assert.equal(rows.length, 1);
        const discounted = await invoke(createAppointmentPayment, {amount: 25, paidAt: '2026-03-01',
            pricing: {adjustment: 'DISCOUNT', discountAmount: 75, note: 'Agevolazione'}});
        assert.equal(discounted.code, 201);
        assert.equal(discounted.data.summary.expectedAmount, 25);
        assert.equal(discounted.data.summary.balance, 0);
        assert.equal(event.appointmentOriginalAmount, 100);
        assert.equal(event.appointmentPriceAdjustment, 'DISCOUNT');
        assert.equal(event.appointmentPriceAdjustmentNote, 'Agevolazione');
        assert.equal(rows.length, 2);
        assert.equal((await invoke(updateAppointmentPricing, {adjustment: 'COMPLIMENTARY'})).code, 400);
        await invoke(voidAppointmentPayment, {reason: 'Incasso errato'}, rows[1].id);
        const gift = await invoke(updateAppointmentPricing, {adjustment: 'COMPLIMENTARY'});
        assert.equal(gift.code, 200);
        assert.equal(gift.data.summary.expectedAmount, 0);
        assert.equal(gift.data.summary.paidAmount, 0);
        assert.equal(gift.data.summary.balance, 0);
        assert.equal(event.appointmentPriceAdjustment, 'COMPLIMENTARY');
        assert.equal(rows.length, 2);
        assert.equal((await invoke(createAppointmentPayment, {amount: 1, paidAt: '2026-03-01'})).code, 409);
        assert.equal((await invoke(updateAppointmentPricing, {adjustment: null})).data.summary.expectedAmount, 100);
        assert.equal(event.appointmentPriceAdjustment, null);
        event.invoiceId = 'invoice';
        assert.equal((await invoke(updateAppointmentPricing, {adjustment: 'DISCOUNT', discountAmount: 25})).code, 409);
        event.invoiceId = null;
        assert.equal((await invoke(updateAppointmentPricing, {adjustment: 'DISCOUNT', discountAmount: 25}, undefined, true)).code, 404);
    });

    it('creates one independent movement per selected appointment in one bulk operation', async context => {
        const referenceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const previousId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        const rows: any[] = [];
        const record = (values: any) => ({
            ...values,
            get() { return Object.fromEntries(Object.entries(this).filter(([, value]) => typeof value !== 'function')); },
            async update(update: any) { Object.assign(this, update); return this; }
        });
        const events = [
            record({id: previousId, start: '2026-01-05T10:00:00Z', status: 'COMPLETED', title: 'Seduta precedente',
                patientId: 'patient', calendarId: 'owner', appointmentExpectedAmount: 40,
                appointmentNetAmount: 40, appointmentVatRate: 0, appointmentPaidAmount: 0,
                appointmentPaymentHistoryKnown: true, invoiceId: null}),
            record({id: referenceId, start: '2026-01-12T10:00:00Z', status: 'CONFIRMED', title: 'Seduta corrente',
                patientId: 'patient', calendarId: 'owner', appointmentExpectedAmount: 40,
                appointmentNetAmount: 40, appointmentVatRate: 0, appointmentPaidAmount: 0,
                appointmentPaymentHistoryKnown: true, invoiceId: null,
                missedArrivalReportedAt: '2026-01-12T10:15:00Z', missedArrivalResolvedAt: null})
        ];
        context.mock.method(sequelize, 'transaction', async (callback: any) => callback({LOCK: {UPDATE: 'UPDATE'}}));
        context.mock.method(AgendaEvent, 'schema', () => ({
            findAll: async (options: any) => {
                assert.equal(options.lock, 'UPDATE');
                const ids = options.where.id?.[Op.in];
                return (ids ? events.filter(event => ids.includes(event.id)) : events)
                    .sort((a, b) => a.id.localeCompare(b.id));
            }
        }) as any);
        context.mock.method(InvoiceAgendaEvent, 'schema', () => ({findOne: async () => null, findAll: async () => []}) as any);
        context.mock.method(InvoicePayment, 'schema', () => ({
            findAll: async (options: any) => {
                const requested = options.where.agendaEventId;
                const ids = requested?.[Op.in];
                return rows.filter(row => ids ? ids.includes(row.agendaEventId) : row.agendaEventId === requested);
            },
            create: async (values: any) => {
                const row = record({...values, id: `payment-${rows.length + 1}`,
                    paidAt: values.paidAt?.toISOString().slice(0, 10) ?? null});
                rows.push(row);
                return row;
            }
        }) as any);
        const response: any = await new Promise((resolve, reject) => {
            const res = {code: 0, status(code: number) { this.code = code; return this; },
                json(payload: any) { resolve({code: this.code, ...payload}); return this; }};
            createBulkAppointmentPayments({tenantSchema: 'test_tenant', params: {agendaEventId: referenceId},
                body: {paidAt: '2026-02-01', method: 'Contanti', note: 'Tre sedute', markReferenceCompleted: true,
                    allocations: [{agendaEventId: previousId, amount: 40}, {agendaEventId: referenceId, amount: 40}]},
                user: {sub: 'recorder'}, access: {scope: 'tenant', userId: 'recorder', resource: 'agenda'}
            } as any, res as any, reject);
        });

        assert.equal(response.code, 201);
        assert.equal(response.data.allocations.length, 2);
        assert.deepEqual(rows.map(row => [row.agendaEventId, row.amount, row.method]), [
            [previousId, 40, 'Contanti'], [referenceId, 40, 'Contanti']
        ]);
        assert.ok(events.every(event => event.appointmentPaymentStatus === 'paid'));
        const reference = events.find(event => event.id === referenceId)!;
        assert.equal(reference.status, 'COMPLETED');
        assert.ok(reference.missedArrivalResolvedAt instanceof Date);
        assert.equal(reference.missedArrivalResolvedBy, 'recorder');
        assert.equal(reference.missedArrivalResolution, 'COMPLETED');
    });

    it('validates chronological full settlements and permits a partial final allocation', () => {
        const sequence = [
            {id: 'old-1', title: 'Seduta 1', balance: 60},
            {id: 'old-2', title: 'Seduta 2', balance: 60},
            {id: 'current', title: 'Seduta corrente', balance: 70}
        ];
        assert.deepEqual(validateSequentialAppointmentAllocations(sequence, [
            {agendaEventId: 'old-2', amount: 40},
            {agendaEventId: 'old-1', amount: 60}
        ]), [
            {agendaEventId: 'old-1', amount: 60},
            {agendaEventId: 'old-2', amount: 40}
        ]);
        assert.throws(() => validateSequentialAppointmentAllocations(sequence, [
            {agendaEventId: 'old-1', amount: 40}
        ]), /intero residuo/);
        assert.throws(() => validateSequentialAppointmentAllocations(sequence, [
            {agendaEventId: 'current', amount: 70}
        ]), /seduta precedente più vecchia/);
        assert.deepEqual(validateSequentialAppointmentAllocations([
            {id: 'unknown', title: 'Senza prezzo', balance: null}
        ], [{agendaEventId: 'unknown', amount: 45}]), [{agendaEventId: 'unknown', amount: 45}]);
    });
});

describe('invoicing appointment concessions through the HTTP handlers', () => {
    const eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const serviceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const patientId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const record = (values: any) => ({...values,
        get(key?: any) { return typeof key === 'string' ? this[key]
            : Object.fromEntries(Object.entries(this).filter(([, value]) => typeof value !== 'function')); },
        async update(values: any) { Object.assign(this, values); return this; }
    });
    function setup(context: any, adjustment: 'DISCOUNT' | 'COMPLIMENTARY') {
        const event = record({id: eventId, patientId, status: 'COMPLETED', start: '2026-01-05T10:00:00Z',
            calendarId: null, recurrence: null, invoiceId: null, eventTypeId: 'type',
            appointmentExpectedAmount: adjustment === 'DISCOUNT' ? 25 : 0, appointmentOriginalAmount: 50,
            appointmentPriceAdjustment: adjustment, appointmentNetAmount: adjustment === 'DISCOUNT' ? 25 : 0,
            appointmentVatRate: 0, appointmentPaymentHistoryKnown: true});
        const tenant = record({id: 'tenant', businessName: 'Studio test', taxCode: 'TEST', address: 'Via Test 1',
            city: 'Milano', zipCode: '20100', taxRegime: 'RF01', lastDocumentNumberByYear: {}});
        const receipts = adjustment === 'DISCOUNT' ? [record({id: 'cash', agendaEventId: eventId, invoiceId: null,
            amount: 25, status: 'POSTED', source: 'APPOINTMENT', paidAt: '2026-01-05'})] : [];
        const lines: any[] = [];
        let created: any = null;
        context.mock.method(sequelize, 'transaction', async (callback: any) => callback({LOCK: {UPDATE: 'UPDATE'}}));
        context.mock.method(Tenant, 'findByPk', async () => tenant);
        context.mock.method(AgendaEvent, 'schema', () => ({findAll: async () => [event]}));
        context.mock.method(Patient, 'schema', () => ({findOne: async () => record({id: patientId})}));
        context.mock.method(EventType, 'schema', () => ({findAll: async () => [record({id: 'type', linkedServiceId: serviceId})]}));
        context.mock.method(Service, 'schema', () => ({findAll: async () => [record({id: serviceId, name: 'Terapia', sellingPrice: 80, productVat: 'N4', isActive: true})]}));
        context.mock.method(Product, 'schema', () => ({findAll: async () => []}));
        context.mock.method(InvoiceProduct, 'schema', () => ({}));
        context.mock.method(InvoiceService, 'schema', () => ({create: async (values: any) => {lines.push(values); return record(values);}}));
        context.mock.method(InvoiceAgendaEvent, 'schema', () => ({findAll: async () => [], create: async (values: any) => record(values)}));
        context.mock.method(Invoice, 'schema', () => ({
            findOne: async () => null,
            create: async (values: any) => {created = record({...values, id: 'invoice', services: lines}); return created;},
            findByPk: async () => created
        }));
        context.mock.method(InvoicePayment, 'schema', () => ({findAll: async () => receipts,
            update: async (values: any) => receipts.forEach(payment => Object.assign(payment, values)),
            create: async () => {throw new Error('Invoice emission must not create another receipt');}
        }));
        const invoke = (handler: any, body: any) => new Promise<any>((resolve, reject) => {
            const response = {code: 0, status(code: number) {this.code = code; return this;},
                json(data: any) {resolve({code: this.code, ...data}); return this;}};
            handler({tenantSchema: 'test_tenant', body, query: {patientId, through: '2026-01-31'},
                user: {sub: 'user', tenants: [{id: 'tenant'}]}, access: {scope: 'tenant', resource: 'invoice'}}, response, reject);
        });
        return {invoke, event, tenant, receipts, lines};
    }

    it('emits appointment invoices with a frozen declared TS profile and SP, without changing collection amounts', async context => {
        const state = setup(context, 'DISCOUNT');
        (state.tenant as any).administrationSettings = { fiscal: { stsIssuerType: 'PHYSIOTHERAPIST' } };
        const response = await state.invoke(saveInvoice, { patientID: patientId, documentType: 'fattura',
            emissionDate: '2026-01-10', appointments: [{ agendaEventId: eventId, serviceId }] });
        assert.equal(response.code, 201);
        assert.equal(response.data.stsExpenseTypeCode, 'SP');
        assert.equal(response.data.issuer.stsIssuerType, 'PHYSIOTHERAPIST');
        assert.equal(response.data.paidAmount, 25);
    });
    it('keeps an explicit da definire TS selection when issuing an appointment invoice', async context => {
        const state = setup(context, 'DISCOUNT');
        (state.tenant as any).administrationSettings = { fiscal: { stsIssuerType: 'PHYSIOTHERAPIST' } };
        const response = await state.invoke(saveInvoice, { patientID: patientId, documentType: 'fattura',
            emissionDate: '2026-01-10', stsExpenseTypeCode: null, appointments: [{ agendaEventId: eventId, serviceId }] });
        assert.equal(response.code, 201);
        assert.equal(response.data.stsExpenseTypeCode, null);
        assert.equal(response.data.issuer.stsIssuerType, 'PHYSIOTHERAPIST');
        assert.equal(response.data.invoiceTotal, 25);
        assert.equal(response.data.paidAmount, 25);
    });
    it('rejects an explicit incompatible TS code before assigning an invoice number', async context => {
        const state = setup(context, 'DISCOUNT');
        (state.tenant as any).administrationSettings = { fiscal: { stsIssuerType: 'PHYSIOTHERAPIST' } };
        await assert.rejects(() => state.invoke(saveInvoice, { patientID: patientId, documentType: 'fattura',
            emissionDate: '2026-01-10', stsExpenseTypeCode: 'SR', appointments: [{ agendaEventId: eventId, serviceId }] }), /non è previsto/);
        assert.deepEqual(state.tenant.lastDocumentNumberByYear, {});
    });

    for (const cumulative of [false, true]) {
        it(`keeps the discounted 25 euro price and original 50 euro tariff in a ${cumulative ? 'cumulative' : 'single'} invoice`, async context => {
            const state = setup(context, 'DISCOUNT');
            const eligible = await state.invoke(findEligibleAppointments, {});
            assert.equal(eligible.data.appointments[0].service.sellingPrice, 25);
            assert.equal(eligible.data.appointments[0].service.originalSellingPrice, 50);
            const response = await state.invoke(saveInvoice, {patientID: patientId, documentType: 'fattura',
                emissionDate: '2026-01-10', status: 'paid',
                ...(cumulative ? {appointments: [{agendaEventId: eventId, serviceId}]}
                    : {agendaEventId: eventId, services: [{id: serviceId, quantity: 1}]})});
            assert.equal(response.code, 201);
            assert.equal(response.data.invoiceTotal, 25);
            assert.equal(response.data.sellingPrice, 50);
            assert.equal(response.data.discSellingPrice, 25);
            assert.equal(response.data.balance, 0);
            assert.equal(response.data.paidAmount, 25);
            assert.equal(state.lines[0].servicePrice, 25);
            assert.equal(state.lines[0].originalServicePrice, 50);
            assert.equal(state.receipts.length, 1);
            assert.equal(state.receipts[0].id, 'cash');
            assert.equal(state.receipts[0].invoiceId, 'invoice');
        });

        it(`blocks a complimentary session in a ${cumulative ? 'cumulative' : 'single'} invoice before allocating a number`, async context => {
            const state = setup(context, 'COMPLIMENTARY');
            assert.deepEqual((await state.invoke(findEligibleAppointments, {})).data.appointments, []);
            const response = await state.invoke(saveInvoice, {patientID: patientId, documentType: 'fattura',
                emissionDate: '2026-01-10', status: 'unpaid',
                ...(cumulative ? {appointments: [{agendaEventId: eventId, serviceId}]}
                    : {agendaEventId: eventId, services: [{id: serviceId, quantity: 1}]})});
            assert.equal(response.code, 409);
            assert.match(response.message, /omaggio/);
            assert.equal(state.lines.length, 0);
            assert.deepEqual(state.tenant.lastDocumentNumberByYear, {});
        });
    }

    it('rejects a 100% document discount before allocating an invoice number', async context => {
        const state = setup(context, 'DISCOUNT');
        const response = await state.invoke(saveInvoice, {patientID: patientId, documentType: 'fattura',
            emissionDate: '2026-01-10', status: 'unpaid', discountType: 'percentage', discountAmount: 100,
            appointments: [{agendaEventId: eventId, serviceId}]});
        assert.equal(response.code, 400);
        assert.match(response.message, /inferiore al 100%/);
        assert.deepEqual(state.tenant.lastDocumentNumberByYear, {});
    });

    it('rejects invalid quantities and unsupported line discounts', async context => {
        const state = setup(context, 'DISCOUNT');
        const base = {patientID: patientId, documentType: 'fattura', emissionDate: '2026-01-10',
            status: 'unpaid', agendaEventId: eventId};
        const quantity = await state.invoke(saveInvoice, {
            ...base, services: [{id: serviceId, quantity: 0}]
        });
        assert.equal(quantity.code, 400);
        assert.match(quantity.message, /quantità/i);
        const lineDiscount = await state.invoke(saveInvoice, {
            ...base, services: [{id: serviceId, quantity: 1, percentageDiscount: 10}]
        });
        assert.equal(lineDiscount.code, 400);
        assert.match(lineDiscount.message, /totale della fattura/i);
        assert.deepEqual(state.tenant.lastDocumentNumberByYear, {});
    });

    it('rejects appointment receipts that exceed the discounted invoice net', async context => {
        const state = setup(context, 'DISCOUNT');
        const response = await state.invoke(saveInvoice, {patientID: patientId, documentType: 'fattura',
            emissionDate: '2026-01-10', status: 'unpaid', discountType: 'value', discountAmount: 5,
            appointments: [{agendaEventId: eventId, serviceId}]});
        assert.equal(response.code, 409);
        assert.match(response.message, /incassi selezionati/i);
        assert.deepEqual(state.tenant.lastDocumentNumberByYear, {});
    });
});
