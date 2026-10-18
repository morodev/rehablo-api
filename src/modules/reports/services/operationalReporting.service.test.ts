import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {Request} from 'express';
import {Op} from 'sequelize';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import AgendaEventException from '../../agenda/models/agendaEventException.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import InvoiceProduct from '../../invoice/models/invoiceProduct.model.js';
import InvoiceService from '../../invoice/models/invoiceService.model.js';
import {StructureAvailability, StructureUserAvailability, StructureUser, TenantUser, User} from '../../auth/models/index.js';
import TimeOffRequest from '../../agenda/models/timeOffRequest.model.js';
import {PatientCredit, TreasuryMovement} from '../../administration/models/index.js';
import Patient from '../../patients/models/patient.model.js';
import {operationalDataset} from './operationalReporting.service.js';
import {capacityValues, mergeIntervals, followupEligible} from './operationalMetrics.js';
import {reportCsv} from './reporting.types.js';
import {addDays, aggregateActivity, expandRecurringEvent, localDateKey, parseAnalyticsQuery, type AnalyticsQuery} from './analytics.service.js';

const site = '11111111-1111-4111-8111-111111111111';
const otherSite = '22222222-2222-4222-8222-222222222222';
const patientId = '33333333-3333-4333-8333-333333333333';
const record = (data: any): any => ({...data, get: () => ({...data})});
const request = (query: Record<string, unknown> = {}): Request => ({tenantSchema: 'test', user: {sub: 'owner', tid: 'tenant', perms: []}, access: {scope: 'tenant'},
    reportScope: {userId: 'owner', tenantId: 'tenant', allowedStructureIds: [site, otherSite], selectedStructureIds: [site, otherSite], structures: [], scope: 'tenant'},
    query: {from: '2026-08-01', to: '2026-08-31', compare: 'none', ...query}} as unknown as Request);
function fixtures(t: any, events: any[]) {
    t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async ({where}: any) => {
        assert.deepEqual(where.structureId[Op.in], [site, otherSite]);
        return events.map(record);
    }})) as any);
    t.mock.method(InvoiceAgendaEvent, 'schema', (() => ({findAll: async () => []})) as any);
    t.mock.method(AgendaEventException, 'schema', (() => ({findAll: async () => []})) as any);
    t.mock.method(Patient, 'schema', (() => ({findAll: async () => []})) as any);
    t.mock.method(Invoice, 'schema', (() => ({findAll: async () => []})) as any);
    t.mock.method(InvoicePayment, 'schema', (() => ({findAll: async () => []})) as any);
}
const event = (id: string, overrides: any = {}) => ({id, structureId: site, start: '2026-08-10T08:00:00Z', end: '2026-08-10T09:00:00Z',
    status: 'COMPLETED', patientId, patient: {name: '=Mario', surname: 'Test'}, title: 'Terapia', recurrence: null, ...overrides});

describe('unified operational dataset', () => {
    it('exports current and previous summary values even without detail rows', () => {
        const csv = reportCsv({meta: {effectiveFilters: {from: '2026-08-01', to: '2026-08-31'}, generatedAt: '2026-09-01T08:00:00Z', dateBasis: 'issue', warnings: [], comparisonPeriod: {from: '2026-07-01', to: '2026-07-31'}},
            summary: [{key: 'billed', label: 'Fatturato', value: 100, previousValue: 80, format: 'currency', description: 'Documenti emessi'}], columns: [], rows: [], pagination: {total: 0, page: 1, size: 0}});
        assert.ok(csv.includes('"Indicatore";"Valore";"Valore precedente";"Unità";"Descrizione"'));
        assert.ok(csv.includes('"Fatturato";"100";"80";"currency";"Documenti emessi"'));
        assert.ok(csv.includes('"Confronto dal";"2026-07-01"'));
    });
    it('paginates without truncation, totals and export include every selected occurrence', async t => {
        fixtures(t, Array.from({length: 251}, (_, i) => event(String(i))));
        const page = await operationalDataset(request({page: '2', size: '100'}), 'sessions');
        const full = await operationalDataset(request({size: '100'}), 'sessions', {allRows: true});
        assert.equal(page.pagination.total, 251); assert.equal(page.rows.length, 100); assert.equal(full.rows.length, 251);
        assert.equal(page.summary.find(row => row.key === 'completed')?.value, 251);
        assert.equal(full.rows[0].targetType, 'appointment'); assert.equal(full.rows[0].sourceId, full.rows[0].id);
        const csv = reportCsv(full);
        assert.equal(csv.split('\r\n').filter(line => line.includes("'=Mario Test")).length, 251);
        assert.ok(csv.includes('Report generato il')); assert.ok(csv.includes('Sedi')); assert.ok(csv.includes('Filtri applicati'));
        assert.ok(csv.includes('Effettuate')); assert.ok(csv.includes('2026-08-01'));
    });
    it('uses local hour and weekday filters consistently with drilldown and export', async t => {
        fixtures(t, [event('selected', {status: 'NO_SHOW'}), event('wrong-status'), event('wrong-hour', {start: '2026-08-10T10:00:00Z', status: 'NO_SHOW'})]);
        const result = await operationalDataset(request({status: 'NO_SHOW', weekday: '0', hour: '10'}), 'sessions');
        assert.deepEqual(result.rows.map(row => row.id), ['selected']);
        assert.equal(result.summary.find(row => row.key === 'noShow')?.value, 1);
    });
    it('zero-fills the time axis and does not invent a rate or comparison without a denominator', async t => {
        fixtures(t, []);
        const result = await operationalDataset(request({from: '2026-08-01', to: '2026-08-03'}), 'activity-summary');
        assert.equal(result.rows.length, 3); assert.deepEqual(result.series![0].points.map(point => point.value), [0, 0, 0]);
        assert.equal(result.summary.find(row => row.key === 'cancellationRate')?.value, null);
        assert.equal(result.summary[0].previousValue, undefined);
    });
    it('rejects malformed calendar dates, oversized pages and unknown clinical status', async () => {
        assert.throws(() => parseAnalyticsQuery(request({from: '2026-02-31'})), /Intervallo/);
        await assert.rejects(() => operationalDataset(request({size: '101'}), 'sessions'), /size/);
        await assert.rejects(() => operationalDataset(request({status: 'invented'}), 'sessions'), /Stato/);
        assert.throws(() => parseAnalyticsQuery(request({from: ['2026-08-01']})), /from/);
        await assert.rejects(() => operationalDataset(request({page: ['1']}), 'sessions'), /page/);
        await assert.rejects(() => operationalDataset(request({query: {name: 'Mario'}}), 'sessions'), /query/);
        await assert.rejects(() => operationalDataset(request({thresholdDays: '60', lookbackDays: '30'}), 'patient-followups'), /soglia/);
    });
    it('does not resolve names of zero-activity operators outside the selected structures', async t => {
        t.mock.method(StructureUser, 'findAll', (async ({where}: any) => {assert.deepEqual(where.structureId[Op.in], [site]); return [];}) as any);
        t.mock.method(User, 'findAll', (async () => {assert.fail('unscoped user lookup');}) as any);
        const result = await aggregateActivity('test', {...parseAnalyticsQuery(request()), structureIds: [site], operatorId: 'external-user'}, []);
        assert.deepEqual(result.operators, []);
    });
    it('keeps partial, unknown and complimentary session financial states and filters totals before pagination', async t => {
        const events = [event('partial', {appointmentExpectedAmount: 100, appointmentPaymentHistoryKnown: true}),
            event('unknown', {appointmentExpectedAmount: 80}), event('gift', {appointmentExpectedAmount: 0, appointmentPriceAdjustment: 'COMPLIMENTARY', appointmentPaymentHistoryKnown: true})];
        fixtures(t, events);
        t.mock.method(InvoicePayment, 'schema', (() => ({findAll: async () => [record({id: 'receipt', agendaEventId: 'partial', amount: 40, status: 'POSTED', method: 'Contanti', source: 'APPOINTMENT', paidAt: '2026-08-10'})]})) as any);
        for (const model of [PatientCredit, TreasuryMovement]) t.mock.method(model, 'schema', (() => ({findAll: async () => []})) as any);
        const all = await operationalDataset(request(), 'sessions');
        assert.equal(all.rows.find(row => row.id === 'partial')?.balance, 60);
        assert.equal(all.rows.find(row => row.id === 'unknown')?.balance, null);
        assert.equal(all.rows.find(row => row.id === 'gift')?.paymentStatusLabel, 'Omaggio');
        const filtered = await operationalDataset(request({paymentStatus: 'partial', paymentMethod: 'Contanti', documentStatus: 'unbilled', size: '1'}), 'sessions');
        assert.equal(filtered.pagination.total, 1); assert.equal(filtered.rows[0].id, 'partial');
        assert.equal(filtered.summary.find(row => row.key === 'completed')?.value, 1);
        assert.equal(filtered.summary.find(row => row.key === 'outstanding')?.value, 60);
        assert.equal(filtered.meta.effectiveFilters.paymentStatus, 'partial');
        assert.ok(reportCsv(filtered).includes('Residuo seduta noto'));
    });
    it('leaves cumulative invoice amounts off individual sessions and counts the invoice once', async t => {
        const events = [event('first', {invoiceId: 'bill', appointmentExpectedAmount: 70}), event('second', {invoiceId: 'bill', appointmentExpectedAmount: 80})];
        fixtures(t, events);
        // loadFinanceData separately reads all children of the accessible invoice.
        t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async () => events.map(record)})) as any);
        t.mock.method(Invoice, 'schema', (() => ({findAll: async () => [record({id: 'bill', structureId: site, invoiceTotal: 150, status: 'unpaid', documentType: 'fattura', emissionDate: '2026-08-01'})]})) as any);
        const result = await operationalDataset(request({paymentStatus: 'unpaid', documentStatus: 'invoiced'}), 'sessions');
        assert.equal(result.rows.length, 2);
        assert.ok(result.rows.every(row => row.paidAmount === null && row.balance === null && row.invoicePaymentStatus === 'unpaid'));
        assert.equal(result.summary.find(row => row.key === 'invoiceOutstanding')?.value, 150);
    });
    it('honors COUNT when expanding a recurring series', () => {
        const query: AnalyticsQuery = {from: '2026-08-01', to: '2026-08-31', granularity: 'day', compare: 'none', structureId: null, operatorId: null, eventTypeId: null};
        const rows = expandRecurringEvent(event('master', {start: '2026-08-03T08:00:00Z', end: '2026-08-31T23:59:59Z', duration: 60, recurrence: 'FREQ=WEEKLY;COUNT=2;BYDAY=MO'}), new Set(), query);
        assert.equal(rows.length, 2);
    });
    it('returns a deliberate unavailable state for capacity across multiple sites', async () => {
        const result = await operationalDataset(request(), 'capacity');
        assert.equal((result.meta.warnings[0] as any).code, 'SELECT_STRUCTURE'); assert.equal(result.rows.length, 0);
    });
    it('retains billed catalog lines and allocates only the document discount, subtracting credit notes', async t => {
        for (const model of [AgendaEvent, InvoiceAgendaEvent, InvoicePayment]) t.mock.method(model, 'schema', (() => ({findAll: async () => []})) as any);
        t.mock.method(Invoice, 'schema', (() => ({findAll: async () => [
            record({id: 'issued', emissionDate: '2026-08-01', status: 'unpaid', documentType: 'fattura', discSellingPrice: 120}),
            record({id: 'credit', emissionDate: '2026-08-02', status: 'unpaid', documentType: 'nota_di_credito', discSellingPrice: 50})
        ]})) as any);
        t.mock.method(InvoiceProduct, 'schema', (() => ({findAll: async () => [
            record({InvoiceId: 'issued', ProductId: 'product', productName: 'Prodotto', quantity: 2, totalPrice: 100}),
            record({InvoiceId: 'credit', ProductId: 'product', productName: 'Prodotto', quantity: 1, totalPrice: 50})
        ]})) as any);
        t.mock.method(InvoiceService, 'schema', (() => ({findAll: async () => [record({InvoiceId: 'issued', ServiceId: 'service', serviceName: 'Servizio', quantity: 1, totalPrice: 50})]})) as any);
        const result = await operationalDataset(request(), 'services');
        assert.equal(result.meta.dateBasis, 'appointment_and_issue');
        assert.equal(result.rows.find(row => row.eventTypeName === 'Prodotto')?.netRevenue, 30);
        assert.equal(result.rows.find(row => row.eventTypeName === 'Prodotto')?.quantity, 1);
        assert.equal(result.rows.find(row => row.eventTypeName === 'Servizio')?.netRevenue, 40);
        assert.ok(result.rows.every(row => row.section === 'Catalogo fatturato'));
    });
    it('keeps revenue for an operator with no appointments in the issue period', async t => {
        const operatorId = '44444444-4444-4444-8444-444444444444';
        const historical = event('historic', {start: '2026-07-01T08:00:00Z', end: '2026-07-01T09:00:00Z', calendarId: operatorId});
        t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async (options: any) => options.attributes || !options.where[Op.or] ? [record(historical)] : []})) as any);
        for (const model of [InvoiceAgendaEvent, InvoicePayment]) t.mock.method(model, 'schema', (() => ({findAll: async () => []})) as any);
        t.mock.method(Invoice, 'schema', (() => ({findAll: async () => [record({id: 'issued', agendaEventId: historical.id, emissionDate: '2026-08-01', status: 'unpaid', documentType: 'fattura', invoiceTotal: 90})]})) as any);
        t.mock.method(User, 'findAll', (async () => [{id: operatorId, name: 'Anna', surname: 'Test'}]) as any);
        const result = await operationalDataset(request(), 'operators');
        assert.equal(result.rows.length, 1); assert.equal(result.rows[0].completed, 0); assert.equal(result.rows[0].attributedRevenue, 90);
    });
    it('does not attribute a mixed-site invoice to its only visible operator', async t => {
        const historical = event('visible', {start: '2026-07-01T08:00:00Z', end: '2026-07-01T09:00:00Z', calendarId: 'visible-owner', invoiceId: 'issued'});
        const hidden = event('hidden', {structureId: otherSite, calendarId: 'hidden-owner', invoiceId: 'issued'});
        t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async (options: any) => options.attributes ? [record(historical), record(hidden)] : !options.where[Op.or] ? [record(historical)] : []})) as any);
        for (const model of [InvoiceAgendaEvent, InvoicePayment]) t.mock.method(model, 'schema', (() => ({findAll: async () => []})) as any);
        t.mock.method(Invoice, 'schema', (() => ({findAll: async () => [record({id: 'issued', structureId: site, agendaEventId: historical.id, emissionDate: '2026-08-01', status: 'unpaid', documentType: 'fattura', invoiceTotal: 90})]})) as any);
        t.mock.method(User, 'findAll', (async () => {assert.fail('No operator name is needed for unassigned revenue');}) as any);
        const req = request(); (req as any).reportScope.selectedStructureIds = [site];
        const result = await operationalDataset(req, 'operators');
        assert.equal(result.rows.length, 0);
        assert.equal(result.summary.find(row => row.key === 'unassignedRevenue')?.value, 90);
    });
    it('personal reports force the operator and contain no financial metadata', async t => {
        t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async ({where}: any) => {assert.equal(where.calendarId, 'forced-owner'); return [];}})) as any);
        t.mock.method(User, 'findAll', (async () => [{id: 'forced-owner', name: 'Anna', surname: 'Test'}]) as any);
        t.mock.method(StructureUser, 'findAll', (async () => []) as any);
        const req = request(); (req as any).reportScope.operatorId = 'forced-owner';
        const result = await operationalDataset(req, 'activity-summary', {personal: true});
        assert.equal(result.meta.effectiveFilters.operatorId, 'forced-owner');
        assert.ok(result.summary.every(row => row.format !== 'currency'));
        assert.equal(result.summary.find(row => row.key === 'registeredTotal'), undefined);
    });
});

describe('capacity interval arithmetic', () => {
    const minute = 60000;
    it('unions overlapping absences and bookings, preserving free time and conflicts', () => {
        const data = capacityValues([[0, 480 * minute]], [[120 * minute, 180 * minute], [150 * minute, 210 * minute]],
            [[0, 90 * minute], [60 * minute, 120 * minute], [450 * minute, 510 * minute]]);
        assert.equal(data.availableMinutes, 390); assert.equal(data.occupiedMinutes, 150);
        assert.equal(data.freeMinutes, 240); assert.equal(data.overlapMinutes, 30); assert.equal(data.outsideMinutes, 30);
    });
    it('does not treat absent opening hours as zero utilization and includes unbooked capacity', () => {
        assert.equal(capacityValues([], [], []).utilizationRate, null);
        assert.equal(capacityValues([[0, 60 * minute]], [], []).utilizationRate, 0);
        assert.deepEqual(mergeIntervals([[0, 10], [10, 20], [30, 40]]), [[0, 20], [30, 40]]);
    });
    it('excludes deactivated tenant and global users from future availability', async t => {
        const tomorrow = addDays(localDateKey(new Date()), 1);
        t.mock.method(StructureUser, 'findAll', (async () => ['active', 'tenant-disabled', 'global-disabled'].map(userId => ({userId, availabilityMode: 'STRUCTURE'}))) as any);
        t.mock.method(TenantUser, 'findAll', (async ({where}: any) => {assert.equal(where.deactivatedAt, null); assert.equal(where.tenantId, 'tenant'); return [{userId: 'active'}, {userId: 'global-disabled'}];}) as any);
        t.mock.method(User, 'findAll', (async ({where}: any) => {assert.equal(where.deactivatedAt, null); assert.deepEqual(where.id[Op.in], ['active', 'global-disabled']); return [{id: 'active', name: 'Attivo'}];}) as any);
        for (const model of [StructureUserAvailability, StructureAvailability]) t.mock.method(model, 'findAll', (async () => []) as any);
        for (const model of [TimeOffRequest, AgendaEvent]) t.mock.method(model, 'schema', (() => ({findAll: async () => []})) as any);
        const req = request({from: tomorrow, to: tomorrow}); (req as any).reportScope.selectedStructureIds = [site];
        const result = await operationalDataset(req, 'capacity');
        assert.deepEqual(result.rows.map(row => row.operatorId), ['active']);
        assert.equal(result.rows[0].structureId, site);
    });
});

describe('followup selection', () => {
    it('uses the exact inactivity threshold and excludes a future booking', () => {
        assert.equal(followupEligible('2026-09-18', '2026-10-18', 30, null), true);
        assert.equal(followupEligible('2026-09-19', '2026-10-18', 30, null), false);
        assert.equal(followupEligible('2026-09-01', '2026-10-18', 30, '2027-01-01'), false);
    });
    it('does not infer clinical status or expose protocol/package counts without their permission', async t => {
        const past = new Date(); past.setDate(past.getDate() - 45);
        const stop = new Date(past.getTime() + 3600000);
        let count = 0;
        t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async () => ++count === 1 ? [record(event('past', {start: past.toISOString(), end: stop.toISOString()}))] : []})) as any);
        t.mock.method(InvoiceAgendaEvent, 'schema', (() => ({findAll: async () => []})) as any);
        t.mock.method(Patient, 'schema', (() => ({findAll: async ({where}: any) => {assert.equal(where.archivedAt, null); return [{id: patientId, name: 'Mario', surname: 'Test'}];}})) as any);
        const result = await operationalDataset(request(), 'patient-followups');
        assert.equal(result.rows.length, 1); assert.equal(result.rows[0].targetType, 'patient');
        assert.equal(result.rows[0].activeProtocols, undefined); assert.equal(result.rows[0].remainingPackageUnits, undefined);
        assert.equal(result.rows[0].clinicalStatus, undefined);
    });
    it('excludes patients with a future recurrence beyond a short booking horizon, honoring exceptions', async t => {
        const past = new Date(); past.setDate(past.getDate() - 45);
        const future = new Date(); future.setDate(future.getDate() + 100);
        const end = new Date(future); end.setFullYear(end.getFullYear() + 2);
        let count = 0;
        t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async () => ++count === 1
            ? [record(event('past', {start: past.toISOString(), end: new Date(past.getTime() + 3600000).toISOString()}))]
            : [record(event('future', {start: future.toISOString(), end: end.toISOString(), recurrence: 'FREQ=YEARLY;COUNT=2', duration: 60, status: 'CONFIRMED'}))]})) as any);
        t.mock.method(InvoiceAgendaEvent, 'schema', (() => ({findAll: async () => []})) as any);
        t.mock.method(AgendaEventException, 'schema', (() => ({findAll: async () => [{eventId: 'future', exdate: future.toISOString()}]})) as any);
        t.mock.method(Patient, 'schema', (() => ({findAll: async () => [{id: patientId, name: 'Mario', surname: 'Test'}]})) as any);
        const result = await operationalDataset(request(), 'patient-followups');
        assert.equal(result.rows.length, 0);
    });
});
