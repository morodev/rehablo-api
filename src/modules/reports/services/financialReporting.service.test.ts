import assert from 'node:assert/strict';
import { beforeEach, it } from 'node:test';
import { Op } from 'sequelize';
import { CarePackage, Expense, PatientCredit, TreasuryMovement } from '../../administration/models/index.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import Patient from '../../patients/models/patient.model.js';
import { financialDataset, treasuryProjection, unassignedFinancialWarnings } from './financialReporting.service.js';
import { reportCsv } from './reporting.types.js';

beforeEach((t: any) => { t.mock.method(CarePackage, 'schema', (() => ({findAll: async () => []})) as any); });

const site = '11111111-1111-4111-8111-111111111111';
const otherSite = '22222222-2222-4222-8222-222222222222';
const scope = { tenantId: 'tenant', userId: 'user', scope: 'assigned', allowedStructureIds: [site, otherSite],
    selectedStructureIds: [site, otherSite], structures: [{ id: site, name: 'Uno' }, { id: otherSite, name: 'Due' }] };
const req = (query: Record<string, string> = {}) => ({ tenantSchema: 'test_tenant', reportScope: scope,
    access: { scope: 'structure', structureId: site }, query: { from: '2026-01-01', to: '2026-01-31', compare: 'none', ...query } }) as any;
const model = (value: any): any => ({ ...value, get: (field?: unknown) => typeof field === 'string' ? value[field] : value });

it('documents and CSV cover the complete authorized set beyond the first page', async t => {
    const invoices = Array.from({ length: 235 }, (_, index) => ({ id: `invoice-${index}`, structureId: index % 2 ? site : otherSite,
        patientID: null, emissionDate: '2026-01-10', invoiceTotal: 10, invoiceNet: 10, status: 'unpaid', documentType: 'fattura', documentNumber: index + 1, documentYear: 2026 }));
    let seen: any;
    t.mock.method(Invoice, 'schema', (() => ({ findAll: async (options: any) => { seen = options.where; return invoices.map(model); } })) as any);
    for (const entity of [AgendaEvent, InvoiceAgendaEvent, InvoicePayment, Patient, PatientCredit, TreasuryMovement]) {
        t.mock.method(entity, 'schema', (() => ({ findAll: async () => [] })) as any);
    }
    const page = await financialDataset(req({ page: '2', size: '25' }), 'documents');
    const exported = await financialDataset(req({ page: '2', size: '25' }), 'documents', { allRows: true });
    assert.deepEqual(seen.structureId[Op.in], [site, otherSite]);
    assert.equal(page.rows.length, 25);
    assert.equal(page.pagination.total, 235);
    assert.equal(page.summary[0].value, 2350);
    assert.equal(exported.rows.length, 235);
    assert.equal(exported.summary[0].value, exported.rows.reduce((sum, row) => sum + row.amount, 0));
    const lines = reportCsv(exported).split('\r\n');
    const heading = lines.findIndex(line => line.startsWith('"Documento";'));
    assert.ok(heading >= 0);
    assert.equal(lines.length - heading - 1, 235);
});

it('treasury category filtering resolves reversal pairs before filtering the category', () => {
    const result = treasuryProjection([
        { id: 'original', accountId: 'account', direction: 'IN', amount: 100, status: 'VOID', category: 'RECEIPT', occurredAt: '2026-01-10' },
        { id: 'reversal', accountId: 'account', direction: 'OUT', amount: 100, status: 'POSTED', category: 'REVERSAL', reversalOfId: 'original', occurredAt: '2026-02-10' }
    ], [], '2026-01-01', '2026-01-31', { category: 'RECEIPT' });
    assert.equal(result.income, 100);
});

it('cashflow dataset reconciles signed details with totals and does not count an unpaid expense as an outgoing payment', async t => {
    t.mock.method(TreasuryMovement, 'schema', (() => ({ findAll: async () => [
        model({ id: 'in', structureId: site, status: 'POSTED', direction: 'IN', amount: 100, occurredAt: '2026-01-01' }),
        model({ id: 'out', structureId: otherSite, status: 'POSTED', direction: 'OUT', amount: 40, occurredAt: '2026-01-02' }),
        model({ id: 'previous-in', structureId: site, status: 'POSTED', direction: 'IN', amount: 70, occurredAt: '2025-12-01' }),
        model({ id: 'previous-out', structureId: otherSite, status: 'POSTED', direction: 'OUT', amount: 30, occurredAt: '2025-12-02' })
    ] })) as any);
    t.mock.method(Expense, 'schema', (() => ({ findAll: async () => [model({ id: 'cost', structureId: site, status: 'OPEN', amount: 200, incurredAt: '2026-01-03' })] })) as any);
    const result = await financialDataset(req(), 'treasury');
    assert.equal(result.summary.find(row => row.key === 'cashFlow')?.value, 60);
    assert.equal(result.rows.reduce((sum, row) => sum + row.amount, 0), 60);
    assert.equal(result.columns.find(row => row.key === 'amount')?.type, 'currency');
    const outgoing = await financialDataset(req({ direction: 'OUT', compare: 'previous_period' }), 'treasury');
    assert.equal(outgoing.rows.length, 1);
    assert.equal(outgoing.rows[0].amount, -40);
    assert.equal(outgoing.summary.find(row => row.key === 'cashFlow')?.previousValue, -30);
    assert.equal(outgoing.summary.find(row => row.key === 'income')?.previousValue, 0);
});

it('rejects clinical filters on expenses rather than returning unaffected totals', async () => {
    await assert.rejects(financialDataset(req({ operatorId: '33333333-3333-4333-8333-333333333333' }), 'expenses'), /filtri clinici/);
    await assert.rejects(financialDataset(req({ patientId: '33333333-3333-4333-8333-333333333333' }), 'treasury'), /filtri clinici/);
    await assert.rejects(financialDataset(req({ kind: 'receipt' }), 'documents'), /Tipo movimento/);
    await assert.rejects(financialDataset(req({ dueBucket: 'today' }), 'payments'), /scadenza/);
});

it('current receivables reconcile invoice balances and unbilled therapies with the summary', async t => {
    const invoices = [{ id: 'old', structureId: site, patientID: 'patient', emissionDate: '2023-01-01', invoiceTotal: 80, invoiceNet: 80,
        status: 'unpaid', documentType: 'fattura', documentNumber: 1, documentYear: 2023 },
        { id: 'credit-note', structureId: site, emissionDate: '2026-01-01', invoiceTotal: 20, invoiceNet: 20, status: 'unpaid', documentType: 'nota_di_credito' }];
    const event = { id: 'event', structureId: otherSite, patientId: 'patient', start: '2023-01-02T09:00:00Z', status: 'COMPLETED',
        appointmentExpectedAmount: 60, appointmentPaymentHistoryKnown: true };
    const unknown = { ...event, id: 'unknown', appointmentExpectedAmount: null, appointmentPaymentHistoryKnown: false };
    t.mock.method(Invoice, 'schema', (() => ({ findAll: async () => invoices.map(model) })) as any);
    t.mock.method(AgendaEvent, 'schema', (() => ({ findAll: async () => [model(event), model(unknown)] })) as any);
    t.mock.method(InvoicePayment, 'schema', (() => ({ findAll: async () => [model({ id: 'payment', agendaEventId: event.id, source: 'APPOINTMENT', status: 'POSTED', amount: 20, paidAt: '2026-01-03' })] })) as any);
    for (const entity of [InvoiceAgendaEvent, Patient, PatientCredit, TreasuryMovement, Expense]) {
        t.mock.method(entity, 'schema', (() => ({ findAll: async () => [] })) as any);
    }
    const overview = await financialDataset(req(), 'financial-summary');
    const detail = await financialDataset(req(), 'receivables');
    assert.equal(overview.summary.find(row => row.key === 'outstanding')?.value, 120);
    assert.equal(detail.summary[0].value, 120);
    assert.equal(detail.rows.reduce((total, row) => total + row.amount, 0), 120);
    assert.equal(detail.rows.find(row => row.targetType === 'appointment')?.start, event.start);
    assert.equal(detail.rows.find(row => row.targetType === 'appointment')?.structureId, otherSite);
    assert.equal(detail.rows.find(row => row.targetType === 'appointment')?.amountBasis, 'Importo registrato');
    assert.ok(detail.meta.warnings.some(row => typeof row !== 'string' && row.code === 'unknown-appointment-balances' && row.count === 1));
    assert.equal(detail.meta.comparisonPeriod, null);
    assert.ok(detail.summary.every(row => row.previousValue === undefined));
});

it('applies patient and document search before document and payment totals and CSV', async t => {
    const invoices = ['a', 'b'].map((id, index) => ({ id, patientID: id, structureId: site, emissionDate: '2026-01-01', status: 'paid', documentType: 'fattura',
        invoiceTotal: 50, invoiceNet: 50, documentNumber: index + 7, documentYear: 2026 }));
    invoices.push({ ...invoices[0], id: 'previous', emissionDate: '2025-12-01', invoiceTotal: 20, invoiceNet: 20 });
    t.mock.method(Invoice, 'schema', (() => ({ findAll: async () => invoices.map(model) })) as any);
    t.mock.method(InvoicePayment, 'schema', (() => ({ findAll: async () => invoices.map(invoice => model({ id: `payment-${invoice.id}`, invoiceId: invoice.id,
        source: 'USER', status: 'POSTED', amount: invoice.invoiceTotal, paidAt: invoice.id === 'previous' ? '2025-12-02' : '2026-01-02' })) })) as any);
    t.mock.method(Patient, 'schema', (() => ({ findAll: async () => [model({ id: 'a', name: 'Luca', surname: 'Bianchi' }), model({ id: 'b', name: 'Anna', surname: 'Rossi' })] })) as any);
    for (const entity of [AgendaEvent, InvoiceAgendaEvent, PatientCredit, TreasuryMovement]) t.mock.method(entity, 'schema', (() => ({ findAll: async () => [] })) as any);
    for (const dataset of ['documents', 'payments']) {
        const result = await financialDataset(req({ query: 'BIANCHI' }), dataset, { allRows: true });
        assert.equal(result.rows.length, 1);
        assert.equal(result.summary[0].value, 50);
        assert.ok(!reportCsv(result).includes('Anna Rossi'));
        assert.equal((await financialDataset(req({ query: '8/2026' }), dataset)).rows[0].patient, 'Anna Rossi');
        const comparison = await financialDataset(req({ query: 'BIANCHI', compare: 'previous_period' }), dataset);
        assert.equal(comparison.summary[0].previousValue, 20);
        assert.equal(comparison.meta.comparisonPeriod?.from, '2025-12-01');
    }
});

it('returns only owner diagnostics for unassigned records and never queries them for assigned administrators', async t => {
    let calls = 0;
    t.mock.method(Invoice, 'schema', (() => ({ count: async (options: any) => {
        calls++; assert.equal(options.where.structureId, null);
        assert.deepEqual(options.where.emissionDate[Op.between], ['2026-01-01', '2026-01-31']); return 3;
    } })) as any);
    const tenantScope = { ...scope, scope: 'tenant' as const };
    const owner = { ...req(), user: { role: 'OWNER' } };
    const result = await unassignedFinancialWarnings(owner, tenantScope, '2026-01-01', '2026-01-31', 'documents');
    assert.equal(result[0].count, 3);
    assert.equal(result[0].code, 'unassigned-documents');
    assert.ok(/esclusi dai totali/.test(result[0].message));
    assert.deepEqual(await unassignedFinancialWarnings({ ...req(), user: { role: 'ADMIN_SECRETARY' } }, scope as any, '2026-01-01', '2026-01-31', 'documents'), []);
    assert.deepEqual(await unassignedFinancialWarnings(owner, { ...tenantScope, selectedStructureIds: [site] }, '2026-01-01', '2026-01-31', 'documents'), []);
    assert.equal(calls, 1);
});

it('filters current receivables without restricting them to the issue period', async t => {
    const invoices = [{ id: 'old', structureId: site, patientID: 'patient', emissionDate: '2023-01-01', invoiceTotal: 80, invoiceNet: 80,
        status: 'unpaid', documentType: 'fattura', documentNumber: 1, documentYear: 2023, paymentTerms: null }];
    t.mock.method(Invoice, 'schema', (() => ({ findAll: async () => invoices.map(model) })) as any);
    t.mock.method(Patient, 'schema', (() => ({ findAll: async () => [model({ id: 'patient', name: 'Luca', surname: 'Bianchi' })] })) as any);
    for (const entity of [AgendaEvent, InvoiceAgendaEvent, InvoicePayment, PatientCredit, TreasuryMovement]) {
        t.mock.method(entity, 'schema', (() => ({ findAll: async () => [] })) as any);
    }
    const result = await financialDataset(req({ dueBucket: 'no_due', query: 'bianchi' }), 'receivables');
    assert.equal(result.rows.length, 1);
    assert.equal(result.summary[0].value, 80);
    assert.equal(result.meta.dateBasis, 'current');
    const filtered = await financialDataset(req({ dueBucket: 'overdue' }), 'receivables');
    assert.equal(filtered.rows.length, 0);
});
