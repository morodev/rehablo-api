import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clinicalCashFacts, validIssuedDocument } from './financialFacts.service.js';
import { aggregateFinance, FinanceData, FinanceQuery } from './finance.service.js';
import { administrationFinancialProjection, treasuryProjection } from './financialReporting.service.js';

const payment = { id: 'p', invoiceId: 'invoice', amount: 100, paidAt: '2026-09-10', source: 'USER', status: 'VOID' };
const receipt = { id: 'cash', sourceType: 'INVOICE_PAYMENT', sourceId: 'p', accountId: 'account', structureId: 'site',
    amount: 100, direction: 'IN', status: 'POSTED', occurredAt: '2026-09-10T10:00:00Z' };
const reversal = { id: 'reverse', sourceType: 'INVOICE_PAYMENT_VOID', sourceId: 'p', accountId: 'account', structureId: 'site',
    reversalOfId: 'cash', amount: 100, direction: 'OUT', status: 'POSTED', occurredAt: '2026-10-12T10:00:00Z' };
const query = (from: string, to: string): FinanceQuery => ({ from, to, granularity: 'month', compare: 'none', structureId: null,
    operatorId: null, eventTypeId: null, paymentStatus: 'all', documentStatus: 'all', paymentMethod: null });

describe('financial facts preserve monetary history without writes', () => {
    it('records receipt and verified reversal in their own months while current settlement stays void', () => {
        const cash = clinicalCashFacts([payment], [receipt, reversal]);
        const data: FinanceData = { events: [], payments: [payment], invoices: [{ id: 'invoice', status: 'unpaid', emissionDate: '2026-09-01', invoiceTotal: 100 }],
            attributableInvoiceIds: new Set(['invoice']), excludedMixedInvoiceCount: 0, cashFacts: cash.facts };
        assert.equal(aggregateFinance(data, query('2026-09-01', '2026-09-30')).totals.collected, 100);
        assert.equal(aggregateFinance(data, query('2026-10-01', '2026-10-31')).totals.collected, -100);
        assert.equal(aggregateFinance(data, query('2026-09-01', '2026-10-31')).totals.collected, 0);
        assert.equal(payment.status, 'VOID');
    });
    it('does not infer cash from an unpaired legacy void or from coverage', () => {
        const result = clinicalCashFacts([payment, { ...payment, id: 'coverage', status: 'POSTED', source: 'CREDIT' }]);
        assert.equal(result.facts.length, 0);
        assert.ok(result.warnings.some(row => row.code === 'legacy-void'));
    });
    it('rejects a mismatched reversal and retains an undated cash fact without inventing a date', () => {
        assert.equal(clinicalCashFacts([payment], [receipt, { ...reversal, amount: 90 }]).facts.length, 0);
        const result = clinicalCashFacts([{ ...payment, status: 'POSTED', paidAt: null }], [receipt]);
        assert.equal(result.facts[0].paidAt, null);
        assert.ok(result.warnings.some(row => row.code === 'undated-payments'));
    });
    it('counts a retained credit once and subtracts only its verified cash refund', () => {
        const refund = { id: 'refund-cash', sourceType: 'PATIENT_CREDIT_REFUND', sourceId: 'refund', amount: 30, direction: 'OUT', status: 'POSTED', occurredAt: '2026-10-01T10:00:00Z' };
        const result = clinicalCashFacts([{ ...payment, status: 'CREDIT' }], [receipt, refund],
            [{ id: 'credit', sourceType: 'VOID_CREDIT', sourceId: 'p' }], [{ id: 'refund', type: 'REFUND', creditId: 'credit', treasuryMovementId: refund.id, amount: 30 }]);
        assert.deepEqual(result.facts.map(row => row.amount), [100, -30]);
        assert.equal(result.facts[1].kind, 'refund');
    });
    it('separates treasury cashflow from unpaid expenses and excludes invalid documents', () => {
        const docs = [ { id: 'a', status: 'paid', structureId: 'site', emissionDate: '2026-09-01', invoiceTotal: 100, documentType: 'fattura' },
            { id: 'b', status: 'void', structureId: 'site', emissionDate: '2026-09-01', invoiceTotal: 200, documentType: 'fattura' },
            { id: 'c', status: 'unpaid', structureId: 'site', emissionDate: '2026-09-01', invoiceTotal: 20, documentType: 'nota_di_credito' } ];
        const costs = [{ structureId: 'site', incurredAt: '2026-09-01', amount: 40, status: 'OPEN' }];
        const report = administrationFinancialProjection(docs, [receipt, reversal], costs, [{ id: 'site', name: 'Sede' }], '2026-09-01', '2026-10-31');
        assert.equal(report.issued, 80);
        assert.equal(report.expenses, 40);
        assert.equal(report.cashFlow, 0);
        assert.equal(report.categories.reduce((total, row) => total + row.value, 0), 80);
        assert.equal(report.structures[0].cashFlow, 0);
        assert.equal(validIssuedDocument({ status: 'draft', emissionDate: '2026-09-01' }), false);
    });
    it('recognizes advances and their refunds without treating a credit application as new cash', () => {
        const result = treasuryProjection([{ ...receipt, sourceType: 'PATIENT_ADVANCE' },
            { ...reversal, reversalOfId: null, sourceType: 'PATIENT_CREDIT_REFUND', amount: 25 }], [], '2026-09-01', '2026-10-31');
        assert.equal(result.advances, 100);
        assert.equal(result.creditRefunds, 25);
        assert.equal(result.cashFlow, 75);
    });
    it('fills empty monthly buckets with zero', () => {
        const data: FinanceData = { events: [], payments: [], invoices: [], attributableInvoiceIds: new Set(), excludedMixedInvoiceCount: 0 };
        const result = aggregateFinance(data, query('2026-01-01', '2026-03-31'));
        assert.equal(result.series.length, 3);
        assert.deepEqual(result.series.map(row => row.collected), [0, 0, 0]);
    });
});
