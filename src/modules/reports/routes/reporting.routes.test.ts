import assert from 'node:assert/strict';
import {it} from 'node:test';
import reportsRouter from './reports.routes.js';
import invoiceRouter from '../../invoice/routes/invoice.routes.js';
import {getRolePermissions, RoleCode} from '../../auth/rbac/roles.js';

const targets: Array<[any, string]> = [
    [reportsRouter, '/reports/analytics/summary'], [reportsRouter, '/reports/analytics/catalog'],
    [reportsRouter, '/reports/analytics/operators'], [reportsRouter, '/reports/receivables'],
    [reportsRouter, '/reports/datasets/:dataset'], [reportsRouter, '/reports/datasets/:dataset/export'],
    [invoiceRouter, '/reports/overview']
];

it('mounted aggregate and compatibility report routes reject base secretaries and clinical roles before reading data', () => {
    for (const [router, path] of targets) {
        const route = router.stack.find((layer: any) => layer.route?.path === path)?.route;
        assert.ok(route, path);
        for (const role of [RoleCode.SECRETARY, RoleCode.THERAPIST, RoleCode.PHYSIATRIST, RoleCode.EXTERNAL_COLLABORATOR]) {
            let status = 0, nextCalled = false;
            const req: any = {user: {sub: 'user', sid: 'site', role, perms: getRolePermissions(role)}};
            const res: any = {status(value: number) {status = value; return this;}, json() {return this;}};
            route.stack[0].handle(req, res, () => nextCalled = true);
            assert.equal(status, 403, `${role}: ${path}`);
            assert.equal(nextCalled, false, `${role}: ${path}`);
        }
    }
});

it('mounted aggregate routes use analytics permissions, including the former overview endpoint', () => {
    for (const [router, path] of targets) {
        const route = router.stack.find((layer: any) => layer.route?.path === path).route;
        let nextCalled = false;
        const req: any = {user: {sub: 'user', sid: 'site', role: RoleCode.ADMIN_SECRETARY, perms: getRolePermissions(RoleCode.ADMIN_SECRETARY)}};
        const res: any = {status() {assert.fail(path);}, json() {assert.fail(path);}};
        route.stack[0].handle(req, res, () => nextCalled = true);
        assert.equal(nextCalled, true, path);
        assert.equal(req.access.resource, 'analytics', path);
    }
});

// Endpoint regression tests use database model stubs, preserving the real scope resolver.
import {Op} from 'sequelize';
import {Structure, StructureUser, StructureUserAvailability, StructureAvailability, User, TenantUser} from '../../auth/models/index.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import TimeOffRequest from '../../agenda/models/timeOffRequest.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import Patient from '../../patients/models/patient.model.js';
import {exportDataset, getPersonal} from '../controllers/reporting.controller.js';

const reportSite = '11111111-1111-4111-8111-111111111111';
const reportUser = '22222222-2222-4222-8222-222222222222';
const otherReportSite = '33333333-3333-4333-8333-333333333333';
const reportModel = (data: any): any => ({...data, get: (key?: unknown) => typeof key === 'string' ? data[key] : {...data}});
const endpointRequest = (role = RoleCode.THERAPIST, query: Record<string, unknown> = {}): any => ({tenantSchema: 'test',
    user: {sub: reportUser, tid: 'tenant', sid: reportSite, role, perms: getRolePermissions(role)},
    query: {from: '2026-01-01', to: '2026-01-31', compare: 'none', ...query}, params: {dataset: 'activity-summary'}});
function invokeEndpoint(handler: any, req: any): Promise<{status: number; body: any}> {
    return new Promise((resolve, reject) => {
        let status = 0;
        const res: any = {status(value: number) {status = value; return this;}, json(body: any) {resolve({status, body}); return this;}, setHeader() {}};
        handler(req, res, reject);
    });
}
function endpointScope(t: any, role = RoleCode.THERAPIST) {
    t.mock.method(TenantUser, 'findOne', (async () => reportModel({role})) as any);
    t.mock.method(StructureUser, 'findOne', (async () => reportModel({structureId: reportSite, userId: reportUser})) as any);
    t.mock.method(StructureUser, 'findAll', (async () => []) as any);
    t.mock.method(Structure, 'findOne', (async () => reportModel({id: reportSite, name: 'Sede corrente'})) as any);
    t.mock.method(Structure, 'findAll', (async () => [reportModel({id: reportSite, name: 'Sede corrente'})]) as any);
}

it('personal endpoint allows only the four clinical datasets and rejects another operator or site before reading occurrences', async t => {
    endpointScope(t);
    let occurrenceReads = 0;
    t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async ({where}: any) => {
        occurrenceReads++; assert.equal(where.calendarId, reportUser);
        assert.deepEqual(where.structureId[Op.in], [reportSite]); return [];
    }})) as any);
    t.mock.method(Invoice, 'schema', (() => {assert.fail('Personal endpoint must not load financial documents');}) as any);
    for (const dataset of ['activity-summary', 'sessions', 'services', 'attendance-slots']) {
        const result = await invokeEndpoint(getPersonal, endpointRequest(RoleCode.THERAPIST, {dataset}));
        assert.equal(result.status, 200, dataset);
        assert.equal(result.body.data.meta.effectiveFilters.operatorId, reportUser);
        assert.equal(result.body.data.meta.effectiveFilters.structureIds.length, 1);
    }
    assert.equal(occurrenceReads, 4);
    for (const query of [{dataset: 'operators'}, {dataset: 'financial-summary'}, {dataset: ['sessions']}, {dataset: 'sessions', operatorId: '44444444-4444-4444-8444-444444444444'}, {dataset: 'sessions', structureIds: otherReportSite}]) {
        const result = await invokeEndpoint(getPersonal, endpointRequest(RoleCode.THERAPIST, query));
        assert.equal(result.status, 403);
    }
    assert.equal(occurrenceReads, 4);
});

it('JSON export authorizes once and executes one complete dataset without reloading pagination', async t => {
    endpointScope(t, RoleCode.OWNER);
    let reads = 0;
    t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async () => {reads++; return [];}})) as any);
    t.mock.method(InvoiceAgendaEvent, 'schema', (() => ({findAll: async () => []})) as any);
    t.mock.method(Patient, 'schema', (() => ({findAll: async () => []})) as any);
    const request = endpointRequest(RoleCode.OWNER, {format: 'json', from: '2026-01-01', to: '2026-05-05', granularity: 'day', page: '2', size: '10'});
    const result = await invokeEndpoint(exportDataset, request);
    assert.equal(result.status, 200); assert.equal(reads, 1);
    assert.equal(result.body.data.version, 1); assert.equal(result.body.data.rows.length, 125);
    assert.deepEqual(result.body.data.filters.structureIds, [reportSite]);
    assert.equal(result.body.data.dateBasis, 'appointment');
    assert.equal('pagination' in result.body.data, false);
    const denied = await invokeEndpoint(exportDataset, endpointRequest(RoleCode.THERAPIST, {format: 'json'}));
    assert.equal(denied.status, 403); assert.equal(reads, 1);
    const malformed = await invokeEndpoint(exportDataset, endpointRequest(RoleCode.OWNER, {format: ['json']}));
    assert.equal(malformed.status, 400); assert.equal(reads, 1);
});

it('personal diagnostics enforce the current calendar and site, allow only unlinked occurrences and expose no finance fields', async t => {
    endpointScope(t);
    let occurrenceReads = 0;
    t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async ({where}: any) => {
        occurrenceReads++; assert.equal(where.calendarId, reportUser); assert.deepEqual(where.structureId[Op.in], [reportSite]);
        return [reportModel({id: 'unlinked', calendarId: reportUser, structureId: reportSite, patientId: null,
            start: '2026-01-12T09:00:00Z', end: '2026-01-12T10:00:00Z', title: 'Seduta senza paziente', status: 'COMPLETED', recurrence: null,
            invoiceId: 'hidden-invoice', appointmentPaidAmount: 300, appointmentExpectedAmount: 500})];
    }})) as any);
    t.mock.method(InvoiceAgendaEvent, 'schema', (() => ({findAll: async () => []})) as any);
    t.mock.method(Invoice, 'schema', (() => {assert.fail('Personal diagnostics cannot load financial documents');}) as any);
    t.mock.method(User, 'findAll', (async () => [reportModel({id: reportUser, name: 'Anna', surname: 'Test'})]) as any);
    for (const model of [StructureUserAvailability, StructureAvailability]) t.mock.method(model, 'findAll', (async () => []) as any);
    t.mock.method(TimeOffRequest, 'schema', (() => ({findAll: async () => []})) as any);
    const result = await invokeEndpoint(getPersonal, endpointRequest(RoleCode.THERAPIST, {dataset: 'operational-diagnostics', issueCode: 'UNLINKED_PATIENTS', sourceDataset: 'sessions'}));
    assert.equal(result.status, 200); assert.equal(result.body.data.summary[0].value, 1);
    assert.equal(result.body.data.meta.effectiveFilters.operatorId, reportUser);
    assert.deepEqual(result.body.data.meta.effectiveFilters.structureIds, [reportSite]);
    assert.equal(result.body.data.meta.dateBasis, 'appointment');
    const row = result.body.data.rows[0];
    for (const key of ['invoiceId', 'amount', 'balance', 'paidAmount', 'appointmentPaidAmount', 'appointmentExpectedAmount']) assert.equal(key in row, false);
    assert.ok(result.body.data.columns.every((column: any) => column.type !== 'currency'));
    for (const query of [
        {issueCode: 'INVALID_RECURRENCE'}, {issueCode: 'legacy-void'}, {sourceDataset: 'operators'},
        {operatorId: '44444444-4444-4444-8444-444444444444'}, {structureIds: otherReportSite},
    ]) {
        const denied = await invokeEndpoint(getPersonal, endpointRequest(RoleCode.THERAPIST, {dataset: 'operational-diagnostics', issueCode: 'UNLINKED_PATIENTS', sourceDataset: 'sessions', ...query}));
        assert.equal(denied.status, 403);
    }
    assert.equal(occurrenceReads, 1);
});
