import assert from 'node:assert/strict';
import {it} from 'node:test';
import {Op} from 'sequelize';
import {CarePackage, Expense, PatientCredit, TreasuryMovement} from '../../administration/models/index.js';
import {TenantUser, Structure, StructureUser} from '../../auth/models/index.js';
import {getRolePermissions, RoleCode} from '../../auth/rbac/roles.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import Patient from '../../patients/models/patient.model.js';
import {financialDataset, unassignedFinancialWarnings} from './financialReporting.service.js';
import {financialDiagnosticsDataset} from './financialDiagnostics.service.js';
import {clinicalCashFacts} from './financialFacts.service.js';
import {reportExportSnapshot} from './reporting.types.js';
import {getDataset, getPersonal} from '../controllers/reporting.controller.js';

type Row = Record<string, any>;
const site = '11111111-1111-4111-8111-111111111111';
const otherSite = '22222222-2222-4222-8222-222222222222';
const patient = '33333333-3333-4333-8333-333333333333';
const operator = '44444444-4444-4444-8444-444444444444';
const scope = {tenantId: 'tenant', userId: operator, scope: 'assigned', allowedStructureIds: [site, otherSite], selectedStructureIds: [site, otherSite], structures: [{id: site, name: 'Uno'}, {id: otherSite, name: 'Due'}]};
const request = (query: Row = {}): any => ({tenantSchema: 'test', reportScope: scope, access: {scope: 'structure', structureId: site},
    query: {from: '2026-01-01', to: '2026-01-31', compare: 'none', issueCode: 'unmirrored-payments', ...query}});
const model = (row: Row): any => ({...row, get: (key?: unknown) => typeof key === 'string' ? row[key] : {...row}});
function fixture(t: any, input: {invoices?: Row[]; events?: Row[]; payments?: Row[]; movements?: Row[]}) {
    const invoices = input.invoices ?? [], events = input.events ?? [], payments = input.payments ?? [], movements = input.movements ?? [];
    const inSites = (row: Row, where: any) => !where?.structureId || where.structureId[Op.in].includes(row.structureId);
    const patientFilter = (where: any, field: string) => where[Op.and]?.find((part: any) => part[field])?.[field];
    t.mock.method(Invoice, 'schema', (() => ({findAll: async ({where}: any) => invoices.filter(row => inSites(row, where)
        && (!patientFilter(where, 'patientID') || row.patientID === patientFilter(where, 'patientID'))).map(model)})) as any);
    t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async ({where}: any) => !where.structureId ? [] : events.filter(row => inSites(row, where)
        && (!where.calendarId || row.calendarId === where.calendarId) && (!where.eventTypeId || row.eventTypeId === where.eventTypeId)
        && (!patientFilter(where, 'patientId') || row.patientId === patientFilter(where, 'patientId'))).map(model)})) as any);
    t.mock.method(InvoicePayment, 'schema', (() => ({findAll: async ({where}: any) => payments.filter(row => where[Op.or].some((branch: any) =>
        Object.entries(branch).some(([field, condition]: any) => condition[Op.in]?.includes(row[field])))).map(model)})) as any);
    t.mock.method(TreasuryMovement, 'schema', (() => ({findAll: async ({where}: any) => movements.filter(row => inSites(row, where)
        && (!where[Op.or] || where[Op.or].some((branch: any) => branch.sourceId?.[Op.in]?.includes(row.sourceId) || branch.id?.[Op.in]?.includes(row.id)))).map(model)})) as any);
    t.mock.method(Patient, 'schema', (() => ({findAll: async () => [model({id: patient, name: 'Anna', surname: 'Rossi'})]})) as any);
    for (const entity of [CarePackage, Expense, PatientCredit, InvoiceAgendaEvent]) t.mock.method(entity, 'schema', (() => ({findAll: async () => []})) as any);
}
const invoice = (id = 'invoice', structureId = site): Row => ({id, structureId, patientID: patient, documentNumber: 17, documentYear: 2020,
    status: 'paid', emissionDate: '2020-01-01', documentType: 'fattura', invoiceNet: 100, invoiceTotal: 100});
const payment = (id: string, extra: Row = {}): Row => ({id, invoiceId: 'invoice', source: 'USER', status: 'POSTED', amount: 10, paidAt: '2020-01-02', ...extra});
const event = (id: string, extra: Row = {}): Row => ({id, structureId: site, patientId: patient, calendarId: operator, start: '2020-01-01T09:00:00Z',
    status: 'COMPLETED', appointmentExpectedAmount: 50, appointmentPaymentHistoryKnown: false, ...extra});

it('retains exact issue evidence for excluded VOID, duplicate cash IDs, coverage, mismatches and unknown dates', () => {
    const raw = [payment('void', {status: 'VOID'}), payment('unmatched'), payment('unmatched'), payment('mismatch'), payment('undated', {paidAt: null}),
        ...['PACKAGE', 'CREDIT', 'OPENING_BALANCE'].map(source => payment(source, {source}))];
    const result = clinicalCashFacts(raw, [{id: 'wrong-mirror', sourceId: 'mismatch', sourceType: 'INVOICE_PAYMENT', status: 'POSTED', direction: 'IN', amount: 9, occurredAt: '2020-01-02'}]);
    assert.equal(result.facts.some(row => row.paymentId === 'void'), false);
    for (const warning of result.warnings) assert.equal(warning.count, result.issues.filter(row => row.issueCode === warning.code).length);
    assert.equal(result.issues.filter(row => row.issueCode === 'unmirrored-payments').length, 3);
    assert.equal(result.issues.find(row => row.payment.id === 'void')?.reasonCode, 'missing-receipt');
    assert.equal(result.issues.find(row => row.payment.id === 'mismatch')?.reasonCode, 'receipt-amount-mismatch');
    assert.ok(result.issues.every(row => !['PACKAGE', 'CREDIT', 'OPENING_BALANCE'].includes(row.payment.source)));
});

it('matches warning counts to complete paginated history, keeps category count through search and exports all rows once', async t => {
    const payments = Array.from({length: 32}, (_, index) => payment('pay-' + String(index).padStart(2, '0'), {paidAt: index ? '2020-01-02' : null}));
    fixture(t, {invoices: [invoice()], payments: [...payments, payments[3], payment('void', {status: 'VOID'}), payment('credit', {source: 'CREDIT'})]});
    const overview = await financialDataset(request(), 'financial-summary');
    const warning = overview.meta.warnings.find(row => typeof row !== 'string' && row.code === 'unmirrored-payments');
    assert.ok(warning && typeof warning !== 'string');
    const first = await financialDiagnosticsDataset(request());
    const second = await financialDiagnosticsDataset(request({page: '2', size: '25'}));
    assert.equal(warning.count, 32); assert.equal(first.pagination.total, warning.count);
    assert.equal(first.rows.length, 25); assert.equal(second.rows.length, 7);
    assert.equal(new Set([...first.rows, ...second.rows].map(row => row.id)).size, 32);
    assert.equal(first.rows[0].date, null); assert.equal(first.rows[0].amount, 10);
    assert.equal(first.rows[1].patient, 'Anna Rossi'); assert.equal(first.rows[1].document, '17/2020');
    assert.equal(first.rows[1].statusLabel, 'Registrato'); assert.equal(first.rows[1].invoiceId, 'invoice');
    const endpoint = await invoke(getDataset, {...request(), params: {dataset: 'financial-diagnostics'}});
    assert.equal(endpoint.status, 200); assert.equal(endpoint.body.data.pagination.total, 32);
    const searched = await financialDiagnosticsDataset(request({query: 'Original report text retained', diagnosticSearch: 'pay-31'}));
    assert.equal(searched.pagination.total, 1); assert.equal(searched.summary[0].value, 32);
    assert.equal(searched.rows[0].paymentId, 'pay-31');
    assert.equal(searched.meta.effectiveFilters.query, 'Original report text retained');
    assert.equal(searched.meta.effectiveFilters.diagnosticSearch, 'pay-31');
    assert.equal(first.meta.dateBasis, 'current_history'); assert.equal(first.meta.comparisonPeriod, null);
    assert.equal('from' in first.meta.effectiveFilters, false); assert.equal('to' in first.meta.effectiveFilters, false);
    assert.equal('from' in warning.drilldown!.filters, false);
    const exported = reportExportSnapshot('financial-diagnostics', await financialDiagnosticsDataset(request({page: '2'}), {allRows: true}));
    assert.equal(exported.rows.length, 32); assert.equal(exported.title, 'Dati economici da verificare');
    assert.equal('pagination' in exported, false);
    const excluded = await financialDiagnosticsDataset(request({issueCode: 'legacy-void'}));
    assert.equal(excluded.rows[0].paymentId, 'void'); assert.equal(excluded.pagination.total, 1);
});

it('classifies unknown current balances exactly as the summary and preserves unknown amounts without claiming paid', async t => {
    fixture(t, {events: [event('history'), event('price', {appointmentExpectedAmount: null, appointmentPaymentHistoryKnown: true}),
        event('known', {appointmentPaymentHistoryKnown: true}), event('future', {start: '2099-01-01T09:00:00Z'}),
        event('complimentary', {appointmentPriceAdjustment: 'COMPLIMENTARY'}), event('invoiced', {invoiceId: 'old'}),
        event('cancelled', {status: 'CANCELLED'}), event('recurring', {recurrence: 'RRULE'}), event('missing-date', {start: null}),
        event('package', {carePackageId: 'package-id', packageReservationStatus: 'CONSUMED'})]});
    const overview = await financialDataset(request(), 'financial-summary');
    const warning = overview.meta.warnings.find(row => typeof row !== 'string' && row.code === 'unknown-appointment-balances');
    assert.ok(warning && typeof warning !== 'string');
    const result = await financialDiagnosticsDataset(request({issueCode: 'unknown-appointment-balances'}));
    assert.equal(result.pagination.total, warning.count);
    assert.deepEqual(result.rows.map(row => row.sourceId).sort(), ['history', 'price']);
    assert.ok(result.rows.every(row => row.amount === null && row.amountBasis === 'Da verificare'));
    assert.equal(result.rows.find(row => row.sourceId === 'history')?.reasonCode, 'unknown-payment-history');
    assert.equal(result.rows.find(row => row.sourceId === 'price')?.reasonCode, 'unverified-price');
    const filtered = await financialDiagnosticsDataset(request({issueCode: 'unknown-appointment-balances', paymentStatus: 'paid'}));
    assert.equal(filtered.pagination.total, 0);
});

it('honors authorized site and patient context and preserves cash classifier scope before payment status filters', async t => {
    fixture(t, {invoices: [invoice(), invoice('other', otherSite)], payments: [payment('a'), payment('b', {invoiceId: 'other'})]});
    const scoped = {...scope, selectedStructureIds: [site]};
    const req = {...request({paymentStatus: 'paid', patientId: patient}), reportScope: scoped};
    const overview = await financialDataset(req, 'financial-summary');
    const warning = overview.meta.warnings.find(row => typeof row !== 'string' && row.code === 'unmirrored-payments');
    assert.ok(warning && typeof warning !== 'string');
    assert.deepEqual(warning.drilldown!.filters.structureIds, [site]);
    assert.equal(warning.drilldown!.filters.patientId, patient);
    assert.equal('paymentStatus' in warning.drilldown!.filters, false);
    const result = await financialDiagnosticsDataset({...req, query: warning.drilldown!.filters});
    assert.equal(result.pagination.total, warning.count); assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].structureId, site);
});

it('rejects invalid issue/search/page filters and personal scope before model reads', async () => {
    for (const query of [{issueCode: 'other'}, {issueCode: ['legacy-void']}, {query: {}}, {query: 'x'.repeat(256)}, {diagnosticSearch: {}}, {diagnosticSearch: 'x'.repeat(256)}, {sourceDataset: []}, {sourceDataset: 'bad'}, {page: '0'}, {size: '201'}, {page: ['1']}]) {
        await assert.rejects(financialDiagnosticsDataset(request(query)), /non valid/);
    }
    await assert.rejects(financialDiagnosticsDataset({...request(), reportScope: {...scope, scope: 'own'}}), (error: any) => error.statusCode === 403);
});

function invoke(handler: any, req: any): Promise<{status: number; body: any}> {
    return new Promise((resolve, reject) => {
        let status = 0;
        const res: any = {status(value: number) {status = value; return this;}, json(body: any) {resolve({status, body}); return this;}};
        handler(req, res, reject);
    });
}
it('dataset endpoint rejects an unauthorized site and personal endpoint rejects financial diagnostics', async t => {
    t.mock.method(TenantUser, 'findOne', (async () => model({role: RoleCode.OWNER})) as any);
    t.mock.method(StructureUser, 'findAll', (async () => []) as any);
    t.mock.method(Structure, 'findAll', (async () => [model({id: site, name: 'Uno'})]) as any);
    const owner: any = {tenantSchema: 'test', user: {sub: operator, tid: 'tenant', role: RoleCode.OWNER, perms: getRolePermissions(RoleCode.OWNER)},
        params: {dataset: 'financial-diagnostics'}, query: {issueCode: 'unmirrored-payments', structureIds: otherSite}};
    const forbidden = await invoke(getDataset, owner); assert.equal(forbidden.status, 403);
    const personal = await invoke(getPersonal, {...owner, query: {dataset: 'financial-diagnostics'}}); assert.equal(personal.status, 403);
});

it('shows original mismatch evidence and dates a verified historical reversal by its own ledger movement', async t => {
    const movements = [{id: 'mirror', sourceId: 'dated', sourceType: 'INVOICE_PAYMENT', status: 'POSTED', direction: 'IN', amount: 10, occurredAt: '2020-02-01', accountId: 'account'},
        {id: 'void-mirror', sourceId: 'voided', sourceType: 'INVOICE_PAYMENT', status: 'VOID', direction: 'IN', amount: 10, occurredAt: '2020-01-02', accountId: 'account'},
        {id: 'reversal', sourceId: 'voided', sourceType: 'INVOICE_PAYMENT_VOID', status: 'POSTED', direction: 'OUT', amount: 10, occurredAt: '2020-03-04', accountId: 'account', reversalOfId: 'void-mirror'}];
    fixture(t, {invoices: [invoice()], payments: [payment('dated'), payment('voided', {status: 'VOID'})], movements});
    const dates = await financialDiagnosticsDataset(request({issueCode: 'cash-date-mismatch'}));
    assert.equal(dates.rows.length, 1); assert.equal(dates.rows[0].date, '2020-01-02');
    assert.equal(dates.rows[0].treasuryDate, '2020-02-01'); assert.equal(dates.rows[0].treasuryAmount, 10);
    const reversal = await financialDiagnosticsDataset(request({issueCode: 'legacy-reversal-kind'}));
    assert.equal(reversal.rows.length, 1); assert.equal(reversal.rows[0].date, '2020-03-04'); assert.equal(reversal.rows[0].amount, -10);
    assert.equal(reversal.rows[0].status, 'VOID'); assert.equal(reversal.rows[0].treasuryMovementId, 'reversal');
});


/** Small Sequelize predicate evaluator keeps fixtures focused on actual economic boundary records. */
function matchesWhere(row: Row, where: any): boolean {
    const compare = (actual: any, condition: any): boolean => {
        if (condition == null || typeof condition !== 'object' || condition instanceof Date) return (actual ?? null) === condition;
        return Reflect.ownKeys(condition).every(key => {
            const expected = condition[key];
            if (key === Op.in) return actual != null && expected.includes(actual);
            if (key === Op.notIn) return actual != null && !expected.includes(actual);
            if (key === Op.not) return actual !== expected;
            if (key === Op.between) {
                const value = expected[0] instanceof Date ? new Date(actual).getTime() : actual;
                const from = expected[0] instanceof Date ? expected[0].getTime() : expected[0], to = expected[1] instanceof Date ? expected[1].getTime() : expected[1];
                return actual != null && value >= from && value <= to;
            }
            if (key === Op.lte) return actual != null && new Date(actual).getTime() <= new Date(expected).getTime();
            throw new Error('Unhandled fixture condition ' + String(key));
        });
    };
    return Reflect.ownKeys(where).every(key => key === Op.or ? where[key].some((part: any) => matchesWhere(row, part))
        : key === Op.and ? where[key].every((part: any) => matchesWhere(row, part)) : compare(row[key as string], where[key]));
}
function diagnosticFixture(t: any, data: {documents?: Row[]; events?: Row[]; payments?: Row[]; treasury?: Row[]; expenses?: Row[]; links?: Row[]}) {
    for (const [entity, rows] of [[Invoice, data.documents ?? []], [AgendaEvent, data.events ?? []], [InvoicePayment, data.payments ?? []],
        [TreasuryMovement, data.treasury ?? []], [Expense, data.expenses ?? []], [InvoiceAgendaEvent, data.links ?? []], [CarePackage, []], [PatientCredit, []]] as Array<[any, Row[]]>) {
        t.mock.method(entity, 'schema', (() => ({
            findAll: async ({where = {}}: any = {}) => rows.filter(row => matchesWhere(row, where)).map(model),
            count: async ({where}: any) => rows.filter(row => matchesWhere(row, where)).length
        })) as any);
    }
    t.mock.method(Patient, 'schema', (() => ({findAll: async () => [model({id: patient, name: 'Anna', surname: 'Rossi'})]})) as any);
}
const ownerRequest = (query: Row = {}): any => ({...request(query), user: {role: 'OWNER'}});

it('uses shared selectors for all five unassigned warning counts and readable lists without related-site leakage', async t => {
    diagnosticFixture(t, {
        documents: [invoice('orphan-document', null as any), {...invoice('orphan-january', null as any), emissionDate: '2026-01-20'},
            {...invoice('void-document', null as any), emissionDate: '2026-01-20', status: 'void'}, invoice('assigned-document', site)],
        events: [event('orphan-event', {structureId: null, start: '2026-01-10T09:00:00Z', status: 'CANCELLED'}),
            event('timezone-included', {structureId: null, start: '2025-12-31T23:30:00Z'}),
            event('timezone-excluded', {structureId: null, start: '2026-01-31T23:30:00Z'}), event('assigned-event', {structureId: site, title: 'Secret assigned event'})],
        treasury: [{id: 'orphan-treasury', structureId: null, occurredAt: '2026-01-10T12:00:00Z', description: 'Entrata senza sede', direction: 'IN', amount: 30, status: 'POSTED', invoiceId: 'assigned-document'},
            {id: 'assigned-treasury', structureId: site, occurredAt: '2026-01-10T12:00:00Z', amount: 500, status: 'POSTED'}],
        expenses: [{id: 'orphan-expense', structureId: null, incurredAt: '2026-01-14', description: 'Spesa senza sede', amount: 40, status: 'OPEN'},
            {id: 'old-expense', structureId: null, incurredAt: '2020-01-01', amount: 50, status: 'OPEN'}],
        payments: [payment('orphan-payment', {invoiceId: 'orphan-document', agendaEventId: 'orphan-event', carePackageId: null, paidAt: '2026-01-20'}),
            payment('orphan-void', {invoiceId: null, agendaEventId: null, carePackageId: null, paidAt: '2026-01-20', status: 'VOID'}),
            payment('related-assigned-invoice', {invoiceId: 'assigned-document', agendaEventId: null, carePackageId: null, paidAt: '2026-01-20'}),
            payment('related-assigned-event', {invoiceId: null, agendaEventId: 'assigned-event', carePackageId: null, paidAt: '2026-01-20'}),
            payment('opening', {invoiceId: null, agendaEventId: null, carePackageId: null, source: 'OPENING_BALANCE', paidAt: '2026-01-20'})]
    });
    const warnings = await unassignedFinancialWarnings(ownerRequest(), scope as any, '2026-01-01', '2026-01-31');
    const expected: Row = {'unassigned-documents': ['orphan-january'], 'unassigned-appointments': ['orphan-event', 'timezone-included'],
        'unassigned-treasury': ['orphan-treasury'], 'unassigned-expenses': ['orphan-expense'], 'unassigned-payments': ['orphan-payment', 'orphan-void']};
    assert.equal(warnings.length, 5);
    for (const warning of warnings) {
        const detail = await financialDiagnosticsDataset({...ownerRequest(), query: {...warning.drilldown!.filters, query: 'Original scope text'}});
        assert.equal(detail.pagination.total, warning.count, warning.code);
        assert.equal(detail.summary[0].value, warning.count, warning.code);
        assert.deepEqual(detail.rows.map(row => row.paymentId ?? row.treasuryMovementId ?? row.sourceId).sort(), expected[warning.code].sort(), warning.code);
        assert.ok(detail.rows.every(row => row.structure === 'Senza sede' && row.structureId === null));
        assert.equal(detail.meta.dateBasis, 'period'); assert.equal(detail.meta.effectiveFilters.from, '2026-01-01');
        assert.equal(detail.meta.effectiveFilters.query, 'Original scope text');
        assert.ok(!JSON.stringify(detail.rows).includes('"assigned-document"'));
        assert.ok(!JSON.stringify(detail.rows).includes('Secret assigned event'));
    }
    const payments = await financialDiagnosticsDataset(ownerRequest({issueCode: 'unassigned-payments', diagnosticSearch: 'orphan-payment'}));
    assert.equal(payments.rows.length, 1); assert.equal(payments.summary[0].value, 2);
    assert.equal(payments.rows[0].patient, 'Anna Rossi'); assert.equal(payments.rows[0].document, '17/2020');
    assert.equal(payments.rows[0].agendaEventId, 'orphan-event');
});

it('keeps unassigned receivables on current/history scope and applies the same owner/all-sites gate to warning and rows', async t => {
    diagnosticFixture(t, {documents: [invoice('old-orphan', null as any), {...invoice('void-orphan', null as any), status: 'void'}],
        events: [event('old-event', {structureId: null}), event('future-event', {structureId: null, start: '2099-01-01T09:00:00Z'})]});
    const current = await unassignedFinancialWarnings(ownerRequest(), scope as any, '2026-01-01', '2026-01-31', 'receivables');
    assert.deepEqual(current.map(row => row.code).sort(), ['unassigned-appointments', 'unassigned-documents']);
    for (const warning of current) {
        assert.equal('from' in warning.drilldown!.filters, false);
        const result = await financialDiagnosticsDataset({...ownerRequest(), query: warning.drilldown!.filters});
        assert.equal(result.pagination.total, warning.count); assert.equal(result.pagination.total, 1);
        assert.equal(result.meta.dateBasis, 'current_history'); assert.equal('from' in result.meta.effectiveFilters, false);
    }
    for (const denied of [{...ownerRequest(), user: {role: 'ADMIN_SECRETARY'}}, {...ownerRequest(), reportScope: {...scope, selectedStructureIds: [site]}}]) {
        assert.deepEqual(await unassignedFinancialWarnings(denied, denied.reportScope, '2026-01-01', '2026-01-31'), []);
        await assert.rejects(financialDiagnosticsDataset({...denied, query: {...denied.query, issueCode: 'unassigned-documents'}}), (error: any) => error.statusCode === 403);
    }
    await assert.rejects(financialDiagnosticsDataset(ownerRequest({issueCode: 'unassigned-treasury', sourceDataset: 'receivables'})), /report di origine/);
});

it('lists mixed document IDs from the same all-history attribution classifier without exposing other-site therapies', async t => {
    const selectedEvent = event('visible-event', {invoiceId: 'mixed', appointmentPaymentHistoryKnown: true});
    const forbiddenEvent = event('forbidden-child', {structureId: otherSite, calendarId: otherSite, invoiceId: 'mixed', title: 'Other site private therapy'});
    diagnosticFixture(t, {documents: [invoice('mixed'), {...invoice('void-mixed'), status: 'void'}], events: [selectedEvent, forbiddenEvent],
        links: [{invoiceId: 'mixed', agendaEventId: selectedEvent.id, releasedAt: null}, {invoiceId: 'mixed', agendaEventId: forbiddenEvent.id, releasedAt: null}]});
    const req = {...request({operatorId: operator, query: 'Original document search'}), reportScope: {...scope, selectedStructureIds: [site]}};
    const overview = await financialDataset(req, 'documents');
    const warning = overview.meta.warnings.find(row => typeof row !== 'string' && row.code === 'mixed-documents');
    assert.ok(warning && typeof warning !== 'string'); assert.equal(warning.count, 1);
    assert.equal(warning.drilldown!.dataset, 'financial-diagnostics'); assert.equal(warning.drilldown!.filters.sourceDataset, 'documents');
    const detail = await financialDiagnosticsDataset({...req, query: {...warning.drilldown!.filters, diagnosticSearch: '17/2020'}});
    assert.equal(detail.pagination.total, warning.count); assert.equal(detail.rows[0].sourceId, 'mixed');
    assert.equal(detail.rows[0].patient, 'Anna Rossi'); assert.equal(detail.rows[0].date, '2020-01-01');
    assert.equal(detail.meta.dateBasis, 'current_history'); assert.equal('from' in detail.meta.effectiveFilters, false);
    const output = JSON.stringify(detail.rows);
    assert.ok(!output.includes('forbidden-child')); assert.ok(!output.includes(otherSite)); assert.ok(!output.includes('Other site private therapy'));
});
