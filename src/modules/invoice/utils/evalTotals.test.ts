import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evalTotals } from './evalTotals.js';
import { applyAppointmentPriceSnapshot } from './appointmentInvoicePrice.js';

const service = { sellingPrice: 100, quantity: 1, productVat: 'N4' };

describe('evalTotals fiscal options', () => {
    it('does not apply rivals when the option is disabled', () => {
        const totals = evalTotals({ services: [service], isRivals: false, rivals: 4 });
        assert.equal(totals.rivalsAmount, 0);
        assert.equal(totals.invoiceTotal, 100);
    });

    it('applies rivals only to the discounted taxable amount', () => {
        const totals = evalTotals({
            services: [service],
            discountType: 'percentage',
            discountAmount: 10,
            isRivals: true,
            rivals: 4
        });
        assert.equal(totals.discSellingPrice, 90);
        assert.equal(totals.rivalsAmount, 3.6);
        assert.equal(totals.invoiceTotal, 93.6);
    });

    it('adds every selected appointment service to the document total', () => {
        const totals = evalTotals({
            services: [service, service, { ...service, sellingPrice: 80 }]
        });
        assert.equal(totals.sellingPrice, 280);
        assert.equal(totals.invoiceTotal, 280);
    });
});

describe('invoicing paid appointment snapshots', () => {
    const lineFromSnapshot = (gross: number, net: number | null, vatRate: number | null, appliesVat = true) => {
        const line = applyAppointmentPriceSnapshot(
            { source: 'SNAPSHOT', amount: gross, netAmount: net, vatRate },
            { unitPrice: 999, vat: '22' }, appliesVat
        );
        return { sellingPrice: line.unitPrice, quantity: 1, productVat: line.vat };
    };

    for (const [gross, net] of [[50, 40.98], [100, 81.97]]) {
        it('preserves ten appointments paid at ' + gross + ' euros including 22% VAT without a fictitious balance', () => {
            const services = Array.from({ length: 10 }, () => lineFromSnapshot(gross, net, 22));
            const totals = evalTotals({ services, appliesVat: true });
            const collected = gross * 10;
            assert.equal(totals.invoiceTotal, collected);
            assert.equal(totals.invoiceNet, collected);
            assert.equal(Math.max(totals.invoiceNet - collected, 0), 0);
            assert.equal(collected > totals.invoiceNet + 0.009, false);
        });

        it('preserves ten imported gross payments of ' + gross + ' euros without guessing a prior net tariff', () => {
            const services = Array.from({ length: 10 }, () => lineFromSnapshot(gross, null, null));
            assert.equal(evalTotals({ services, appliesVat: true }).invoiceNet, gross * 10);
        });
    }

    it('preserves different historical prices for the same service in separate invoice lines', () => {
        const services = [lineFromSnapshot(50, 40.98, 22), lineFromSnapshot(100, 81.97, 22)];
        assert.deepEqual(services.map(line => line.sellingPrice), [40.98, 81.97]);
        const totals = evalTotals({ services, appliesVat: true });
        assert.equal(totals.invoiceNet, 150);
        assert.equal(totals.invoiceVAT, 27.05);
    });

    it('preserves agreed gross amounts when the issuer regime no longer applies VAT', () => {
        const services = Array.from({ length: 10 }, () => lineFromSnapshot(122, 100, 22, false));
        assert.ok(services.every(line => line.sellingPrice === 122));
        const totals = evalTotals({ services, appliesVat: false });
        assert.equal(totals.invoiceNet, 1220);
        assert.equal(totals.invoiceVAT, 0);
    });

    it('keeps a fixed document discount exact when it is spread over several lines', () => {
        const totals = evalTotals({
            services: [service, service, service], discountType: 'value', discountAmount: 1
        });
        assert.equal(totals.invoiceNet, 299);
    });
});
