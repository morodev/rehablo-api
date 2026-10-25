import assert from 'node:assert/strict';
import {it, TestContext} from 'node:test';
import {Op} from 'sequelize';
import {CarePackage, PatientCredit, TreasuryMovement} from '../../administration/models/index.js';
import {Structure, Tenant} from '../../auth/models/index.js';
import Patient from '../models/patient.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import patientRouter from '../routes/patient.routes.js';
import {getPatientCoveragePosition} from '../controllers/patientCoverage.controller.js';
import {patientCoveragePosition, resolvePatientCoverageContext} from './patientCoverage.service.js';
import {verifiedSettlementCredit, verifiedPatientCredits} from '../../administration/services/patientCreditBacking.service.js';
import {patientSettlementPositionView} from './patientSettlementAccess.service.js';
import {buildPatientSettlementPosition} from './patientSettlementPolicy.service.js';

const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const patientId = id(1), structureId = id(2), userId = id(3), tenantId = id(4);
const context = {patientId, structureId, patient: {id: patientId, structureId, userId: id(5)}};
const record = (row: Record<string, any>): any => ({get: (key?: unknown) => typeof key === 'string' ? row[key] : row});
const request = (perms = ['care_package:read:structure', 'quote:read:structure']): any => ({tenantSchema: 'rehablo_test',
    params: {patientId}, query: {}, user: {sub: userId, tid: tenantId, sid: structureId, perms}});
const pkg = (n: number, extra: Record<string, any> = {}) => ({id: id(n), patientId, structureId, templateId: id(6),
    name: '10 Tecar', serviceId: id(7), serviceName: 'Tecar', purchasedUnits: 10, remainingUnits: 10,
    totalPrice: 400, purchasedAt: '2020-01-01', expiresAt: null, status: 'ACTIVE', ...extra});

function fixture(t: TestContext) {
    const packages: any[] = [], credits: any[] = [], ledger: any[] = [], events: any[] = [];
    const patients = [{...context.patient}];
    const faults: {catalog?: boolean; legacy?: boolean; credits?: boolean; backing?: boolean} = {};
    const packageReads: any[] = [], patientReads: any[] = [], ledgerReads: any[] = [];
    function matches(row: any, where: any): boolean {
        if (!where) return true;
        return Reflect.ownKeys(where).every(key => {
            const value = where[key];
            if (key === Op.and) return value.every((part: any) => matches(row, part));
            if (key === Op.or) return value.some((part: any) => matches(row, part));
            if (typeof key !== 'string') return true;
            const actual = row[key];
            if (value && typeof value === 'object') {
                if (value[Op.in]?.val) return patients.some(patient => patient.id === actual && patient.structureId === structureId
                    && (!String(value[Op.in].val).includes('"userId"') || patient.userId === userId
                        || events.some(event => event.calendarId === userId && event.structureId === structureId
                            && (event.patientId ?? event.patient?.id) === actual)));
                if (value[Op.in]) return value[Op.in].includes(actual);
                if (Reflect.ownKeys(value).includes(Op.ne)) return actual != null && actual !== value[Op.ne];
            }
            return value == null ? actual == null : actual === value;
        });
    }
    t.mock.method(Patient, 'schema', (() => ({findOne: async (options: any) => {
        patientReads.push(options);
        const row = patients.find(row => matches(row, options.where)); return row ? record(row) : null;
    }})) as any);
    t.mock.method(CarePackage, 'schema', (() => ({findAll: async (options: any) => {
        packageReads.push(options);
        if (faults[options.where.templateId === null ? 'legacy' : 'catalog']) throw new Error('Synthetic package failure');
        return packages.filter(row => matches(row, options.where)).map(record);
    }})) as any);
    t.mock.method(PatientCredit, 'schema', (() => ({findAll: async (options: any) => {
        if (faults.credits) throw new Error('Synthetic credit failure');
        return credits.filter(row => matches(row, options.where)).map(record);
    }})) as any);
    t.mock.method(AgendaEvent, 'schema', (() => ({findAll: async (options: any) => events.filter(row => matches(row, options.where)).map(record)})) as any);
    t.mock.method(TreasuryMovement, 'schema', (() => ({
        findAll: async (options: any) => {ledgerReads.push(options); if (faults.backing) throw new Error('Synthetic ledger failure');
            return ledger.filter(row => matches(row, options.where)).map(record);},
        findByPk: async (key: string) => {const row = ledger.find(row => row.id === key); return row ? record(row) : null;},
        findOne: async (options: any) => {const row = ledger.find(row => matches(row, options.where)); return row ? record(row) : null;},
        count: async (options: any) => ledger.filter(row => matches(row, options.where)).length
    })) as any);
    t.mock.method(Structure, 'findOne', (async ({where}: any) => where.id === structureId && where.tenantId === tenantId ? record({id: structureId}) : null) as any);
    t.mock.method(Tenant, 'findByPk', (async () => record({featureFlags: {administration: true}})) as any);
    return {packages, credits, ledger, events, patients, faults, packageReads, patientReads, ledgerReads};
}

it('returns all three counted packages: 30 residual, 20 available and 10 previous sessions', async t => {
    const f = fixture(t); f.packages.push(pkg(10), pkg(11), pkg(12, {templateId: null, name: 'Preventivo 8'}));
    const result = await patientCoveragePosition(request(), context);
    assert.equal(result.catalog!.length, 2); assert.equal(result.legacy!.length, 1);
    assert.deepEqual(result.packagesSummary, {activeCount: 3, remainingUnits: 30, availableUnits: 20, reservedUnits: 0, legacyRemainingUnits: 10});
    assert.equal(result.legacy![0].availableUnits, 0); assert.equal(result.legacy![0].canOpen, false);
    assert.equal(result.catalog![0].canOpen, true);
    assert.deepEqual(result.creditsSummary, {verifiedRemaining: 0, unverifiedCount: 0});
});

it('counts reservations once, without restoring consumed units or reducing residual units', async t => {
    const f = fixture(t); f.packages.push(pkg(10, {remainingUnits: 8}), pkg(11, {remainingUnits: 1}));
    f.events.push(...[20, 21, 22].map(n => ({id: id(n), carePackageId: id(10), packageReservationStatus: 'RESERVED'})),
        {id: id(23), carePackageId: id(10), packageReservationStatus: 'CONSUMED'},
        {id: id(24), carePackageId: id(10), packageReservationStatus: 'RELEASED'},
        {id: id(25), carePackageId: id(11), packageReservationStatus: 'RESERVED'},
        {id: id(26), carePackageId: id(11), packageReservationStatus: 'RESERVED'});
    const result = await patientCoveragePosition(request(), context);
    assert.deepEqual(result.packagesSummary, {activeCount: 2, remainingUnits: 9, availableUnits: 5, reservedUnits: 5, legacyRemainingUnits: 0});
    assert.equal(result.catalog![1].availableUnits, 0);
});

it('keeps expired, inactive and exhausted packages visible but outside the residual summary', async t => {
    const f = fixture(t); f.packages.push(pkg(10), pkg(11, {expiresAt: '2000-01-01'}), pkg(12, {status: 'SUSPENDED'}),
        pkg(13, {status: 'EXHAUSTED', remainingUnits: 0}), pkg(14, {purchasedAt: '2099-01-01'}),
        pkg(15, {templateId: null, expiresAt: '2000-01-01'}));
    const result = await patientCoveragePosition(request(), context);
    assert.equal(result.catalog!.length, 5); assert.equal(result.legacy!.length, 1);
    assert.equal(result.catalog![1].status, 'EXPIRED'); assert.equal(result.legacy![0].status, 'EXPIRED');
    assert.deepEqual(result.catalog!.map(row => row.includedInSummary), [true, false, false, false, true]);
    assert.deepEqual(result.catalog!.map(row => row.availableUnits), [10, 0, 0, 0, 0]);
    assert.equal(result.packagesSummary!.remainingUnits, 20);
});

it('sums more than fifty records without pagination or truncation and does not count another patient or site', async t => {
    const f = fixture(t);
    f.packages.push(...Array.from({length: 55}, (_, n) => pkg(100 + n)), pkg(200, {patientId: id(999)}), pkg(201, {structureId: id(999)}));
    const result = await patientCoveragePosition(request(), context);
    assert.equal(result.catalog!.length, 55); assert.equal(result.packagesSummary!.remainingUnits, 550);
    assert.ok(f.packageReads.every(options => options.limit === undefined && options.offset === undefined));
});

it('separates catalog and quote permissions and never turns an unauthorized domain into zero', async t => {
    const f = fixture(t); f.packages.push(pkg(10), pkg(11, {templateId: null}));
    const catalogOnly = await patientCoveragePosition(request(['care_package:read:structure']), context);
    assert.equal(catalogOnly.catalog!.length, 1); assert.equal(catalogOnly.legacy, null); assert.equal(catalogOnly.credits, null);
    assert.equal(catalogOnly.creditsSummary, null); assert.equal(catalogOnly.packagesSummary!.remainingUnits, 10);
    const quoteOnly = await patientCoveragePosition(request(['quote:read:structure']), context);
    assert.equal(quoteOnly.catalog, null); assert.equal(quoteOnly.legacy!.length, 1); assert.equal(quoteOnly.packagesSummary!.availableUnits, 0);
    const noAccess = await patientCoveragePosition(request([]), context);
    assert.equal(noAccess.packagesSummary, null); assert.equal(noAccess.creditsSummary, null);
});

it('uses canonical own patient scope independently for catalog and previous packages while credits remain denied', async t => {
    const f = fixture(t); f.packages.push(pkg(10), pkg(11, {templateId: null}));
    const req = request(['care_package:read:own', 'quote:read:own']);
    const denied = await patientCoveragePosition(req, context);
    assert.equal(denied.catalog, null); assert.equal(denied.legacy, null); assert.equal(denied.credits, null);
    f.events.push({id: id(30), patient: {id: patientId}, structureId, calendarId: userId});
    const allowed = await patientCoveragePosition(req, context);
    assert.equal(allowed.catalog!.length, 1); assert.equal(allowed.legacy!.length, 1); assert.equal(allowed.credits, null);
    assert.match(f.patientReads.at(-1).where[Op.and][1].id[Op.in].val, /OR EXISTS/);
    assert.match(f.patientReads.at(-1).where[Op.and][1].id[Op.in].val, new RegExp(userId));
});

it('rejects invalid patients, selected sites and cross-tenant structures before reading coverage', async t => {
    const f = fixture(t);
    assert.equal((await resolvePatientCoverageContext(request())).patientId, patientId);
    for (const req of [Object.assign(request(), {params: {patientId: 'invalid'}}),
        Object.assign(request(), {query: {structureId: ''}}), Object.assign(request(), {query: {structureId: id(999)}}),
        Object.assign(request(), {params: {patientId: id(999)}}),
        {...request(), user: {...request().user, tid: id(999)}}, {...request(), user: {...request().user, sid: id(999)}}]) {
        await assert.rejects(() => resolvePatientCoverageContext(req));
    }
    assert.equal(f.packageReads.length, 0);
    assert.equal((await patientCoveragePosition({...request(), user: {...request().user, sid: id(999)}}, context)).packagesSummary, null);
});

it('uses receipt proof and reversals for credit availability, with the same results as the existing writer check', async t => {
    const f = fixture(t);
    const add = (n: number, extra: any = {}, receiptExtra: any = {}) => {
        const credit = {id: id(n), patientId, structureId, amount: 100, remainingAmount: 30, status: 'ACTIVE', sourceType: 'TREASURY_ADVANCE', sourceId: id(n + 100), ...extra};
        f.credits.push(credit);
        if (credit.sourceId) f.ledger.push({id: id(n + 100), structureId, status: 'POSTED', direction: 'IN', amount: 100,
            sourceType: 'PATIENT_ADVANCE', sourceId: credit.id, ...receiptExtra});
        return credit;
    };
    add(10); add(11, {}, {status: 'VOID'}); add(12, {}, {structureId: id(999)}); add(13, {}, {amount: 20});
    add(14, {sourceType: 'VOID_CREDIT', sourceId: id(314)}, {sourceType: 'INVOICE_PAYMENT', sourceId: id(314)});
    add(15); f.ledger.push({id: id(415), reversalOfId: id(115), status: 'POSTED'});
    add(16, {sourceType: 'ADVANCE', sourceId: null}); add(17, {status: 'EXHAUSTED'});
    const result = await patientCoveragePosition(request(['quote:read:structure', 'quote:update:structure', 'treasury:create:structure']), context);
    assert.deepEqual(result.creditsSummary, {verifiedRemaining: 60, unverifiedCount: 5});
    assert.deepEqual(result.credits!.filter(row => row.availableAmount > 0).map(row => row.id), [id(10), id(14)]);
    assert.ok(result.credits!.filter(row => row.availableAmount > 0).every(row => row.canUse && row.canRefund));
    assert.equal(f.ledgerReads.length, 2);
    const verified = await verifiedPatientCredits('rehablo_test', f.credits);
    for (const credit of f.credits) assert.equal(verified.get(credit.id), await verifiedSettlementCredit('rehablo_test', credit));
    const readOnly = await patientCoveragePosition(request(['quote:read:structure']), context);
    assert.equal(readOnly.creditsSummary!.verifiedRemaining, 60);
    assert.ok(readOnly.credits!.every(row => !row.canUse && !row.canRefund));
});

it('isolates failed domains and preserves healthy lists without publishing a partial package total', async t => {
    const f = fixture(t); f.packages.push(pkg(10), pkg(11, {templateId: null}));
    f.faults.catalog = true;
    const partial = await patientCoveragePosition(request(), context);
    assert.equal(partial.catalog, null); assert.ok(partial.errors.catalog); assert.equal(partial.legacy!.length, 1);
    assert.equal(partial.packagesSummary, null); assert.deepEqual(partial.creditsSummary, {verifiedRemaining: 0, unverifiedCount: 0});
    f.faults.catalog = false; f.faults.credits = true;
    const creditFailure = await patientCoveragePosition(request(), context);
    assert.equal(creditFailure.packagesSummary!.remainingUnits, 20); assert.equal(creditFailure.creditsSummary, null); assert.ok(creditFailure.errors.credits);
    f.faults.credits = false; f.faults.backing = true;
    f.credits.push({id: id(50), patientId, structureId, amount: 50, remainingAmount: 50, status: 'ACTIVE', sourceType: 'TREASURY_ADVANCE', sourceId: id(51)});
    const backingFailure = await patientCoveragePosition(request(), context);
    assert.equal(backingFailure.credits, null); assert.equal(backingFailure.creditsSummary, null); assert.ok(backingFailure.errors.credits);
});

it('uses the same authorized package projection for settlement summaries without quote permission', async t => {
    const f = fixture(t); f.packages.push(pkg(10), pkg(11, {templateId: null}));
    const req = request(['care_package:read:structure', 'patient_balance:read:structure']);
    const raw = buildPatientSettlementPosition(context, {events: [], invoices: [], links: [], payments: [], packages: [], prices: new Map()});
    const coverage = await patientCoveragePosition(req, context);
    const settlement = await patientSettlementPositionView(req, context, {raw, administrationEnabled: true});
    assert.deepEqual(settlement.packagesSummary, coverage.packagesSummary);
    assert.equal(settlement.packagesSummary!.remainingUnits, 10); assert.equal(settlement.creditsSummary, null);
});

it('mounts the independent coverage route for either read permission, without patient_balance rights', async () => {
    const route = (patientRouter as any).stack.find((layer: any) => layer.route?.path === '/patient/:patientId/coverage-position')?.route;
    assert.ok(route);
    for (const perms of [['care_package:read:own'], ['quote:read:structure'], []]) {
        let status = 0, next = false;
        route.stack[0].handle(request(perms), {status(code: number) {status = code; return this;}, json() {return this;}}, () => next = true);
        assert.equal(next, perms.length > 0); assert.equal(status, perms.length ? 0 : 403);
    }
});

it('returns the controller data envelope and keeps the administration feature gate', async t => {
    fixture(t);
    const invoke = (handler: any, req: any) => new Promise<any>(resolve => {
        const response = {code: 200, status(code: number) {this.code = code; return this;}, json(body: any) {resolve({...body, statusCode: this.code}); return this;}};
        handler(req, response, (error: any) => resolve({statusCode: error?.statusCode ?? 500}));
    });
    const result = await invoke(getPatientCoveragePosition, request(['care_package:read:structure']));
    assert.equal(result.statusCode, 200); assert.equal(result.data.patientId, patientId); assert.deepEqual(result.data.catalog, []);
    t.mock.method(Tenant, 'findByPk', (async () => record({featureFlags: {administration: false}})) as any);
    const route = (patientRouter as any).stack.find((layer: any) => layer.route?.path === '/patient/:patientId/coverage-position').route;
    assert.equal((await invoke(route.stack[1].handle, request())).statusCode, 403);
});
