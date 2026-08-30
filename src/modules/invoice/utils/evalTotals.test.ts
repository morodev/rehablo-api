import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evalTotals } from './evalTotals.js';

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
