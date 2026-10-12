import assert from 'node:assert/strict';
import {it} from 'node:test';
import {buildPatientSettlementPosition, validatePatientSettlementAllocations, PatientSettlementSources} from './patientSettlementPolicy.service.js';

const patientId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const structureId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const context = {patientId, structureId, referenceAgendaEventId: 'current'};
const event = (id: string, start: string, extra: Record<string, any> = {}) => ({id, patientId, structureId,
    start, end: new Date(Date.parse(start) + 60_000).toISOString(), status: 'COMPLETED', title: id,
    appointmentPaymentHistoryKnown: true, ...extra});
const invoice = (id: string, emissionDate: string, extra: Record<string, any> = {}) => ({id, patientID: patientId,
    structureId, emissionDate, documentNumber: 1, documentYear: 2026, documentType: 'fattura', status: 'unpaid',
    invoiceNet: 60, invoiceTotal: 80, ...extra});
const sources = (extra: Partial<PatientSettlementSources> = {}): PatientSettlementSources => ({
    events: [event('current', '2026-10-12T09:00:00Z')], invoices: [], links: [], payments: [],
    prices: new Map([['current', {amount: 60}], ['old', {amount: 60}], ['older', {amount: 60}]]),
    now: Date.parse('2026-10-12T12:00:00Z'), ...extra
});

it('includes autonomous prior invoices and blocks paying the current appointment first', () => {
    const position = buildPatientSettlementPosition(context, sources({invoices: [invoice('invoice', '2026-09-20')]}));
    assert.deepEqual(position.queue.map(row => row.key), ['INVOICE:invoice', 'APPOINTMENT:current']);
    assert.equal(position.queue[0].balance, 60, 'net payable is canonical, not the gross 80');
    assert.throws(() => validatePatientSettlementAllocations(position.queue, [{kind: 'APPOINTMENT', targetId: 'current', amount: 60}]), /precedente/);
});
it('counts a cumulative document once and anchors it to its oldest linked prestation', () => {
    const position = buildPatientSettlementPosition(context, sources({events: [event('current', '2026-10-12T09:00:00Z'),
        event('old', '2026-09-05T09:00:00Z'), event('older', '2026-09-10T09:00:00Z')],
        invoices: [invoice('invoice', '2026-10-08')], links: [{invoiceId: 'invoice', agendaEventId: 'old'}, {invoiceId: 'invoice', agendaEventId: 'older'}]}));
    assert.deepEqual(position.queue.map(row => row.key), ['INVOICE:invoice', 'APPOINTMENT:current']);
    assert.equal(position.queue[0].orderDate, '2026-09-05T09:00:00.000Z');
    assert.equal(position.queue[0].linkedEventIds.length, 2);
});
it('excludes other premises, credit notes, void and draft documents', () => {
    const position = buildPatientSettlementPosition(context, sources({invoices: [invoice('other', '2026-09-01', {structureId: 'other'}),
        invoice('void', '2026-09-01', {status: 'void'}), invoice('credit', '2026-09-01', {documentType: 'nota_di_credito'}),
        invoice('draft', '2026-09-01', {documentNumber: null})]}));
    assert.equal(position.queue.length, 1);
});
it('resolves a linked legacy invoice without a site once, but excludes autonomous unassigned documents', () => {
    const position = buildPatientSettlementPosition(context, sources({events: [event('current', '2026-10-12T09:00:00Z'),
        event('old', '2026-09-01T09:00:00Z', {invoiceId: 'legacy'})],
        invoices: [invoice('legacy', '2026-10-08', {structureId: null}), invoice('unassigned', '2026-09-01', {structureId: null})]}));
    assert.deepEqual(position.queue.map(row => row.key), ['INVOICE:legacy', 'APPOINTMENT:current']);
});
it('does not offer a second receipt for an appointment with an unresolved fiscal link', () => {
    const position = buildPatientSettlementPosition(context, sources({events: [event('current', '2026-10-12T09:00:00Z'),
        event('old', '2026-09-01T09:00:00Z', {invoiceId: 'missing'})]}));
    assert.deepEqual(position.queue.map(row => row.key), ['APPOINTMENT:current']);
    assert.equal(position.verification[0].agendaEventId, 'old');
});
it('keeps verified unpriced debt selectable and separates uncertain history/no-show', () => {
    const position = buildPatientSettlementPosition(context, sources({events: [event('current', '2026-10-12T09:00:00Z'),
        event('old', '2026-09-05T09:00:00Z'), event('uncertain', '2026-09-03T09:00:00Z', {appointmentPaymentHistoryKnown: false}),
        event('absent', '2026-09-02T09:00:00Z', {status: 'NO_SHOW'}),
        event('waived', '2026-09-01T09:00:00Z', {status: 'NO_SHOW', noShowBillingDecision: 'WAIVED'})], prices: new Map([['current', {amount: 60}]])}));
    assert.equal(position.queue[0].targetId, 'old'); assert.equal(position.queue[0].balance, null);
    assert.deepEqual(position.verification.map(row => row.reason), ['NO_SHOW', 'UNVERIFIED_HISTORY']);
    assert.equal(validatePatientSettlementAllocations(position.queue, [{kind: 'APPOINTMENT', targetId: 'old', amount: 45}]).length, 1);
});
it('does not resurrect legacy money after an existing VOID movement', () => {
    const position = buildPatientSettlementPosition(context, sources({events: [event('current', '2026-10-12T09:00:00Z',
        {appointmentPaidAmount: 60, appointmentPaymentStatus: 'paid'})], payments: [{agendaEventId: 'current', amount: 60, status: 'VOID', source: 'APPOINTMENT'}]}));
    assert.equal(position.current!.paidAmount, 0); assert.equal(position.current!.balance, 60);
});
it('preserves a settled reference and coverage origin while removing it from the payable queue', () => {
    const position = buildPatientSettlementPosition(context, sources({payments: [{agendaEventId: 'current', amount: 60, status: 'POSTED', source: 'PACKAGE', method: 'Pacchetto', paidAt: '2026-10-12'}]}));
    assert.equal(position.current!.balance, 0); assert.equal(position.queue.length, 0);
    assert.deepEqual(position.current!.coverageSources, ['PACKAGE']);
});
it('keeps older debts available for a future reference and blocks current', () => {
    const position = buildPatientSettlementPosition(context, sources({events: [event('current', '2026-10-13T09:00:00Z'), event('old', '2026-10-01T09:00:00Z')]}));
    assert.equal(position.current!.eligible, false); assert.deepEqual(position.queue.map(row => row.targetId), ['old']);
});
it('does not turn an uncertain reference history into a definite zero-paid debt', () => {
    const position = buildPatientSettlementPosition(context, sources({events: [event('current', '2026-10-12T09:00:00Z',
        {appointmentPaymentHistoryKnown: false})]}));
    assert.equal(position.current!.balance, null); assert.equal(position.current!.eligible, false);
});
it('uses the read occurrence date without making a recurring current collectible', () => {
    const position = buildPatientSettlementPosition({...context, referenceOccurrenceStart: '2026-10-12T09:00:00Z'},
        sources({events: [event('current', '2026-08-01T09:00:00Z', {recurrence: 'FREQ=WEEKLY'})]}));
    assert.equal(position.referenceEvent!.start, '2026-10-12T09:00:00Z'); assert.equal(position.current!.eligible, false);
});
it('requires a full single session but permits only the final partial when two appointments are selected', () => {
    const position = buildPatientSettlementPosition(context, sources({events: [event('current', '2026-10-12T09:00:00Z'), event('old', '2026-10-01T09:00:00Z')]}));
    assert.throws(() => validatePatientSettlementAllocations(position.queue, [{kind: 'APPOINTMENT', targetId: 'old', amount: 40}]), /integralmente/);
    assert.equal(validatePatientSettlementAllocations(position.queue, [{kind: 'APPOINTMENT', targetId: 'old', amount: 60},
        {kind: 'APPOINTMENT', targetId: 'current', amount: 40}]).length, 2);
});
it('an invoice plus one appointment does not unlock a partial appointment', () => {
    const position = buildPatientSettlementPosition(context, sources({invoices: [invoice('invoice', '2026-09-01')]}));
    assert.throws(() => validatePatientSettlementAllocations(position.queue, [{kind: 'INVOICE', targetId: 'invoice', amount: 60},
        {kind: 'APPOINTMENT', targetId: 'current', amount: 40}]), /integralmente/);
    assert.equal(validatePatientSettlementAllocations(position.queue, [{kind: 'INVOICE', targetId: 'invoice', amount: 20}]).length, 1);
    assert.throws(() => validatePatientSettlementAllocations(position.queue, [{kind: 'INVOICE', targetId: 'invoice', amount: 20},
        {kind: 'APPOINTMENT', targetId: 'current', amount: 60}]), /residuo precedente/);
});
