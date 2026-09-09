import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {invoiceEmissionMonth, parseInvoiceMonthFilter} from './invoiceFilters.js';

describe('invoice list month filter', () => {
    it('treats missing and explicit "all" values as no restriction', () => {
        assert.equal(parseInvoiceMonthFilter(undefined), '');
        assert.equal(parseInvoiceMonthFilter(null), '');
        assert.equal(parseInvoiceMonthFilter(''), '');
        assert.equal(parseInvoiceMonthFilter('all'), '');
    });

    it('accepts a well formed month key', () => {
        assert.equal(parseInvoiceMonthFilter('2026-09'), '2026-09');
        assert.equal(parseInvoiceMonthFilter(' 2026-01 '), '2026-01');
        assert.equal(parseInvoiceMonthFilter('2026-12'), '2026-12');
    });

    it('rejects malformed months instead of ignoring them', () => {
        assert.equal(parseInvoiceMonthFilter('2026-13'), null);
        assert.equal(parseInvoiceMonthFilter('2026-00'), null);
        assert.equal(parseInvoiceMonthFilter('2026-9'), null);
        assert.equal(parseInvoiceMonthFilter('2026-09-01'), null);
        assert.equal(parseInvoiceMonthFilter('settembre'), null);
    });

    it('reads the month from the emission date whatever its shape', () => {
        assert.equal(invoiceEmissionMonth('2026-09-14'), '2026-09');
        assert.equal(invoiceEmissionMonth('2026-09-14T10:00:00.000Z'), '2026-09');
        assert.equal(invoiceEmissionMonth(null), '');
    });
});
