import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {it, TestContext} from 'node:test';
import {Op, Transaction} from 'sequelize';
import {Request} from 'express';
import {sequelize} from '../../../config/database.js';
import {Structure, Tenant, User} from '../../auth/models/index.js';
import Patient from '../models/patient.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import EventType from '../../agenda/models/eventType.model.js';
import Service from '../../products-services/models/service.model.js';
import {applyAppointmentPriceSnapshot} from '../../invoice/utils/appointmentInvoicePrice.js';
import {resolveAppointmentPrice} from '../../invoice/services/appointmentPayment.service.js';
import {PatientCredit, TreasuryMovement, CarePackage} from '../../administration/models/index.js';
import {PatientCreditMovement} from '../../administration/models/patientCreditMovement.model.js';
import {PatientSettlementOperation} from '../models/patientSettlementOperation.model.js';
import {executePatientSettlement, normalizePatientSettlementRequest, settlementFundingPlan} from './patientSettlement.service.js';
import {patientSettlementPositionView, resolvePatientSettlementContext} from './patientSettlementAccess.service.js';
import {loadPatientSettlementPosition} from './patientSettlementPolicy.service.js';

const uid = (index: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`;
const patientId = uid(1), structureId = uid(2), userId = uid(3), tenantId = uid(4), currentId = uid(5), creditId = uid(6);
const perms = ['patient_balance:read:structure', 'payment:read:structure', 'payment:create:structure',
    'appointment_pricing:update:structure', 'payment_reversal:create:structure', 'agenda:read:structure', 'agenda:update:structure', 'invoice:read:structure', 'invoice:update:structure',
    'quote:read:structure', 'quote:update:structure'];
type Plain = Record<string, any>;

function matches(row: Plain, where: any): boolean {
    if (!where) return true;
    return Reflect.ownKeys(where).every(key => {
        const condition = where[key];
        if (key === Op.and) return condition.every((part: any) => matches(row, part));
        if (key === Op.or) return condition.some((part: any) => matches(row, part));
        if (typeof key === 'symbol') return true;
        const value = row[key];
        if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
            if (Op.in in condition) return Array.isArray(condition[Op.in]) ? condition[Op.in].includes(value)
                : typeof condition[Op.in]?.val === 'string';
            if (Op.ne in condition) return value !== condition[Op.ne];
            return matches(value || {}, condition);
        }
        return condition == null ? value == null : value === condition;
    });
}
function record(row: Plain): any {
    if (!row.get) Object.defineProperties(row, {
        get: {value: (arg: any) => typeof arg === 'string' ? row[arg] : {...row}, configurable: true},
        update: {value: async (patch: any) => {Object.assign(row, patch); return row;}, configurable: true}
    });
    return row;
}
function fixture(t: TestContext) {
    const tables: Record<string, Plain[]> = {
        patients: [{id: patientId, structureId, userId}],
        users: [{id: userId, name: 'Luca', surname: 'Moro'}],
        events: [{id: currentId, patientId, structureId, calendarId: userId, title: 'Seduta corrente', start: '2020-01-10T09:00:00Z',
            end: '2020-01-10T10:00:00Z', status: 'CONFIRMED', recurrence: null, recurringEventId: null,
            appointmentExpectedAmount: 60, appointmentOriginalAmount: 60, appointmentPaymentHistoryKnown: true,
            appointmentPaidAmount: 0, invoiceId: null}],
        invoices: [], links: [], payments: [], creditMovements: [], operations: [], packages: [],
        credits: [{id: creditId, patientId, structureId, amount: 20, remainingAmount: 20, status: 'ACTIVE',
            sourceType: 'TREASURY_ADVANCE', sourceId: uid(7)}],
        treasury: [{id: uid(7), structureId, amount: 20, direction: 'IN', status: 'POSTED', sourceType: 'PATIENT_ADVANCE', sourceId: creditId}],
        eventTypes: [], services: []
    };
    const locks: string[] = [];
    const created: string[] = [];
    const writeOptions: Array<{table: string; options: any}> = [];
    const operatorQueries: any[] = [];
    const install = (model: any, name: string) => t.mock.method(model, 'schema', (() => ({
        findByPk: async (id: string) => {const row = tables[name].find(item => item.id === id); return row ? record(row) : null;},
        findOne: async (options: any) => {const row = tables[name].find(item => matches(item, options?.where)); return row ? record(row) : null;},
        findAll: async (options: any = {}) => {
            if (options.lock) locks.push(name);
            return tables[name].filter(item => matches(item, options.where)).map(record);
        },
        count: async (options: any) => tables[name].filter(item => matches(item, options?.where)).length,
        create: async (values: any, options: any) => {created.push(name); writeOptions.push({table: name, options});
            const row = {...values, id: values.id || uid(100 + created.length)}; tables[name].push(row); return record(row);}
    })) as any);
    install(Patient, 'patients'); install(AgendaEvent, 'events'); install(Invoice, 'invoices'); install(InvoiceAgendaEvent, 'links');
    install(InvoicePayment, 'payments'); install(PatientCredit, 'credits'); install(PatientCreditMovement, 'creditMovements');
    install(PatientSettlementOperation, 'operations'); install(TreasuryMovement, 'treasury'); install(CarePackage, 'packages'); install(EventType, 'eventTypes'); install(Service, 'services');
    t.mock.method(User, 'findAll', (async (options: any = {}) => {
        operatorQueries.push(options);
        return tables.users.filter(row => matches(row, options.where)).map(record);
    }) as any);
    t.mock.method(Structure, 'findOne', (async () => record({id: structureId, tenantId})) as any);
    t.mock.method(Tenant, 'findByPk', (async () => record({id: tenantId, taxRegime: 'RF19', featureFlags: {administration: true}})) as any);
    t.mock.method(sequelize, 'query', (async (_sql: string, options: any) => {locks.push(options?.replacements?.lockKey || 'sql'); return [[]];}) as any);
    t.mock.method(sequelize, 'transaction', (async (callback: any) => {
        const snapshot = JSON.parse(JSON.stringify(tables));
        try {return await callback({LOCK: {UPDATE: 'UPDATE'}});} catch (error) {
            Object.keys(tables).forEach(key => {tables[key] = snapshot[key];}); throw error;
        }
    }) as any);
    const req: any = {tenantSchema: 'rehablo_test', params: {patientId}, user: {sub: userId, tid: tenantId, sid: structureId, perms: [...perms]},
        access: {resource: 'agenda', action: 'update', scope: 'structure', userId, structureId}, header: () => 'settlement-test-001',
        body: {referenceAgendaEventId: currentId, allocations: [{kind: 'APPOINTMENT', targetId: currentId, amount: 60}],
            credits: [{creditId, amount: 20}], cash: {amount: 40, paidAt: '2020-01-10', method: 'Contanti', note: null}, completeReference: true}};
    return {tables, req: req as Request, locks, created, writeOptions, operatorQueries};
}

function unverifiedEvent(id: string, calendarId: string | null, start: string): Plain {
    return {id, patientId, structureId, calendarId, title: 'Seduta storica', start,
        end: new Date(Date.parse(start) + 60 * 60_000).toISOString(), status: 'COMPLETED',
        appointmentPaymentHistoryKnown: false, appointmentExpectedAmount: null, invoiceId: null};
}

it('normalizes one total and refuses unmatched credit/cash, duplicate targets and occurrence write overrides', () => {
    const body = {allocations: [{kind: 'APPOINTMENT', targetId: currentId, amount: 60}], credits: [{creditId, amount: 20}],
        cash: {amount: 40, paidAt: '2020-01-10'}};
    assert.equal(normalizePatientSettlementRequest(body).cash.amount, 40);
    assert.throws(() => normalizePatientSettlementRequest({...body, cash: {...body.cash, amount: 39}}), /corrispondere/);
    assert.throws(() => normalizePatientSettlementRequest({...body, allocations: [...body.allocations, ...body.allocations]}), /una sola volta/);
    assert.throws(() => normalizePatientSettlementRequest({...body, referenceOccurrenceStart: '2020-01-10T09:00:00Z'}), /consultazione/);
});
it('reserves credit for a target without cash permission', () => {
    const plan = settlementFundingPlan([{key: 'old', amount: 60, canCash: true, canUseCredit: true},
        {key: 'invoice', amount: 40, canCash: false, canUseCredit: true}], 40);
    assert.deepEqual(plan.get('old'), {cash: 60, credit: 0}); assert.deepEqual(plan.get('invoice'), {cash: 0, credit: 40});
    assert.throws(() => settlementFundingPlan([{key: 'one', amount: 60, canCash: false, canUseCredit: true}], 20), /copertura/);
});

it('skips cash-only rows when distributing credit and reserves credit-only obligations first', () => {
    const rows = [{key: 'cash-only', amount: 60, canCash: true, canUseCredit: false},
        {key: 'flexible', amount: 40, canCash: true, canUseCredit: true},
        {key: 'credit-only', amount: 30, canCash: false, canUseCredit: true}];
    const plan = settlementFundingPlan(rows, 50);
    assert.deepEqual(plan.get('cash-only'), {cash: 60, credit: 0});
    assert.deepEqual(plan.get('flexible'), {cash: 20, credit: 20});
    assert.deepEqual(plan.get('credit-only'), {cash: 0, credit: 30});
    assert.equal([...plan.values()].reduce((sum, row) => sum + row.credit, 0), 50);
    assert.equal([...plan.values()].reduce((sum, row) => sum + row.cash, 0), 80);
    assert.throws(() => settlementFundingPlan(rows, 29), /copertura/);
    assert.throws(() => settlementFundingPlan(rows, 71), /supera.*obblighi/);
    assert.deepEqual(settlementFundingPlan([rows[0]], 0).get('cash-only'), {cash: 60, credit: 0});
});

it('collects a cash-only package invoice before applying available credit to the later appointment', async t => {
    const f = fixture(t), invoiceId = uid(30), packId = uid(31);
    f.tables.invoices.push({id: invoiceId, patientID: patientId, structureId, emissionDate: '2020-01-01',
        documentNumber: 10, documentYear: 2020, documentType: 'fattura', status: 'unpaid', invoiceNet: 400, carePackageId: packId});
    f.req.body.allocations.unshift({kind: 'INVOICE', targetId: invoiceId, amount: 400});
    f.req.body.cash.amount = 440;
    const result = await executePatientSettlement(f.req);
    assert.equal(result.creditAmount, 20);
    assert.equal(result.cashAmount, 440);
    assert.deepEqual(f.tables.payments.map(row => [row.invoiceId, row.source, row.amount]),
        [[invoiceId, 'PACKAGE_PURCHASE', 400], [null, 'CREDIT', 20], [null, 'APPOINTMENT', 40]]);
    assert.equal(f.tables.credits[0].remainingAmount, 0);
    assert.equal(result.invoices[0].balance, 0);
    assert.equal(result.position.reference.summary.balance, 0);
});

it('commits credit and cash together, uses source-specific movements and completes only current cash', async t => {
    const f = fixture(t);
    const result = await executePatientSettlement(f.req);
    assert.equal(result.replayed, false); assert.equal(result.cashAmount, 40); assert.equal(result.creditAmount, 20);
    assert.deepEqual(f.tables.payments.map(row => [row.source, row.amount]), [['CREDIT', 20], ['APPOINTMENT', 40]]);
    assert.equal(f.tables.credits[0].remainingAmount, 0); assert.equal(f.tables.events[0].status, 'COMPLETED');
    assert.equal(f.tables.operations.length, 1); assert.equal(result.position.reference.summary.balance, 0);
    assert.ok(f.locks.findIndex(item => item.includes(':patient-settlement:')) < f.locks.indexOf('events'));
    assert.equal(f.writeOptions.filter(row => row.table === 'payments')[1].options.treasuryContext.structureId, structureId);
});
it('replays an identical committed request without another movement and refuses key reuse with changed data', async t => {
    const f = fixture(t);
    const original = await executePatientSettlement(f.req);
    const replay = await executePatientSettlement(f.req);
    assert.equal(replay.replayed, true); assert.equal(replay.operationId, original.operationId);
    assert.equal(f.tables.payments.length, 2); assert.equal(f.tables.creditMovements.length, 1); assert.equal(f.tables.operations.length, 1);
    f.req.body.cash.note = 'Modificata';
    await assert.rejects(() => executePatientSettlement(f.req), /dati diversi/);
    assert.equal(f.tables.payments.length, 2);
});
it('preserves retry identities recorded before optional opening balances were added', async t => {
    const f = fixture(t);
    const result = await executePatientSettlement(f.req);
    const {openingBalances: ignored, ...oldRequest} = normalizePatientSettlementRequest(f.req.body);
    const oldHash = createHash('sha256').update(JSON.stringify({patientId, structureId, ...oldRequest})).digest('hex');
    assert.equal(f.tables.operations[0].requestHash, oldHash);
    const replay = await executePatientSettlement(f.req);
    assert.equal(replay.operationId, result.operationId);
    assert.equal(f.tables.payments.length, 2);
});

it('rolls back the entire mixed operation if recording a credit application fails', async t => {
    const f = fixture(t);
    const snapshot = JSON.stringify(f.tables);
    t.mock.method(PatientCreditMovement, 'schema', (() => ({create: async () => {throw new Error('Synthetic movement failure');}})) as any);
    await assert.rejects(() => executePatientSettlement(f.req), /Synthetic/);
    assert.equal(JSON.stringify(f.tables), snapshot);
});
it('allows pure credit without agenda:update and preserves attendance', async t => {
    const f = fixture(t);
    f.req.user!.perms = perms.filter(value => !['agenda:update:structure', 'payment:create:structure'].includes(value));
    f.tables.credits[0].amount = 60; f.tables.credits[0].remainingAmount = 60; f.tables.treasury[0].amount = 60;
    f.req.body.credits[0].amount = 60; f.req.body.cash.amount = 0;
    const result = await executePatientSettlement(f.req);
    assert.equal(result.cashAmount, 0); assert.equal(f.tables.events[0].status, 'CONFIRMED');
    assert.deepEqual(f.tables.payments.map(row => row.source), ['CREDIT']);
});
it('refuses new cash without target permission and leaves balances unchanged', async t => {
    const f = fixture(t);
    f.req.user!.perms = perms.filter(value => !['agenda:update:structure', 'payment:create:structure'].includes(value));
    const snapshot = JSON.stringify(f.tables);
    await assert.rejects(() => executePatientSettlement(f.req), /copertura/);
    assert.equal(JSON.stringify(f.tables), snapshot);
});
it('hides earlier invoice details but retains its blocking effect', async t => {
    const f = fixture(t);
    f.req.user!.perms = ['patient_balance:read:own', 'payment:create:own', 'agenda:update:own'];
    f.tables.invoices.push({id: uid(8), patientID: patientId, structureId, emissionDate: '2020-01-01',
        documentNumber: 12, documentYear: 2020, documentType: 'fattura', status: 'unpaid', invoiceNet: 1000});
    const context = await resolvePatientSettlementContext(f.req, f.req.body);
    const position = await patientSettlementPositionView(f.req, context);
    assert.equal(position.blocker!.kind, 'INACCESSIBLE_PRIOR');
    assert.ok(!position.obligations.some(row => row.targetId === uid(8)));
    assert.equal(position.totals.knownOutstandingAmount, 60);
    await assert.rejects(() => executePatientSettlement(f.req), /precedente/);
    assert.equal(f.tables.payments.length, 0);
});
it('a standalone prior invoice is collectible partially but blocks later obligations', async t => {
    const f = fixture(t);
    const invoiceId = uid(8);
    f.tables.invoices.push({id: invoiceId, patientID: patientId, structureId, emissionDate: '2020-01-01',
        documentNumber: 12, documentYear: 2020, documentType: 'fattura', status: 'unpaid', invoiceNet: 100});
    f.req.body.allocations = [{kind: 'INVOICE', targetId: invoiceId, amount: 40}];
    f.req.body.credits = []; f.req.body.cash.amount = 40;
    const result = await executePatientSettlement(f.req);
    assert.equal(result.invoices[0].balance, 60); assert.equal(f.tables.events[0].status, 'CONFIRMED');
    assert.equal(f.tables.payments[0].source, 'USER'); assert.equal(result.position.obligations[0].balance, 60);
});
it('cash on a linked legacy invoice carries the authoritative site into the treasury hook without rewriting the document', async t => {
    const f = fixture(t);
    const invoiceId = uid(8);
    f.tables.events[0].invoiceId = invoiceId;
    f.tables.invoices.push({id: invoiceId, patientID: patientId, structureId: null, emissionDate: '2020-01-10',
        documentNumber: 12, documentYear: 2020, documentType: 'fattura', status: 'unpaid', invoiceNet: 60});
    f.req.body.allocations = [{kind: 'INVOICE', targetId: invoiceId, amount: 60}];
    f.req.body.credits = []; f.req.body.cash.amount = 60;
    const result = await executePatientSettlement(f.req);
    assert.equal(result.invoices[0].balance, 0); assert.equal(f.tables.invoices[0].structureId, null);
    assert.equal(f.writeOptions.find(row => row.table === 'payments')!.options.treasuryContext.structureId, structureId);
});
it('reference site is authoritative even if the patient has moved to another premise', async t => {
    const f = fixture(t);
    f.tables.patients[0].structureId = uid(9);
    const context = await resolvePatientSettlementContext(f.req, f.req.body);
    assert.equal(context.structureId, structureId);
    await assert.rejects(() => resolvePatientSettlementContext(f.req, {...f.req.body, structureId: uid(9)}), /non corrisponde/);
});
it('derives a legacy invoice site from its original prestation instead of the moved patient default', async t => {
    const f = fixture(t); const invoiceId = uid(8);
    f.tables.patients[0].structureId = uid(9); f.req.user!.sid = uid(9);
    f.req.user!.perms = ['patient_balance:read:tenant', 'payment:create:tenant'];
    f.tables.events[0].invoiceId = invoiceId;
    f.tables.invoices.push({id: invoiceId, patientID: patientId, structureId: null, emissionDate: '2020-01-10',
        documentNumber: 12, documentYear: 2020, documentType: 'fattura', status: 'unpaid', invoiceNet: 60});
    const context = await resolvePatientSettlementContext(f.req, {referenceInvoiceId: invoiceId});
    assert.equal(context.structureId, structureId);
});
it('unverified legacy credit cannot fund the operation', async t => {
    const f = fixture(t); f.tables.credits[0].sourceType = 'ADVANCE'; f.tables.credits[0].sourceId = null;
    await assert.rejects(() => executePatientSettlement(f.req), /non è riconciliato/);
    assert.equal(f.tables.payments.length, 0); assert.equal(f.tables.operations.length, 0);
});
it('future and readonly references still return complete non-null summary shapes', async t => {
    const f = fixture(t); f.tables.events[0].start = '2099-01-10T09:00:00Z'; f.tables.events[0].end = '2099-01-10T10:00:00Z';
    const context = await resolvePatientSettlementContext(f.req, f.req.body);
    const position = await patientSettlementPositionView(f.req, context);
    assert.equal(position.reference.currentEligible, false); assert.equal(position.reference.summary.expectedAmount, 60);
    assert.deepEqual(position.reference.summary.methods, []); assert.equal(position.reference.summary.hasUndatedPayments, false);
});
it('batches historical operator names with exact starts and leaves the economic position unchanged', async t => {
    const f = fixture(t);
    const context = await resolvePatientSettlementContext(f.req, f.req.body);
    const before = await patientSettlementPositionView(f.req, context);
    assert.equal(f.operatorQueries.length, 0);
    Object.assign(f.tables.users[0], {name: '  Luca ', surname: ' Moro  ', calendarVisible: false,
        isActive: false, deactivatedAt: new Date('2019-01-01')});
    f.tables.users.push({id: uid(8), name: null, surname: ' Bianchi '});
    f.tables.events.push(unverifiedEvent(uid(9), userId, '2020-01-03T23:30:00.000Z'),
        unverifiedEvent(uid(10), uid(8), '2020-01-04T14:00:00.000Z'),
        unverifiedEvent(uid(11), userId, '2020-01-05T15:00:00.000Z'));
    const snapshot = JSON.stringify(f.tables);
    const transaction = {LOCK: {UPDATE: 'UPDATE'}} as unknown as Transaction;
    const position = await patientSettlementPositionView(f.req, context, {transaction});
    assert.equal(f.operatorQueries.length, 1);
    assert.deepEqual(f.operatorQueries[0].where, {id: {[Op.in]: [userId, uid(8)]}});
    assert.deepEqual(f.operatorQueries[0].attributes, ['id', 'name', 'surname']);
    assert.equal(f.operatorQueries[0].transaction, transaction);
    assert.deepEqual(position.verification, [
        {agendaEventId: uid(9), date: '2020-01-04', start: '2020-01-03T23:30:00.000Z', calendarId: userId,
            operatorName: 'Luca Moro', title: 'Seduta storica', reason: 'UNVERIFIED_HISTORY'},
        {agendaEventId: uid(10), date: '2020-01-04', start: '2020-01-04T14:00:00.000Z', calendarId: uid(8),
            operatorName: 'Bianchi', title: 'Seduta storica', reason: 'UNVERIFIED_HISTORY'},
        {agendaEventId: uid(11), date: '2020-01-05', start: '2020-01-05T15:00:00.000Z', calendarId: userId,
            operatorName: 'Luca Moro', title: 'Seduta storica', reason: 'UNVERIFIED_HISTORY'}
    ]);
    const {verification: beforeVerification, issues: beforeIssues, ...beforeEconomics} = before;
    const {verification, issues, ...afterEconomics} = position;
    assert.deepEqual(beforeVerification, []);
    assert.deepEqual(beforeIssues, []);
    assert.equal(verification.length, 3);
    assert.deepEqual(issues?.map(row => [row.agendaEventId, row.kind]), verification.map(row => [row.agendaEventId, 'UNKNOWN_PREVIOUS_PAYMENT']));
    assert.deepEqual(afterEconomics, beforeEconomics);
    assert.equal(JSON.stringify(f.tables), snapshot);
});
it('keeps nullable and legacy calendar identifiers without guessing a missing operator', async t => {
    const f = fixture(t);
    f.tables.users.push({id: uid(8), name: ' ', surname: null});
    f.tables.events.push(unverifiedEvent(uid(9), null, '2020-01-01T09:00:00.000Z'),
        unverifiedEvent(uid(10), uid(7), '2020-01-02T09:00:00.000Z'),
        unverifiedEvent(uid(11), 'legacy-calendar', '2020-01-03T09:00:00.000Z'),
        unverifiedEvent(uid(12), uid(8), '2020-01-04T09:00:00.000Z'));
    const context = await resolvePatientSettlementContext(f.req, f.req.body);
    const position = await patientSettlementPositionView(f.req, context);
    assert.equal(f.operatorQueries.length, 1);
    assert.deepEqual(f.operatorQueries[0].where, {id: {[Op.in]: [uid(7), uid(8)]}});
    assert.deepEqual(position.verification.map(row => [row.calendarId, row.operatorName]),
        [[null, null], [uid(7), null], ['legacy-calendar', null], [uid(8), null]]);
});
it('applies agenda ownership and reference cutoff before looking up verification operators', async t => {
    const f = fixture(t);
    f.req.user!.perms = ['patient_balance:read:own'];
    f.tables.events.push(unverifiedEvent(uid(10), userId, '2020-01-01T09:00:00.000Z'),
        unverifiedEvent(uid(11), uid(8), '2020-01-02T09:00:00.000Z'),
        unverifiedEvent(uid(12), uid(9), '2020-01-11T09:00:00.000Z'));
    const context = await resolvePatientSettlementContext(f.req, f.req.body);
    const ownPosition = await patientSettlementPositionView(f.req, context);
    assert.deepEqual(ownPosition.verification.map(row => row.agendaEventId), [uid(10)]);
    assert.equal(f.operatorQueries.length, 1);
    assert.deepEqual(f.operatorQueries[0].where, {id: {[Op.in]: [userId]}});
    f.req.user!.perms = ['patient_balance:read:structure'];
    const structurePosition = await patientSettlementPositionView(f.req, context);
    assert.deepEqual(structurePosition.verification.map(row => row.agendaEventId), [uid(10), uid(11)]);
    assert.equal(f.operatorQueries.length, 2);
    assert.deepEqual(f.operatorQueries[1].where, {id: {[Op.in]: [userId, uid(8)]}});
});
it('skips unused operator lookups and preserves date-only history without inventing a timestamp', async t => {
    const f = fixture(t);
    f.tables.events.push(unverifiedEvent(uid(8), null, '2020-01-01T09:00:00.000Z'),
        unverifiedEvent(uid(9), 'legacy-calendar', '2020-01-02'),
        unverifiedEvent(uid(10), null, '2020-01-03 09:00:00Z'));
    const context = await resolvePatientSettlementContext(f.req, f.req.body);
    const raw = await loadPatientSettlementPosition(f.req.tenantSchema!, context);
    raw.verification.push({agendaEventId: uid(11), date: '2020-01-04', title: 'Invalid start',
        reason: 'UNVERIFIED_HISTORY', record: {start: 'invalid', calendarId: uid(12), structureId}});
    const position = await patientSettlementPositionView(f.req, context, {raw});
    assert.equal(f.operatorQueries.length, 0);
    assert.deepEqual(position.verification.map(row => [row.calendarId, row.operatorName]),
        [[null, null], ['legacy-calendar', null], [null, null]]);
    assert.deepEqual(position.verification.map(row => row.agendaEventId), [uid(8), uid(9), uid(10)]);
    assert.deepEqual(position.verification.map(row => row.start), ['2020-01-01T09:00:00.000Z', null, null]);
    assert.equal(position.verification[1].date, '2020-01-02');
    assert.equal(position.verification[2].date, '2020-01-03');
});

it('ordinary secretary collects an existing invoice through the patient position without invoice permissions', async t => {
    const f = fixture(t), invoiceId = uid(8);
    f.req.user!.perms = ['patient_balance:read:structure', 'payment:read:structure', 'payment:create:structure'];
    f.tables.invoices.push({id: invoiceId, patientID: patientId, structureId, emissionDate: '2020-01-01',
        documentNumber: 12, documentYear: 2020, documentType: 'fattura', status: 'unpaid', invoiceNet: 100});
    f.req.body.allocations = [{kind: 'INVOICE', targetId: invoiceId, amount: 40}];
    f.req.body.credits = []; f.req.body.cash.amount = 40;
    const result = await executePatientSettlement(f.req);
    assert.equal(result.cashAmount, 40);
    assert.equal(result.position.capabilities.canOpenInvoice, false);
    assert.equal(result.position.capabilities.canAdjustPrice, false);
    assert.equal(result.position.capabilities.canReverse, false);
});
it('ordinary secretary cannot smuggle a price adjustment inside a permitted settlement', async t => {
    const f = fixture(t);
    f.req.user!.perms = ['patient_balance:read:structure', 'payment:create:structure', 'agenda:update:structure'];
    f.req.body.credits = []; f.req.body.cash.amount = 60;
    f.req.body.pricing = {adjustment: 'DISCOUNT', discountAmount: 5};
    const before = JSON.stringify(f.tables);
    await assert.rejects(() => executePatientSettlement(f.req), /prezzo/);
    assert.equal(JSON.stringify(f.tables), before);
});
it('ordinary secretary cannot define a missing price through a cash allocation', async t => {
    const f = fixture(t);
    f.req.user!.perms = ['patient_balance:read:structure', 'payment:create:structure'];
    f.tables.events[0].appointmentExpectedAmount = null;
    f.tables.events[0].appointmentOriginalAmount = null;
    f.req.body.credits = []; f.req.body.cash.amount = 60;
    await assert.rejects(() => executePatientSettlement(f.req), /permesso|prezzo|copertura/);
    assert.equal(f.tables.payments.length, 0);
});
it('a replay after collection rights were revoked does not return the persisted result', async t => {
    const f = fixture(t);
    await executePatientSettlement(f.req);
    f.req.user!.perms = ['patient_balance:read:structure'];
    await assert.rejects(() => executePatientSettlement(f.req), /accessibile/);
});

it('a pricing adjustment cannot silently make unverified history collectible', async t => {
    const f = fixture(t);
    f.tables.events[0].appointmentPaymentHistoryKnown = false;
    f.req.body.pricing = {adjustment: null};
    const before = JSON.stringify(f.tables);
    await assert.rejects(() => executePatientSettlement(f.req), /storico|incass|verific|disponibil/);
    assert.equal(JSON.stringify(f.tables), before);
    f.req.body.pricing = {adjustment: null, confirmHistory: true};
    const result = await executePatientSettlement(f.req);
    assert.equal(result.cashAmount, 40);
    assert.equal(f.tables.events[0].appointmentPaymentHistoryKnown, true);
});

it('settlement normalization retains explicit pricing and history intent and rejects malformed confirmations', () => {
    const body = {allocations: [{kind: 'APPOINTMENT', targetId: currentId, amount: 50}], credits: [],
        cash: {amount: 50, paidAt: '2020-01-10'}, pricing: {adjustment: null, baseAmount: 50, confirmHistory: true}};
    assert.deepEqual(normalizePatientSettlementRequest(body).pricing,
        {adjustment: null, baseAmount: 50, confirmHistory: true, discountAmount: null, note: null});
    assert.throws(() => normalizePatientSettlementRequest({...body, pricing: {...body.pricing, confirmHistory: 'true'}}), /conferma/);
});

it('normalizes a preceding balance without defaulting its amount or inventing a receipt date', () => {
    const body = {allocations: [], openingBalances: [{agendaEventId: currentId, expectedAmount: 60, previouslyPaidAmount: 25}]};
    const request = normalizePatientSettlementRequest(body);
    assert.equal(request.cash.amount, 0);
    assert.deepEqual(request.openingBalances, [{agendaEventId: currentId, expectedAmount: 60, previouslyPaidAmount: 25, paidAt: null, method: null}]);
    assert.throws(() => normalizePatientSettlementRequest({...body, openingBalances: [{agendaEventId: currentId}]}), /importi/);
    assert.throws(() => normalizePatientSettlementRequest({...body, openingBalances: [...body.openingBalances, ...body.openingBalances]}), /una sola volta/);
    assert.throws(() => normalizePatientSettlementRequest({...body, openingBalances: [{...body.openingBalances[0], paidAt: '2099-01-01'}]}), /data/);
    assert.throws(() => normalizePatientSettlementRequest({...body, cash: {amount: 1, paidAt: '2020-01-01'}}), /corrispondere/);
    assert.throws(() => normalizePatientSettlementRequest({...body, openingBalances: []}), /Seleziona/);
});

it('completes a previous unpaid situation with an immutable zero-payment audit and no movement', async t => {
    const f = fixture(t);
    f.tables.events[0].appointmentPaymentHistoryKnown = false;
    f.req.body = {referenceAgendaEventId: currentId, allocations: [], openingBalances: [{agendaEventId: currentId, previouslyPaidAmount: 0}]};
    const result = await executePatientSettlement(f.req);
    assert.equal(result.cashAmount, 0);
    assert.equal(f.tables.payments.length, 0);
    assert.equal(f.tables.operations.length, 1);
    assert.equal(f.tables.events[0].status, 'CONFIRMED');
    assert.equal(result.position.reference.summary.balance, 60);
    assert.deepEqual(result.openingBalances[0], {agendaEventId: currentId, paymentId: null,
        before: {expectedAmount: 60, paidAmount: 0, historyKnown: false},
        after: {expectedAmount: 60, paidAmount: 0, historyKnown: true}, priceDefined: false});
    assert.deepEqual(f.tables.operations[0].result.openingBalances, result.openingBalances);
});

it('records a preceding full payment as opening coverage and preserves its unknown date', async t => {
    const f = fixture(t);
    f.tables.events[0].appointmentPaymentHistoryKnown = false;
    f.req.body = {referenceAgendaEventId: currentId, allocations: [],
        openingBalances: [{agendaEventId: currentId, previouslyPaidAmount: 60}]};
    const result = await executePatientSettlement(f.req);
    assert.equal(result.position.reference.summary.balance, 0);
    assert.equal(result.cashAmount, 0);
    assert.deepEqual(f.tables.payments.map(row => [row.source, row.amount, row.paidAt, row.createdByUserId]),
        [['OPENING_BALANCE', 60, null, userId]]);
    assert.equal(f.tables.treasury.length, 1);
    assert.equal(f.tables.events[0].status, 'CONFIRMED');
    const replay = await executePatientSettlement(f.req);
    assert.equal(replay.replayed, true);
    assert.equal(f.tables.payments.length, 1);
    assert.equal(replay.openingBalances[0].paymentId, result.openingBalances[0].paymentId);
});

it('atomically completes a partial previous payment and collects only the remaining new cash', async t => {
    const f = fixture(t);
    Object.assign(f.tables.events[0], {appointmentPaymentHistoryKnown: false,
        appointmentExpectedAmount: null, appointmentOriginalAmount: null});
    f.req.body = {referenceAgendaEventId: currentId, allocations: [{kind: 'APPOINTMENT', targetId: currentId, amount: 35}],
        openingBalances: [{agendaEventId: currentId, expectedAmount: 60, previouslyPaidAmount: 25,
            paidAt: '2019-12-31', method: 'Bonifico'}], cash: {amount: 35, paidAt: '2020-01-10'}, completeReference: true};
    const result = await executePatientSettlement(f.req);
    assert.equal(result.cashAmount, 35);
    assert.equal(result.openingBalances[0].priceDefined, true);
    assert.deepEqual(f.tables.payments.map(row => [row.source, row.amount]), [['OPENING_BALANCE', 25], ['APPOINTMENT', 35]]);
    assert.equal(new Date(f.tables.payments[0].paidAt).toISOString().slice(0, 10), '2019-12-31');
    assert.equal(result.position.reference.summary.balance, 0);
    assert.equal(f.tables.events[0].appointmentExpectedAmount, 60);
    assert.equal(f.tables.events[0].status, 'COMPLETED');
    assert.equal(result.agendaEvents.length, 1);
    assert.equal(f.tables.operations[0].result.openingBalances[0].before.expectedAmount, null);
});

it('freezes the agreed preceding gross amount without adopting catalogue VAT, contribution or changed tariffs', async t => {
    const f = fixture(t);
    Object.assign(f.tables.events[0], {appointmentPaymentHistoryKnown: false, appointmentExpectedAmount: null,
        appointmentOriginalAmount: null, eventTypeId: uid(25), appointmentSocialSecurity: {fund: 'INPS_GS', mode: 'EXCLUDED', rate: 4}});
    f.tables.eventTypes.push({id: uid(25), linkedServiceId: uid(26)});
    f.tables.services.push({id: uid(26), sellingPrice: 100, productVat: '22'});
    f.req.body = {referenceAgendaEventId: currentId, allocations: [],
        openingBalances: [{agendaEventId: currentId, expectedAmount: 61, previouslyPaidAmount: 61}]};
    await executePatientSettlement(f.req);
    const saved = f.tables.events[0];
    assert.equal(saved.appointmentExpectedAmount, 61);
    assert.equal(saved.appointmentOriginalAmount, 61);
    assert.equal(saved.appointmentNetAmount, null);
    assert.equal(saved.appointmentVatRate, null);
    assert.equal(saved.appointmentSocialSecurity, null);
    const price = resolveAppointmentPrice(saved, f.tables.eventTypes[0], f.tables.services[0], true);
    const invoiceLine = applyAppointmentPriceSnapshot(price, {unitPrice: 100, vat: '22'}, true);
    assert.equal(invoiceLine.unitPrice, 50);
    assert.equal(invoiceLine.vat, '22');
    assert.equal(invoiceLine.socialSecurity?.mode, 'NONE');
    assert.equal(Math.round(invoiceLine.unitPrice * 1.22 * 100) / 100, 61);
});

it('uses an explicitly allocated gross price for known history with only a current catalogue estimate', async t => {
    const f = fixture(t);
    Object.assign(f.tables.events[0], {appointmentExpectedAmount: null, appointmentOriginalAmount: null, eventTypeId: uid(25)});
    f.tables.eventTypes.push({id: uid(25), linkedServiceId: uid(26)});
    f.tables.services.push({id: uid(26), sellingPrice: 100, productVat: '22'});
    f.req.body.credits = [];
    f.req.body.cash.amount = 61;
    f.req.body.allocations[0].amount = 61;
    const result = await executePatientSettlement(f.req);
    assert.equal(f.tables.events[0].appointmentExpectedAmount, 61);
    assert.equal(result.position.reference.summary.balance, 0);
    assert.equal(f.tables.payments[0].amount, 61);
});

it('a newly known preceding residue still enforces FIFO and rolls back the entire opening on failure', async t => {
    const f = fixture(t);
    const old = uid(20);
    f.tables.events.push({...unverifiedEvent(old, userId, '2020-01-01T09:00:00Z'), appointmentExpectedAmount: 50});
    f.req.body.openingBalances = [{agendaEventId: old, previouslyPaidAmount: 10}];
    f.req.body.credits = [];
    f.req.body.cash.amount = 60;
    const before = JSON.stringify(f.tables);
    await assert.rejects(() => executePatientSettlement(f.req), /precedente/);
    assert.equal(JSON.stringify(f.tables), before);
});

it('rejects opening balances after another writer establishes history, even when a movement is void', async t => {
    const f = fixture(t);
    f.tables.events[0].appointmentPaymentHistoryKnown = false;
    f.tables.payments.push({id: uid(21), agendaEventId: currentId, amount: 20, source: 'APPOINTMENT', status: 'VOID'});
    f.req.body = {referenceAgendaEventId: currentId, allocations: [], openingBalances: [{agendaEventId: currentId, previouslyPaidAmount: 60}]};
    const before = JSON.stringify(f.tables);
    await assert.rejects(() => executePatientSettlement(f.req), /cambiati/);
    assert.equal(JSON.stringify(f.tables), before);
});

it('a price conflict or an excessive preceding payment cannot mutate the previous situation', async t => {
    const f = fixture(t);
    f.tables.events[0].appointmentPaymentHistoryKnown = false;
    f.req.body = {referenceAgendaEventId: currentId, allocations: [], openingBalances: [{agendaEventId: currentId, expectedAmount: 50, previouslyPaidAmount: 0}]};
    const before = JSON.stringify(f.tables);
    await assert.rejects(() => executePatientSettlement(f.req), /prezzo.*cambiato/);
    assert.equal(JSON.stringify(f.tables), before);
    f.req.body.openingBalances[0] = {agendaEventId: currentId, previouslyPaidAmount: 61};
    await assert.rejects(() => executePatientSettlement(f.req), /superano/);
    assert.equal(JSON.stringify(f.tables), before);
});

it('does not complete opening balances on reverse invoice links', async t => {
    const f = fixture(t);
    f.tables.events[0].appointmentPaymentHistoryKnown = false;
    f.tables.invoices.push({id: uid(22), agendaEventId: currentId, patientID: patientId, structureId,
        emissionDate: '2020-01-10', status: 'unpaid', documentNumber: 2, invoiceNet: 60});
    f.req.body = {referenceAgendaEventId: currentId, allocations: [], openingBalances: [{agendaEventId: currentId, previouslyPaidAmount: 0}]};
    const before = JSON.stringify(f.tables);
    await assert.rejects(() => executePatientSettlement(f.req), /fattura/);
    assert.equal(JSON.stringify(f.tables), before);
});

it('completes a known-price previous situation with payment rights alone even when the client includes the same price', async t => {
    const f = fixture(t);
    f.tables.events[0].appointmentPaymentHistoryKnown = false;
    f.req.user!.perms = ['patient_balance:read:structure', 'payment:create:structure'];
    f.req.body = {referenceAgendaEventId: currentId, allocations: [],
        openingBalances: [{agendaEventId: currentId, expectedAmount: 60, previouslyPaidAmount: 0}]};
    const result = await executePatientSettlement(f.req);
    assert.equal(result.openingBalances[0].priceDefined, false);
    assert.equal(result.position.reference.summary.balance, 60);
});

it('quote rights cannot complete an unpaid previous situation and missing-price rights are checked separately', async t => {
    const f = fixture(t);
    f.tables.events[0].appointmentPaymentHistoryKnown = false;
    f.req.body = {referenceAgendaEventId: currentId, allocations: [], openingBalances: [{agendaEventId: currentId, previouslyPaidAmount: 0}]};
    f.req.user!.perms = perms.filter(value => !value.startsWith('payment:create:'));
    await assert.rejects(() => executePatientSettlement(f.req), /Non puoi completare/);
    f.req.user!.perms = perms.filter(value => !value.startsWith('appointment_pricing:update:'));
    f.tables.events[0].appointmentExpectedAmount = null;
    f.req.body.openingBalances[0].expectedAmount = 60;
    await assert.rejects(() => executePatientSettlement(f.req), /prezzo/);
    assert.equal(f.tables.operations.length, 0);
});

it('replays zero-payment completions only while the original payment and pricing rights remain granted', async t => {
    const f = fixture(t);
    Object.assign(f.tables.events[0], {appointmentPaymentHistoryKnown: false, appointmentExpectedAmount: null});
    f.req.body = {referenceAgendaEventId: currentId, allocations: [],
        openingBalances: [{agendaEventId: currentId, expectedAmount: 60, previouslyPaidAmount: 0}]};
    await executePatientSettlement(f.req);
    f.req.user!.perms = perms.filter(value => !value.startsWith('appointment_pricing:update:'));
    await assert.rejects(() => executePatientSettlement(f.req), /accessibile/);
    f.req.user!.perms = perms.filter(value => !value.startsWith('payment:create:'));
    await assert.rejects(() => executePatientSettlement(f.req), /accessibile/);
    assert.equal(f.tables.operations.length, 1);
});


for (const domain of ['packages', 'credit backing'] as const) {
    it(`rolls back collected money when the response coverage ${domain} query fails in the same transaction`, async t => {
        const f = fixture(t);
        const snapshot = JSON.stringify(f.tables);
        const failure = new Error('Synthetic coverage ' + domain + ' query failure');
        const model = domain === 'packages' ? CarePackage : TreasuryMovement;
        const original = model.schema('rehablo_test') as any;
        let failedAfterWrites = false;
        t.mock.method(model, 'schema', (() => ({...original, findAll: async (options: any) => {
            const isCoverageQuery = domain === 'packages' ? Array.isArray(options.order)
                : f.tables.payments.length > 0;
            if (isCoverageQuery) {
                assert.ok(options.transaction);
                assert.equal(f.tables.payments.length, 2);
                assert.equal(f.tables.operations.length, 1);
                failedAfterWrites = true;
                throw failure;
            }
            return original.findAll(options);
        }})) as any);
        await assert.rejects(() => executePatientSettlement(f.req), error => error === failure);
        assert.equal(failedAfterWrites, true);
        assert.equal(JSON.stringify(f.tables), snapshot);
        assert.ok(f.created.includes('payments'));
        assert.ok(f.created.includes('operations'));
    });
}
