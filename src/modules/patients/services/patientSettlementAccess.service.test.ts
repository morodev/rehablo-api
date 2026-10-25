import assert from 'node:assert/strict';
import {beforeEach, it, TestContext} from 'node:test';
import {Op} from 'sequelize';
import {Request} from 'express';
import {buildPatientSettlementPosition} from './patientSettlementPolicy.service.js';
import {patientSettlementPositionView, resolvePatientSettlementContext} from './patientSettlementAccess.service.js';
import {Structure} from '../../auth/models/index.js';
import Patient from '../models/patient.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import {CarePackage} from '../../administration/models/index.js';

beforeEach(t => {
    // Coverage summaries add a package read to positions; these authorization tests never use a database.
    (t as TestContext).mock.method(CarePackage, 'schema', (() => ({findAll: async () => []})) as any);
});

const patientId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const structureId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const context = {patientId, structureId, referenceAgendaEventId: 'current', patient: {id: patientId, structureId}};
const event = {id: 'current', patientId, structureId, calendarId: null, start: '2020-01-10T09:00:00Z',
    end: '2020-01-10T10:00:00Z', status: 'COMPLETED', title: 'Seduta', appointmentPaymentHistoryKnown: false};
function req(perms: string[]): Request {
    return {tenantSchema: 'rehablo_test', params: {patientId}, user: {sub: 'operator', tid: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000005', sid: structureId, perms}} as unknown as Request;
}
const raw = (price: {amount: number | null; estimated?: boolean} = {amount: 60}) => buildPatientSettlementPosition(context,
    {events: [event], invoices: [], links: [], payments: [], prices: new Map([['current', price]])});
const read = ['patient_balance:read:structure'];

const packageId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000020';
const packageOperator = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000021';
const anotherOperator = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000022';
const packageRead = [...read, 'care_package:read:structure'];
const packagePay = [...packageRead, 'payment:create:structure'];
const purchasedPackage = (extra: Record<string, any> = {}) => ({id: packageId, patientId, structureId, templateId: 'template',
    name: '10 sedute', totalPrice: 400, purchasedAt: '2020-01-01', purchasedUnits: 10, remainingUnits: 10, status: 'ACTIVE', ...extra});
const packageRaw = (packages: Array<Record<string, any>>) => buildPatientSettlementPosition(context,
    {events: [{...event, appointmentPaymentHistoryKnown: true}], invoices: [], links: [], payments: [], packages,
        prices: new Map([['current', {amount: 60}]])});
const asRecord = (row: Record<string, any>) => ({get: (field?: unknown) => typeof field === 'string' ? row[field] : row});

it('exposes direct package payment capability with canonical patient permissions once for multiple packages', async t => {
    const transaction = {LOCK: {UPDATE: 'UPDATE'}} as any;
    const lookups: any[] = [];
    t.mock.method(Patient, 'schema', (() => ({findOne: async (options: any) => {
        lookups.push(options);
        return asRecord(context.patient);
    }})) as any);
    const view = await patientSettlementPositionView(req(packagePay), context, {raw: packageRaw([
        purchasedPackage(), purchasedPackage({id: 'second-package', totalPrice: 200})]), administrationEnabled: true, transaction});
    const packages = view.obligations.filter(row => row.kind === 'PACKAGE');
    assert.equal(packages.length, 2);
    assert.ok(packages.every(row => row.canPayPackage === true && !row.canCash && !row.canUseCredit));
    assert.equal(lookups.length, 2);
    assert.ok(lookups.every(options => options.transaction === transaction));
    assert.equal(view.obligations.find(row => row.kind === 'APPOINTMENT')!.canPayPackage, undefined);
    assert.equal(view.blocker, null);
});

it('keeps the package residual payable regardless of expiry, status or remaining clinical units', async t => {
    t.mock.method(Patient, 'schema', (() => ({findOne: async () => asRecord(context.patient)})) as any);
    for (const extra of [{expiresAt: '2019-01-01'}, {status: 'EXPIRED'}, {status: 'EXHAUSTED', remainingUnits: 0}]) {
        const position = packageRaw([purchasedPackage(extra)]);
        const view = await patientSettlementPositionView(req(packagePay), context, {raw: position, administrationEnabled: true});
        const purchase = view.obligations.find(row => row.kind === 'PACKAGE')!;
        assert.equal(purchase.balance, 400);
        assert.equal(purchase.canPayPackage, true);
        assert.equal(purchase.canCash, false);
        assert.equal(purchase.canUseCredit, false);
        assert.equal(position.queue.some(row => row.kind === 'PACKAGE'), false);
    }
});

it('does not offer package payment without the module, package read rights or payment creation rights', async t => {
    t.mock.method(Patient, 'schema', (() => ({findOne: async () => asRecord(context.patient)})) as any);
    const position = packageRaw([purchasedPackage()]);
    const moduleOff = await patientSettlementPositionView(req(packagePay), context, {raw: position, administrationEnabled: false});
    assert.equal(moduleOff.obligations.find(row => row.kind === 'PACKAGE')!.canPayPackage, false);
    const readOnly = await patientSettlementPositionView(req(packageRead), context, {raw: position, administrationEnabled: true});
    assert.equal(readOnly.obligations.find(row => row.kind === 'PACKAGE')!.canPayPackage, false);
    const noRead = await patientSettlementPositionView(req([...read, 'payment:create:structure']), context, {raw: position, administrationEnabled: true});
    assert.equal(noRead.obligations.some(row => row.kind === 'PACKAGE'), false);
});

it('uses canonical own patient access through another own appointment rather than ownership of the reference', async t => {
    const ownContext = {...context, patient: {...context.patient, userId: anotherOperator}, ownPackagePatient: false};
    const request = req([...read, 'care_package:read:own', 'payment:create:own']);
    request.user!.sub = packageOperator;
    const lookups: string[] = [];
    t.mock.method(Patient, 'schema', (() => ({findOne: async (options: any) => {
        const ownCondition = options.where[Op.and][1].id[Op.in].val as string;
        lookups.push(ownCondition);
        assert.match(ownCondition, /EXISTS.*SELECT 1 FROM[\s\S]*agenda_events/);
        assert.ok(ownCondition.includes(packageOperator));
        assert.ok(ownCondition.includes(structureId));
        return asRecord(ownContext.patient);
    }})) as any);
    const position = packageRaw([purchasedPackage()]);
    const view = await patientSettlementPositionView(request, ownContext, {raw: position, administrationEnabled: true});
    assert.equal(position.referenceEvent!.calendarId, null);
    assert.equal(view.obligations.find(row => row.kind === 'PACKAGE')!.canPayPackage, true);
    assert.equal(lookups.length, 2);
});

it('keeps packages inaccessible when canonical own authorization finds no permitted patient', async t => {
    t.mock.method(Patient, 'schema', (() => ({findOne: async () => null})) as any);
    const request = req([...read, 'care_package:read:own', 'payment:create:own']);
    request.user!.sub = packageOperator;
    const view = await patientSettlementPositionView(request, {...context, ownPackagePatient: true},
        {raw: packageRaw([purchasedPackage()]), administrationEnabled: true});
    assert.equal(view.obligations.some(row => row.kind === 'PACKAGE'), false);
});

it('requires the selected site, patient site and package context site to agree', async t => {
    t.mock.method(Patient, 'schema', (() => ({findOne: async () => asRecord(context.patient)})) as any);
    const request = req(packagePay);
    request.user!.sid = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000099';
    const selectedElsewhere = await patientSettlementPositionView(request, context, {raw: packageRaw([purchasedPackage()]), administrationEnabled: true});
    assert.equal(selectedElsewhere.obligations.some(row => row.kind === 'PACKAGE'), false);
    const movedPatient = await patientSettlementPositionView(req(packagePay), {...context, patient: {...context.patient, structureId: request.user!.sid}},
        {raw: packageRaw([purchasedPackage()]), administrationEnabled: true});
    assert.equal(movedPatient.obligations.some(row => row.kind === 'PACKAGE'), false);
});

it('does not suppress unexpected package authorization errors or invalid request contexts', async t => {
    const position = packageRaw([purchasedPackage()]);
    for (const statusCode of [400, 409, 500]) {
        const failure = Object.assign(new Error('Package context failure'), {statusCode});
        t.mock.method(Patient, 'schema', (() => ({findOne: async () => {throw failure;}})) as any);
        await assert.rejects(() => patientSettlementPositionView(req(packagePay), context, {raw: position, administrationEnabled: true}),
            error => error === failure);
    }
});

it('does not expose a package payment target for legacy purchases or for an already invoiced package', async t => {
    t.mock.method(Patient, 'schema', (() => ({findOne: async () => asRecord(context.patient)})) as any);
    const legacy = packageRaw([purchasedPackage({templateId: null})]);
    assert.equal((await patientSettlementPositionView(req(packagePay), context, {raw: legacy, administrationEnabled: true})).obligations.some(row => row.kind === 'PACKAGE'), false);
    const invoice = {id: 'invoice', patientID: patientId, structureId, documentNumber: 10, documentYear: 2020,
        documentType: 'fattura', status: 'unpaid', invoiceTotal: 400, emissionDate: '2020-01-01', carePackageId: packageId};
    const invoiced = buildPatientSettlementPosition(context, {events: [{...event, appointmentPaymentHistoryKnown: true}],
        packages: [purchasedPackage({invoiceId: 'invoice'})], invoices: [invoice], links: [], payments: [], prices: new Map([['current', {amount: 60}]])});
    const view = await patientSettlementPositionView(req(packagePay), context, {raw: invoiced, administrationEnabled: true});
    assert.equal(view.obligations.some(row => row.kind === 'PACKAGE'), false);
    assert.equal(view.obligations.filter(row => row.kind === 'INVOICE').length, 1);
    assert.equal(view.obligations.find(row => row.kind === 'INVOICE')!.balance, 400);
});

it('exposes a resolvable current issue and collection capability without requiring an eligible obligation', async () => {
    const view = await patientSettlementPositionView(req([...read, 'payment:create:structure']), context,
        {raw: raw(), administrationEnabled: false});
    assert.equal(view.reference.currentEligible, false);
    assert.equal(view.issues![0].kind, 'UNKNOWN_PREVIOUS_PAYMENT');
    assert.equal(view.issues![0].canResolve, true);
    assert.equal(view.issues![0].canCash, true);
    assert.equal(view.capabilities.cash, true);
    assert.equal(view.totals.knownOutstandingAmount, 0);
});

it('requires collection rights and price rights only when the historical final price is missing', async () => {
    const readOnly = await patientSettlementPositionView(req(read), context, {raw: raw(), administrationEnabled: false});
    assert.equal(readOnly.issues![0].canResolve, false);
    assert.equal(readOnly.capabilities.cash, false);
    const noPricing = await patientSettlementPositionView(req([...read, 'payment:create:structure']), context,
        {raw: raw({amount: 60, estimated: true}), administrationEnabled: false});
    assert.equal(noPricing.issues![0].canResolve, false);
    assert.equal(noPricing.issues![0].expectedAmount, null);
    assert.equal(noPricing.issues![0].suggestedAmount, 60);
    const pricing = await patientSettlementPositionView(req([...read, 'payment:create:structure', 'appointment_pricing:update:structure']), context,
        {raw: raw({amount: 60, estimated: true}), administrationEnabled: false});
    assert.equal(pricing.issues![0].canResolve, true);
    assert.equal(pricing.issues![0].canSetPrice, true);
});

it('keeps missing fiscal links visible without providing cash or historical completion actions', async () => {
    const position = buildPatientSettlementPosition(context, {events: [{...event, invoiceId: 'missing'}],
        invoices: [], links: [], payments: [], prices: new Map()});
    const view = await patientSettlementPositionView(req([...read, 'payment:create:structure', 'appointment_pricing:update:structure']),
        context, {raw: position, administrationEnabled: false});
    assert.equal(view.issues![0].kind, 'UNRESOLVED_INVOICE');
    assert.equal(view.issues![0].canResolve, false);
    assert.equal(view.issues![0].canCash, false);
    assert.equal(view.capabilities.cash, false);
});


it('keeps an implicit missing fiscal link readable while refusing an explicit inaccessible invoice reference', async t => {
    const eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003';
    const invoiceId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004';
    const record = (row: Record<string, any>) => ({get: () => row});
    t.mock.method(Patient, 'schema', (() => ({findByPk: async () => record({id: patientId, structureId})})) as any);
    t.mock.method(AgendaEvent, 'schema', (() => ({findByPk: async () => record({...event, id: eventId, invoiceId})})) as any);
    t.mock.method(Invoice, 'schema', (() => ({findByPk: async () => null})) as any);
    t.mock.method(Structure, 'findOne', (async () => ({id: structureId})) as any);
    const request = req(read);
    const result = await resolvePatientSettlementContext(request, {referenceAgendaEventId: eventId});
    assert.equal(result.referenceAgendaEventId, eventId);
    assert.equal(result.referenceInvoiceId, undefined);
    await assert.rejects(() => resolvePatientSettlementContext(request,
        {referenceAgendaEventId: eventId, referenceInvoiceId: invoiceId}), /Fattura non trovata/);
});

it('resolves a reverse-only invoice reference to the same event without requiring a duplicated legacy link', async t => {
    const eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003';
    const invoiceId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004';
    const invoice = {id: invoiceId, patientID: patientId, structureId, agendaEventId: eventId};
    const record = (row: Record<string, any>) => ({get: (field?: unknown) => typeof field === 'string' ? row[field] : row});
    t.mock.method(Patient, 'schema', (() => ({findByPk: async () => record({id: patientId, structureId})})) as any);
    t.mock.method(AgendaEvent, 'schema', (() => ({findByPk: async () => record({...event, id: eventId})})) as any);
    t.mock.method(InvoiceAgendaEvent, 'schema', (() => ({findOne: async () => null})) as any);
    t.mock.method(Invoice, 'schema', (() => ({findByPk: async () => record(invoice), findOne: async () => record(invoice)})) as any);
    t.mock.method(Structure, 'findOne', (async () => ({id: structureId})) as any);
    const result = await resolvePatientSettlementContext(req(read), {referenceAgendaEventId: eventId});
    assert.equal(result.referenceInvoiceId, invoiceId);
    const explicit = await resolvePatientSettlementContext(req(read), {referenceAgendaEventId: eventId, referenceInvoiceId: invoiceId});
    assert.equal(explicit.referenceInvoiceId, invoiceId);
});


it('preserves a date-only historical issue without inventing a midnight start time', async () => {
    const position = buildPatientSettlementPosition(context, {events: [{...event, start: '2020-01-10'}],
        invoices: [], links: [], payments: [], prices: new Map([['current', {amount: 60}]])});
    const view = await patientSettlementPositionView(req([...read, 'payment:create:structure']), context,
        {raw: position, administrationEnabled: false});
    assert.equal(view.issues![0].date, '2020-01-10');
    assert.equal(view.issues![0].start, null);
});
