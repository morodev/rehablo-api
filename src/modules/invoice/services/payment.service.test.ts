import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarizeInvoicePayments } from './payment.service.js';

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

    it('neutralises balances for void invoices', () => {
        assert.deepEqual(summarizeInvoicePayments(
            { invoiceTotal: 100, status: 'void' },
            [{ amount: 25, status: 'POSTED', paidAt: '2026-08-10' }]
        ), {
            paidAmount: 0,
            balance: 0,
            paymentStatus: 'void',
            hasUndatedLegacyPayments: false
        });
    });
});
