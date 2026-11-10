import assert from 'node:assert/strict';
import {it} from 'node:test';
import {Op} from 'sequelize';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import {CarePackage, PatientCredit, TreasuryMovement} from '../../administration/models/index.js';
import {aggregateFinance, financialSelection, loadFinanceData, type FinanceQuery} from './finance.service.js';
import {appointmentBalanceIssues} from './financialDiagnostics.service.js';

const query: FinanceQuery = {from: '2026-01-01', to: '2026-01-31', compare: 'none', granularity: 'month',
    structureId: null, operatorId: null, eventTypeId: null, paymentStatus: 'all', documentStatus: 'all', paymentMethod: null};
const scope: any = {tenantId: 'tenant', userId: 'user', scope: 'assigned', selectedStructureIds: ['site'], allowedStructureIds: ['site'], structures: []};
const model = (row: any) => ({...row, get: (key?: unknown) => typeof key === 'string' ? row[key] : ({...row})});

it('compact summary preserves historic balances, cash warnings, legacy flags, packages and mixed-context attribution', async t => {
    const events = [
        {id: 'old-partial', patientId: 'patient', start: '2023-01-01T10:00:00Z', status: 'COMPLETED', appointmentExpectedAmount: 100, appointmentPaymentHistoryKnown: true},
        {id: 'legacy-paid', patientId: 'patient', start: '2023-01-01T10:00:00Z', status: 'COMPLETED', appointmentExpectedAmount: null,
            appointmentPaidAmount: 50, appointmentPaymentStatus: 'paid', appointmentPaymentHistoryKnown: false},
        {id: 'unknown', patientId: 'patient', start: '2023-01-01T10:00:00Z', status: 'CONFIRMED', appointmentExpectedAmount: null, appointmentPaymentHistoryKnown: false},
        {id: 'complimentary', patientId: 'patient', start: '2026-01-05T10:00:00Z', status: 'COMPLETED', appointmentExpectedAmount: 0, appointmentPriceAdjustment: 'COMPLIMENTARY', appointmentPaymentHistoryKnown: true},
        {id: 'covered', patientId: 'patient', start: '2026-01-05T10:00:00Z', status: 'COMPLETED', carePackageId: 'pack', packageReservationStatus: 'CONSUMED'},
        {id: 'billed', patientId: 'patient', start: '2026-01-05T10:00:00Z', status: 'COMPLETED', invoiceId: 'bill', appointmentExpectedAmount: 100},
        {id: 'cancelled', patientId: 'patient', start: '2026-01-06T10:00:00Z', status: 'CANCELLED', appointmentExpectedAmount: 100}
    ].map(row => ({...row, structureId: 'site', calendarId: 'operator', patient: {name: 'Sensitive snapshot'}, description: 'Clinical text'}));
    const invoices = [
        {id: 'old-paid', status: 'paid', invoiceTotal: 50, invoiceNet: 50, emissionDate: '2023-01-01'},
        {id: 'bill', status: 'partial', invoiceTotal: 100, invoiceNet: 100, emissionDate: '2026-01-05', agendaEventId: 'billed'},
        {id: 'credit-note', status: 'unpaid', invoiceTotal: 20, invoiceNet: 20, emissionDate: '2026-01-05', documentType: 'nota_di_credito'},
        {id: 'void-bill', status: 'void', invoiceTotal: 30, invoiceNet: 30, emissionDate: '2026-01-05'}
    ].map(row => ({documentType: 'fattura', ...row, structureId: 'site', patientID: 'patient'}));
    const packages = [{id: 'pack', templateId: 'template', totalPrice: 150, structureId: 'site', patientId: 'patient'}];
    const payments = [
        {id: 'p1', agendaEventId: 'old-partial', source: 'APPOINTMENT', amount: 20, status: 'POSTED', paidAt: '2023-01-01'},
        {id: 'p2', invoiceId: 'bill', source: 'USER', amount: 25, status: 'POSTED', paidAt: '2026-01-05'},
        {id: 'p3', invoiceId: 'void-bill', source: 'USER', amount: 30, status: 'POSTED', paidAt: '2026-01-05'},
        {id: 'p4', carePackageId: 'pack', source: 'PACKAGE_PURCHASE', amount: 40, status: 'POSTED', paidAt: '2026-01-05'},
        {id: 'p5', agendaEventId: 'cancelled', source: 'APPOINTMENT', amount: 10, status: 'VOID', paidAt: '2026-01-06'}
    ];
    let eventReads = 0, linkReads = 0;
    const projection = (row: any, options: any) => options.attributes
        ? Object.fromEntries(options.attributes.map((key: string) => [key, row[key]])) : {...row};
    t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async (options: any) => {
        eventReads++;
        const rows = options.where.structureId ? events : [...events, {id: 'outside', structureId: 'hidden', calendarId: 'operator', invoiceId: 'bill'}];
        return rows.map(row => options.raw ? projection(row, options) : model(projection(row, options)));
    }})) as any);
    t.mock.method(Invoice, 'schema', (() => ({findAll: async () => invoices.map(model)})) as any);
    t.mock.method(InvoiceAgendaEvent, 'schema', (() => ({findAll: async (options: any) => {
        linkReads++;
        return [{invoiceId: 'bill', agendaEventId: 'billed'}, ...(options.where.invoiceId ? [{invoiceId: 'bill', agendaEventId: 'outside'}] : [])].map(model);
    }})) as any);
    t.mock.method(CarePackage, 'schema', (() => ({findAll: async (options: any) =>
        packages.map(row => options.raw ? projection(row, options) : model(row))})) as any);
    t.mock.method(InvoicePayment, 'schema', (() => ({findAll: async () => payments.map(model)})) as any);
    for (const entity of [PatientCredit, TreasuryMovement]) t.mock.method(entity, 'schema', (() => ({findAll: async () => []})) as any);
    const req: any = {tenantSchema: 'test_tenant', query: {}};
    for (const filters of [{}, {operatorId: 'operator'}, {paymentStatus: 'unknown'}, {documentStatus: 'unbilled'}]) {
        const selectedQuery = {...query, ...filters} as FinanceQuery;
        const legacy = await loadFinanceData(req, selectedQuery, scope);
        const previousEvents = eventReads, previousLinks = linkReads;
        const compact = await loadFinanceData(req, selectedQuery, scope, undefined, {summary: true});
        assert.deepEqual(aggregateFinance(compact, selectedQuery), aggregateFinance(legacy, selectedQuery));
        const issues = (data: any) => appointmentBalanceIssues(financialSelection(data, selectedQuery)).map(({event, financial}) =>
            ({id: event.id, balance: financial.balance, status: financial.paymentStatus, estimated: financial.priceEstimated}));
        assert.deepEqual(issues(compact), issues(legacy));
        assert.ok(compact.events.every(row => !('patient' in row) && !('description' in row)));
        assert.equal(eventReads - previousEvents, filters.operatorId ? 2 : 1);
        assert.equal(linkReads - previousLinks, filters.operatorId ? 2 : 1);
        if (filters.operatorId) assert.equal(compact.excludedMixedInvoiceCount, 1);
    }
});

it('the financial-summary endpoint reads live SQL aggregates and comparison in the same snapshot without fetching treasury details', async t => {
    const {sequelize} = await import('../../../config/database.js');
    const {Expense} = await import('../../administration/models/index.js');
    const {financialDataset} = await import('./financialReporting.service.js');
    const {withReportReadSnapshot} = await import('./reportReadContext.js');
    const transaction: any = {};
    t.mock.method(sequelize, 'transaction', (async (_options: any, read: any) => read(transaction)) as any);
    let aggregationReads = 0;
    t.mock.method(sequelize, 'query', (async (sql: string, options: any) => {
        assert.equal(options.transaction, transaction);
        if (sql === 'SET TRANSACTION READ ONLY') return [];
        assert.ok(sql.startsWith('WITH periods'));
        assert.deepEqual(options.replacements.structureIds, ['site']);
        aggregationReads++;
        return [{key: 'current', income: '90', outcome: '20', advances: '10', creditRefunds: '5', expenses: '30'},
            {key: 'previous', income: '70', outcome: '15', advances: '0', creditRefunds: '0', expenses: '25'}];
    }) as any);
    for (const entity of [AgendaEvent, Invoice, CarePackage]) t.mock.method(entity, 'schema', (() => ({findAll: async (options: any) => {
        assert.equal(options.transaction, transaction); return [];
    }})) as any);
    for (const entity of [TreasuryMovement, Expense]) t.mock.method(entity, 'schema', (() => {
        throw new Error('Summary must not load full treasury/expense rows');
    }) as any);
    const req: any = {tenantSchema: 'test_tenant', reportScope: scope,
        query: {from: '2026-01-01', to: '2026-01-31', compare: 'previous_period'}};
    const result = await withReportReadSnapshot(req, snapshot => financialDataset(snapshot, 'financial-summary'));
    assert.equal(aggregationReads, 1);
    assert.equal(result.summary.find(row => row.key === 'income')?.value, 90);
    assert.equal(result.summary.find(row => row.key === 'income')?.previousValue, 70);
    assert.equal(result.summary.find(row => row.key === 'cashFlow')?.value, 70);
    assert.equal(result.summary.find(row => row.key === 'cashFlow')?.previousValue, 55);
    assert.equal(result.summary.find(row => row.key === 'outstanding')?.value, 0);
    assert.equal(result.meta.comparisonPeriod?.from, '2025-12-01');
});
