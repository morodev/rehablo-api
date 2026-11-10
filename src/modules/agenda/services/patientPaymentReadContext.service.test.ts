import assert from 'node:assert/strict';
import {it} from 'node:test';
import {Op} from 'sequelize';
import AgendaEvent from '../models/agendaEvent.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import {patientPaymentPositionsByReferenceEvents} from './patientPaymentPosition.service.js';

const record = (row: any): any => ({get: () => ({...row})});
it('reuses only overlapping request-local reads while keeping balances per reference date', async t => {
    const historical = [
        {id: 'previous', patientId: 'patient', start: '2026-01-01T09:00:00Z', status: 'COMPLETED', appointmentExpectedAmount: 40, appointmentPaymentHistoryKnown: true},
        {id: 'early', patientId: 'patient', start: '2026-01-02T09:00:00Z', status: 'COMPLETED', appointmentExpectedAmount: 70, appointmentPaymentHistoryKnown: true}
    ];
    const references = [historical[1], {id: 'late', patientId: 'patient', start: '2026-01-02T11:00:00Z'}];
    const linkReads: any[] = [], eventReads: any[] = [];
    t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async (options: any) => {eventReads.push(options); return historical.map(record);}})) as any);
    t.mock.method(InvoiceAgendaEvent, 'schema', (() => ({findAll: async (options: any) => {linkReads.push(options); return [];}})) as any);
    t.mock.method(InvoicePayment, 'schema', (() => ({findAll: async () => []})) as any);
    const options: any = {includeInvoices: false, readContext: {linkedEventIds: new Set(['early', 'late']), links: [],
        prices: new Map([['early', {amount: 70, estimated: false, source: 'SNAPSHOT'}]])}};
    const result = await patientPaymentPositionsByReferenceEvents('rehablo_test', references, {calendarId: 'operator'}, options);
    assert.equal(result.get('early')!.outstandingAmount, 40);
    assert.equal(result.get('late')!.outstandingAmount, 110);
    assert.deepEqual(linkReads[0].where.agendaEventId[Op.in], ['previous']);
    assert.equal(eventReads.length, 1);

    const transaction: any = {LOCK: {UPDATE: 'UPDATE'}};
    options.readContext.prices.set('early', {amount: 999, estimated: false});
    const locked = await patientPaymentPositionsByReferenceEvents('rehablo_test', references, {calendarId: 'operator'}, {...options, transaction, lockRows: true});
    assert.equal(locked.get('late')!.outstandingAmount, 110);
    assert.deepEqual(linkReads[1].where.agendaEventId[Op.in], ['previous', 'early', 'late']);
    assert.equal(eventReads[1].lock, 'UPDATE');
});
