import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPatientPaymentPositions } from './patientPaymentPosition.service.js';

const reference = {
    id: 'current', patientId: 'patient-1', start: '2026-09-08T10:00:00.000Z', invoiceId: null
};

describe('buildPatientPaymentPositions', () => {
    it('shows prior unpaid and partial sessions while excluding gifts and waived no-shows', () => {
        const historicalEvents = [
            {id: 'unpaid', patientId: 'patient-1', start: '2026-09-01T10:00:00.000Z', status: 'COMPLETED', title: 'Terapia', appointmentPaymentHistoryKnown: true},
            {id: 'partial', patientId: 'patient-1', start: '2026-09-02T10:00:00.000Z', status: 'COMPLETED', title: 'Massaggio', appointmentPaymentHistoryKnown: true},
            {id: 'gift', patientId: 'patient-1', start: '2026-09-03T10:00:00.000Z', status: 'COMPLETED', appointmentPriceAdjustment: 'COMPLIMENTARY'},
            {id: 'waived', patientId: 'patient-1', start: '2026-09-04T10:00:00.000Z', status: 'NO_SHOW', noShowBillingDecision: 'WAIVED'},
            {id: 'other-patient', patientId: 'patient-2', start: '2026-09-05T10:00:00.000Z', status: 'COMPLETED', appointmentPaymentHistoryKnown: true}
        ];
        const position = buildPatientPaymentPositions([reference], {
            historicalEvents,
            prices: new Map([
                ['unpaid', {amount: 50}], ['partial', {amount: 50}], ['gift', {amount: 0}],
                ['waived', {amount: 50}], ['other-patient', {amount: 100}]
            ]),
            payments: [{agendaEventId: 'partial', amount: 25, status: 'POSTED'}],
            invoices: [], invoiceSummaries: new Map(), invoiceIdByEventId: new Map(),
            now: Date.parse('2026-09-08T12:00:00.000Z')
        }).get('current')!;

        assert.equal(position.status, 'DUE');
        assert.equal(position.appointmentCount, 2);
        assert.equal(position.invoiceCount, 0);
        assert.equal(position.outstandingAmount, 75);
        assert.deepEqual(position.items.map(item => [item.id, item.balance, item.paymentStatus]), [
            ['unpaid', 50, 'unpaid'], ['partial', 25, 'partial']
        ]);
    });

    it('counts an open invoice once and does not duplicate its linked appointment', () => {
        const historicalEvents = [
            {id: 'first', patientId: 'patient-1', start: '2026-08-01T10:00:00.000Z', status: 'COMPLETED', invoiceId: 'invoice-1'},
            {id: 'second', patientId: 'patient-1', start: '2026-08-08T10:00:00.000Z', status: 'COMPLETED', invoiceId: 'invoice-1'}
        ];
        const position = buildPatientPaymentPositions([reference], {
            historicalEvents, prices: new Map(), payments: [],
            invoices: [{id: 'invoice-1', emissionDate: '2026-08-10', documentNumber: 12, documentYear: 2026}],
            invoiceSummaries: new Map([['invoice-1', {paidAmount: 40, balance: 60, paymentStatus: 'partial', hasUndatedLegacyPayments: false}]]),
            invoiceIdByEventId: new Map(), now: Date.parse('2026-09-08T12:00:00.000Z')
        }).get('current')!;

        assert.equal(position.openItemCount, 1);
        assert.equal(position.appointmentCount, 0);
        assert.equal(position.invoiceCount, 1);
        assert.equal(position.outstandingAmount, 60);
        assert.equal(position.items[0].title, 'Fattura 12/2026');
    });

    it('uses verify instead of regular when a prior session has no reliable payment state', () => {
        const position = buildPatientPaymentPositions([reference], {
            historicalEvents: [{
                id: 'legacy', patientId: 'patient-1', start: '2026-08-01T10:00:00.000Z',
                status: 'COMPLETED', title: 'Seduta storica', appointmentPaymentHistoryKnown: false
            }],
            prices: new Map([['legacy', {amount: 50}]]), payments: [], invoices: [],
            invoiceSummaries: new Map(), invoiceIdByEventId: new Map(),
            now: Date.parse('2026-09-08T12:00:00.000Z')
        }).get('current')!;

        assert.equal(position.status, 'VERIFY');
        assert.equal(position.openItemCount, 0);
        assert.equal(position.unknownCount, 1);
        assert.equal(position.items[0].balance, null);
    });

    it('returns regular when every prior balance is settled', () => {
        const position = buildPatientPaymentPositions([reference], {
            historicalEvents: [{
                id: 'paid', patientId: 'patient-1', start: '2026-08-01T10:00:00.000Z',
                status: 'COMPLETED', appointmentPaymentHistoryKnown: true
            }],
            prices: new Map([['paid', {amount: 50}]]),
            payments: [{agendaEventId: 'paid', amount: 50, status: 'POSTED'}],
            invoices: [], invoiceSummaries: new Map(), invoiceIdByEventId: new Map(),
            now: Date.parse('2026-09-08T12:00:00.000Z')
        }).get('current')!;

        assert.deepEqual(position, {
            status: 'REGULAR', openItemCount: 0, appointmentCount: 0, invoiceCount: 0,
            unknownCount: 0, outstandingAmount: 0, items: []
        });
    });
});
