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
import { createAppointmentPayment, updateAppointmentPaymentCompatibility, voidAppointmentPayment } from '../../agenda/controllers/appointmentPayment.controller.js';

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
    it('appends instalments, refuses destructive compatibility edits and voids only the selected movement', async context => {
        const eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const rows: any[] = [];
        const record = (values: any) => ({
            ...values,
            get() { return Object.fromEntries(Object.entries(this).filter(([, value]) => typeof value !== 'function')); },
            async update(update: any) { Object.assign(this, update); return this; }
        });
        const event = record({ id: eventId, start: '2026-01-05T10:00:00Z', status: 'COMPLETED',
            patientId: 'patient', calendarId: 'owner', appointmentExpectedAmount: 100,
            appointmentNetAmount: 100, appointmentVatRate: 0, appointmentPaidAmount: 0, invoiceId: null });
        context.mock.method(sequelize, 'transaction', async (callback: any) => callback({ LOCK: { UPDATE: 'UPDATE' } }));
        context.mock.method(AgendaEvent, 'schema', () => ({
            findOne: async (options: any) => {
                assert.equal(options.lock, 'UPDATE');
                return options.where.calendarId && options.where.calendarId !== event.calendarId ? null : event;
            }
        }) as any);
        context.mock.method(InvoiceAgendaEvent, 'schema', () => ({ findOne: async () => null }) as any);
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
        assert.equal((await invoke(createAppointmentPayment, { amount: 30, paidAt: '2026-01-10', method: 'Contanti' })).code, 201);
        const second = await invoke(createAppointmentPayment, { amount: 70, paidAt: '2026-02-10', method: 'Bonifico' });
        assert.equal(second.code, 201);
        assert.equal(second.data.summary.paymentStatus, 'paid');
        assert.deepEqual(rows.map(row => [row.amount, row.paidAt, row.method]), [
            [30, '2026-01-10', 'Contanti'], [70, '2026-02-10', 'Bonifico']
        ]);
        assert.equal((await invoke(updateAppointmentPaymentCompatibility, { status: 'unpaid' })).code, 409);
        assert.equal((await invoke(createAppointmentPayment, { amount: 1, paidAt: '2026-02-11' })).code, 409);
        assert.equal((await invoke(createAppointmentPayment, { amount: 1, paidAt: '2026-02-11' }, undefined, true)).code, 404);
        assert.equal(rows.length, 2);
        const corrected = await invoke(voidAppointmentPayment, { reason: 'Registrazione errata' }, rows[1].id);
        assert.equal(corrected.code, 200);
        assert.equal(corrected.data.summary.paidAmount, 30);
        assert.equal(corrected.data.summary.balance, 70);
        assert.equal(rows[0].status, 'POSTED');
        assert.equal(rows[1].status, 'VOID');
        assert.equal(event.appointmentPaidAmount, 30);
        const final = await invoke(voidAppointmentPayment, { reason: 'Duplicato' }, rows[0].id);
        assert.equal(final.data.summary.balance, 100);
        assert.equal(event.appointmentPaymentStatus, 'unpaid');
        assert.equal(rows.length, 2);
    });
});
