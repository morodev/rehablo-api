import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { Op } from 'sequelize';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import { aggregateFinance, aggregateTherapyPayments, FinanceData, FinanceQuery, invoiceMatchesContext, loadFinanceData, parseFinanceFilters } from './finance.service.js';

const query = (overrides: Partial<FinanceQuery> = {}): FinanceQuery => ({
    from: '2026-01-01', to: '2026-01-31', granularity: 'month', compare: 'none',
    structureId: null, operatorId: null, eventTypeId: null,
    paymentStatus: 'all', documentStatus: 'all', paymentMethod: null, ...overrides
});
const event = (overrides: Record<string, any> = {}) => ({
    id: 'event-1', start: '2026-01-10T09:00:00Z', status: 'COMPLETED',
    patientId: 'patient-1', expectedAmount: 100, appointmentPaymentHistoryKnown: true,
    invoiceId: null, ...overrides
});
const payment = (overrides: Record<string, any> = {}) => ({
    id: 'cash-1', agendaEventId: 'event-1', invoiceId: null, amount: 100,
    paidAt: '2026-01-10', method: 'Contanti', source: 'APPOINTMENT', status: 'POSTED', ...overrides
});
const invoice = (overrides: Record<string, any> = {}) => ({
    id: 'invoice-1', invoiceTotal: 100, invoiceNet: 100, status: 'paid', documentType: 'fattura',
    emissionDate: '2026-03-10', ...overrides
});
const data = (overrides: Partial<FinanceData> = {}): FinanceData => ({
    events: [event()], payments: [payment()], invoices: [], attributableInvoiceIds: new Set(), excludedMixedInvoiceCount: 0, ...overrides
});
const occurrences = (events: Array<Record<string, any>>) => events.map((row) => ({
    ...row, sourceEventId: row.id, patientName: 'Mario Rossi', title: 'Seduta'
}));

describe('shared cash and document reporting', () => {
    it('counts cash immediately in January and only revenue when invoicing it in March', () => {
        const before = aggregateFinance(data(), query());
        assert.equal(before.totals.collected, 100);
        assert.equal(before.totals.collectedUnbilled, 100);
        const linked = data({ events: [event({ invoiceId: 'invoice-1' })],
            invoices: [invoice()], payments: [payment({ invoiceId: 'invoice-1' })], attributableInvoiceIds: new Set(['invoice-1']) });
        const january = aggregateFinance(linked, query());
        assert.equal(january.totals.collected, 100);
        assert.equal(january.totals.collectedFromAppointments, 100);
        assert.equal(january.totals.collectedFromInvoices, 0);
        assert.equal(january.totals.collectedUnbilled, 0);
        assert.equal(january.totals.billedTotal, 0);
        const march = aggregateFinance(linked, query({ from: '2026-03-01', to: '2026-03-31' }));
        assert.equal(march.totals.collected, 0);
        assert.equal(march.totals.billedTotal, 100);
    });

    it('keeps instalment months and sums only the selected payment method', () => {
        const input = data({ payments: [payment({ amount: 30 }), payment({ id: 'cash-2', amount: 70, method: 'POS', paidAt: '2026-02-05' })] });
        assert.equal(aggregateFinance(input, query()).totals.collected, 30);
        assert.equal(aggregateFinance(input, query({ from: '2026-02-01', to: '2026-02-28' })).totals.collected, 70);
        const result = aggregateTherapyPayments(input, query({ paymentStatus: 'paid', paymentMethod: 'POS' }), occurrences(input.events));
        assert.equal(result.totals.collected, 70);
        assert.equal(result.details[0].paidAmount, 100);
        assert.equal(result.details[0].balance, 0);
    });

    it('counts stable receipt IDs once and separates cash origin from document status', () => {
        const input = data({ payments: [payment(), payment(), payment({ id: 'cash-2', source: 'USER', agendaEventId: null, invoiceId: 'invoice-1' })],
            invoices: [invoice()], attributableInvoiceIds: new Set(['invoice-1']) });
        const result = aggregateFinance(input, query());
        assert.equal(result.totals.collected, 200);
        assert.equal(result.totals.collectedFromAppointments, 100);
        assert.equal(result.totals.collectedFromInvoices, 100);
    });

    it('does not fabricate dates for legacy payments or restore voided cash', () => {
        const result = aggregateFinance(data({ payments: [payment({ paidAt: null }), payment({ id: 'void', amount: 40, status: 'VOID' })] }), query());
        assert.equal(result.totals.collected, 0);
        assert.equal(result.totals.collectedUnbilled, 100);
        assert.equal(result.totals.undatedLegacyPaid, 100);
    });

    it('treats the old Dashboard origin marker as an unspecified payment method', () => {
        const result = aggregateFinance(data({ payments: [payment({ method: 'Dashboard' })] }), query({ paymentMethod: '__unspecified__' }));
        assert.equal(result.totals.collected, 100);
    });

    it('preserves received cash when the fiscal document is voided without a refund', () => {
        const input = data({ events: [], invoices: [invoice({ status: 'void' })],
            payments: [payment({ source: 'USER', agendaEventId: null, invoiceId: 'invoice-1' })], attributableInvoiceIds: new Set(['invoice-1']) });
        const result = aggregateFinance(input, query());
        assert.equal(result.totals.collected, 100);
        assert.equal(result.totals.billedTotal, 0);
        assert.equal(result.totals.outstanding, 0);
    });

    it('uses the actual payment date even when the appointment is in another period', () => {
        const result = aggregateFinance(data({ events: [event({ start: '2025-11-01T09:00:00Z' })] }), query());
        assert.equal(result.totals.collected, 100);
        assert.equal(result.totals.unbilledCompleted, 0);
    });
});

describe('therapy payment filters and pagination', () => {
    it('computes totals across more than 200 therapies before returning a page', () => {
        const events = Array.from({ length: 251 }, (_, n) => event({ id: `event-${n}` }));
        const payments = events.map((row) => payment({ id: `cash-${row.id}`, agendaEventId: row.id }));
        const result = aggregateTherapyPayments(data({ events, payments }), query({ paymentStatus: 'paid', documentStatus: 'unbilled', paymentMethod: 'Contanti' }), occurrences(events), 3, 100);
        assert.equal(result.totals.count, 251);
        assert.equal(result.totals.expectedAmount, 25100);
        assert.equal(result.totals.collected, 25100);
        assert.equal(result.details.length, 51);
        assert.equal(result.pagination.lastPage, 3);
    });

    it('keeps cumulative invoice balances distinct and does not assign payment to every therapy', () => {
        const events = [event({ id: 'one', invoiceId: 'invoice-1' }), event({ id: 'two', invoiceId: 'invoice-1' })];
        const input = data({ events, payments: [payment({ agendaEventId: null, invoiceId: 'invoice-1', amount: 60, source: 'USER' })],
            invoices: [invoice({ invoiceTotal: 200, invoiceNet: 200, status: 'partial' })], attributableInvoiceIds: new Set(['invoice-1']) });
        const result = aggregateTherapyPayments(input, query({ paymentStatus: 'partial', documentStatus: 'invoiced' }), occurrences(events));
        assert.equal(result.totals.count, 2);
        assert.equal(result.totals.invoiceManagedCount, 2);
        assert.equal(result.totals.invoiceCount, 1);
        assert.equal(result.totals.invoiceCollected, 60);
        assert.equal(result.totals.invoiceOutstanding, 140);
        assert.equal(result.totals.outstanding, 0);
        assert.ok(result.details.every((row) => row.paidAmount === null && row.balance === null && row.invoicePaymentStatus === 'partial'));
    });

    it('does not label unverified historical records as unpaid', () => {
        const input = data({ events: [event({ appointmentPaymentHistoryKnown: false })], payments: [] });
        assert.equal(aggregateTherapyPayments(input, query({ paymentStatus: 'unpaid' }), occurrences(input.events)).totals.count, 0);
        const result = aggregateTherapyPayments(input, query({ paymentStatus: 'unknown' }), occurrences(input.events));
        assert.equal(result.totals.unknownCount, 1);
        assert.equal(result.totals.outstanding, 0);
        assert.equal(result.details[0].balance, null);
    });

    it('retains known receipts when the historical expected price is unknown without inventing a debt', () => {
        const input = data({ events: [event({ expectedAmount: null })], payments: [payment({ amount: 30 })] });
        const result = aggregateTherapyPayments(input, query(), occurrences(input.events));
        assert.equal(result.totals.collected, 30);
        assert.equal(result.totals.expectedAmount, 0);
        assert.equal(result.details[0].expectedAmount, null);
        assert.equal(result.details[0].paidAmount, 30);
        assert.equal(result.details[0].balance, null);
        assert.equal(result.totals.outstanding, 0);
        assert.equal(result.totals.unknownPriceCount, 1);
        assert.equal(result.totals.estimatedPriceCount, 0);
        assert.equal(aggregateFinance(input, query()).totals.appointmentOutstanding, 0);
    });

    it('counts estimated and missing prices across the complete filtered result before pagination', () => {
        const events = [
            event({ id: 'frozen', priceEstimated: false }),
            event({ id: 'estimated', expectedAmount: 120, priceEstimated: true }),
            event({ id: 'unknown', expectedAmount: null, priceEstimated: true })
        ];
        const input = data({ events, payments: [] });
        const result = aggregateTherapyPayments(input, query(), occurrences(events), 1, 1);
        assert.equal(result.details.length, 1);
        assert.equal(result.totals.expectedAmount, 220);
        assert.equal(result.totals.estimatedPriceCount, 1);
        assert.equal(result.totals.unknownPriceCount, 1);
    });

    it('applies operational IDs before totals, including an explicit empty set', () => {
        const input = data();
        assert.equal(aggregateTherapyPayments(input, query({ agendaEventIds: [] }), occurrences(input.events)).totals.count, 0);
        assert.deepEqual(parseFinanceFilters({ query: { agendaEventIds: '' } } as any).agendaEventIds, []);
    });

    it('rejects whole-document attribution to one operator when a cumulative invoice is mixed', () => {
        assert.equal(invoiceMatchesContext([{ calendarId: 'a' }, { calendarId: 'b' }], query({ operatorId: 'a' })), false);
        assert.equal(invoiceMatchesContext([{ calendarId: 'a' }, { calendarId: 'a' }], query({ operatorId: 'a' })), true);
        assert.equal(invoiceMatchesContext([], query({ operatorId: 'a' })), false);
    });
});

describe('financial report loading and access boundaries', () => {
    it('restricts event cash to authorized patients and retains the event owner filter', async () => {
        const ownerId = '11111111-1111-4111-8111-111111111111';
        const request = { tenantSchema: 'test_tenant', access: { scope: 'own', userId: ownerId, structureId: null } } as any;
        let eventWhere: any;
        let invoiceWhere: any;
        const eventMock = mock.method(AgendaEvent, 'schema', (() => ({ findAll: async (options: any) => { eventWhere = options.where; return []; } })) as any);
        const invoiceMock = mock.method(Invoice, 'schema', (() => ({ findAll: async (options: any) => { invoiceWhere = options.where; return []; } })) as any);
        try {
            const result = await loadFinanceData(request, query({ operatorId: ownerId }));
            assert.equal(eventWhere.calendarId, ownerId);
            assert.ok(eventWhere.patientId[Op.in].val.includes(ownerId));
            assert.ok(invoiceWhere.patientID[Op.in].val.includes(ownerId));
            assert.equal(result.payments.length, 0);
        } finally { eventMock.mock.restore(); invoiceMock.mock.restore(); }
    });

    it('does not resurrect a released therapy link from the void invoice audit reference', async () => {
        const detached = event({ appointmentExpectedAmount: 100 });
        const voidInvoice = invoice({ agendaEventId: detached.id, status: 'void' });
        const model = (value: any) => ({ ...value, get: () => value });
        let eventCalls = 0;
        const stubs = [
            mock.method(AgendaEvent, 'schema', (() => ({ findAll: async () => ++eventCalls === 1 ? [model(detached)] : [model(detached)] })) as any),
            mock.method(Invoice, 'schema', (() => ({ findAll: async () => [model(voidInvoice)] })) as any),
            mock.method(InvoicePayment, 'schema', (() => ({ findAll: async () => [model(payment())] })) as any),
            mock.method(InvoiceAgendaEvent, 'schema', (() => ({ findAll: async (options: any) => {
                if (options.where.agendaEventId) assert.equal(options.where.releasedAt, null);
                return [];
            } })) as any)
        ];
        try {
            const result = await loadFinanceData({ tenantSchema: 'test_tenant', access: { scope: 'tenant' } } as any, query());
            assert.equal(result.events[0].invoiceId, null);
            assert.equal(aggregateFinance(result, query()).totals.collectedUnbilled, 100);
        } finally { stubs.forEach((stub) => stub.mock.restore()); }
    });

    it('retains filtered USER cash attribution through released document audit links', async () => {
        const detached = event({ appointmentExpectedAmount: 100, calendarId: 'operator-a' });
        const voidInvoice = invoice({ agendaEventId: null, status: 'void' });
        const model = (value: any) => ({ ...value, get: () => value });
        const stubs = [
            mock.method(AgendaEvent, 'schema', (() => ({ findAll: async () => [model(detached)] })) as any),
            mock.method(Invoice, 'schema', (() => ({ findAll: async () => [model(voidInvoice)] })) as any),
            mock.method(InvoicePayment, 'schema', (() => ({ findAll: async () => [model(payment({ agendaEventId: null, invoiceId: 'invoice-1', source: 'USER' }))] })) as any),
            mock.method(InvoiceAgendaEvent, 'schema', (() => ({ findAll: async (options: any) => options.where.agendaEventId ? [] :
                [model({ invoiceId: 'invoice-1', agendaEventId: detached.id, releasedAt: new Date() })] })) as any)
        ];
        try {
            const filters = query({ operatorId: 'operator-a' });
            const result = await loadFinanceData({ tenantSchema: 'test_tenant', access: { scope: 'tenant' } } as any, filters);
            assert.equal(result.events[0].invoiceId, null);
            assert.equal(aggregateFinance(result, filters).totals.collected, 100);
        } finally { stubs.forEach((stub) => stub.mock.restore()); }
    });
});
