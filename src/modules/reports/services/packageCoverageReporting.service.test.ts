import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';
import {Op} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {CarePackage, PackageConsumption} from '../../administration/models/index.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import Patient from '../../patients/models/patient.model.js';
import {loadPackageCoverage, packageSessionValue, PackageCoverageEvidence, projectPackageCoverage} from './packageCoverageReporting.service.js';

type Row = Record<string, any>;
const site = '11111111-1111-4111-8111-111111111111';
const patientId = '22222222-2222-4222-8222-222222222222';
const packageId = '33333333-3333-4333-8333-333333333333';
const userId = '44444444-4444-4444-8444-444444444444';
const serviceA = '55555555-5555-4555-8555-555555555555';
const serviceB = '66666666-6666-4666-8666-666666666666';
const invoiceId = '77777777-7777-4777-8777-777777777777';
const model = (value: Row) => ({get(key?: unknown) {return typeof key === 'string' ? value[key] : value;}});
const pack = (overrides: Row = {}): Row => ({id: packageId, patientId, structureId: site, templateId: 'template-1', name: 'Percorso concordato',
    serviceId: serviceA, purchasedUnits: 10, totalPrice: 400, invoiceId: null, ...overrides});
const event = (overrides: Row = {}): Row => ({id: 'event-1', patientId, structureId: site, status: 'CONFIRMED',
    carePackageId: packageId, carePackageServiceId: serviceA, packageReservationStatus: 'RESERVED', ...overrides});
const receipt = (overrides: Row = {}): Row => ({id: 'receipt-1', carePackageId: packageId, invoiceId: null,
    source: 'PACKAGE_PURCHASE', status: 'POSTED', amount: 100, method: 'Carta', ...overrides});
const invoice = (overrides: Row = {}): Row => ({id: invoiceId, carePackageId: packageId, patientID: patientId, structureId: site,
    invoiceTotal: 400, invoiceNet: 400, documentType: 'fattura', emissionDate: '2026-01-01', status: 'partial', ...overrides});
const consumption = (overrides: Row = {}): Row => ({id: 'consumption-1', agendaEventId: 'event-1', packageId,
    serviceId: serviceA, units: 1, type: 'CONSUME', status: 'POSTED', ...overrides});
const evidence = (overrides: Partial<PackageCoverageEvidence> = {}): PackageCoverageEvidence => ({packages: [pack()], payments: [], consumptions: [], ...overrides});
beforeEach((t: any) => {t.mock.method(sequelize, 'query', (async () => {throw new Error('Unmocked SQL is forbidden in package reporting unit tests');}) as any);});

describe('contractual package session values', () => {
    it('uses the sold package agreement and rounds its average to cents', () => {
        assert.deepEqual(packageSessionValue(pack(), serviceA), {value: 40});
        assert.deepEqual(packageSessionValue(pack({purchasedUnits: 3, totalPrice: 100}), serviceA), {value: 33.33});
        assert.equal(packageSessionValue(pack(), serviceB).value, null);
    });
    it('uses discounted customer totals per service and excludes products from mixed quotes', () => {
        const quote = pack({templateId: null, quoteId: 'quote-1', serviceId: null, purchasedUnits: 5, totalPrice: 300,
            lines: [{id: 'a', itemType: 'SERVICE', itemId: serviceA, quantity: 2, baseUnitPrice: 100, unitPrice: 50, total: 100},
                {id: 'b', itemType: 'SERVICE', itemId: serviceB, quantity: 3, unitPrice: 60, total: 180},
                {itemType: 'PRODUCT', quantity: 1, unitPrice: 20, total: 20}]});
        assert.deepEqual(packageSessionValue(quote, serviceA), {value: 50}); assert.deepEqual(packageSessionValue(quote, serviceB), {value: 60});
        assert.equal(packageSessionValue(quote, null).value, null);
    });
    it('preserves frozen VAT and contribution totals instead of recalculating a current tariff', () => {
        const quote = pack({templateId: null, quoteId: 'quote-1', purchasedUnits: 2, totalPrice: 126.88,
            lines: [{itemType: 'SERVICE', itemId: serviceA, quantity: 2, unitPrice: 50, baseUnitPrice: 100,
                socialSecurity: {fund: 'INPS_GS', mode: 'EXCLUDED', rate: 4}, vatRate: 22, total: 126.88}]});
        assert.deepEqual(packageSessionValue(quote, serviceA), {value: 63.44});
    });
    it('uses the stored booking mapping and a weighted mean for repeated service lines', () => {
        const quote = pack({templateId: null, quoteId: 'quote-1', serviceId: null, purchasedUnits: 3, totalPrice: 200,
            lines: [{id: 'a', itemType: 'SERVICE', itemId: serviceB, quantity: 2, total: 100},
                {itemType: 'PRODUCT', quantity: 1, total: 20}, {itemType: 'SERVICE', quantity: 1, total: 80}],
            purchaseSnapshot: {booking: {services: [{serviceId: serviceA, purchasedUnits: 3}],
                mappings: [{lineId: 'a', serviceId: serviceA}, {lineId: 'line-2', serviceId: serviceA}]}}});
        assert.deepEqual(packageSessionValue(quote, serviceA), {value: 60});
    });
    it('returns unknown for missing amounts, contradictory totals and ambiguous service mappings', () => {
        assert.equal(packageSessionValue(pack({totalPrice: null}), serviceA).value, null);
        const quote = pack({templateId: null, serviceId: null, purchasedUnits: 2, totalPrice: 100,
            lines: [{id: 'a', itemType: 'SERVICE', quantity: 2, total: 100}]});
        assert.equal(packageSessionValue(quote, serviceA).value, null);
        assert.equal(packageSessionValue({...quote, serviceId: serviceA, totalPrice: 90}, serviceA).value, null);
        assert.equal(packageSessionValue({...quote, serviceId: serviceA, totalPrice: null, lines: [{itemType: 'SERVICE', quantity: 2, total: null}]}, serviceA).value, null);
        assert.equal(packageSessionValue({...quote, purchaseSnapshot: {booking: {mappings: [{lineId: 'a', serviceId: serviceA}, {lineId: 'a', serviceId: serviceB}]}}}, serviceA).value, null);
    });
    it('keeps an explicit zero agreement distinct from a missing price', () => {
        assert.deepEqual(packageSessionValue(pack({totalPrice: 0}), serviceA), {value: 0});
        assert.deepEqual(packageSessionValue(pack({templateId: null, quoteId: 'quote-1', totalPrice: 0,
            lines: [{itemType: 'SERVICE', itemId: serviceA, quantity: 10, total: 0}]}), serviceA), {value: 0});
    });
});

describe('package coverage projection and payment evidence', () => {
    it('reports unpaid and partial quote purchases while keeping session coverage separate from collected money', () => {
        const agreement = pack({templateId: null, quoteId: '44444444-4444-4444-8444-444444444444',
            lines: [{id: '55555555-5555-4555-8555-555555555555', itemType: 'SERVICE', itemId: serviceA,
                description: 'Fisioterapia', quantity: 10, unitPrice: 40, vatRate: 0, total: 400}]});
        const initial = projectPackageCoverage([event()], evidence({packages: [agreement]})).get('event-1')!;
        assert.equal(initial.packageSummary?.paymentStatus, 'unpaid');
        assert.equal(initial.packageSessionValue, 40);
        const partial = projectPackageCoverage([event()], evidence({packages: [agreement], payments: [receipt(),
            receipt({id: 'clinical-coverage', agendaEventId: 'event-1', source: 'PACKAGE', amount: 400})]})).get('event-1')!;
        assert.equal(partial.packageSummary?.paymentStatus, 'partial');
        assert.equal(partial.packageSessionValue, 40);
    });
    it('reports partial purchase payment without reducing the contractual session value', () => {
        const result = projectPackageCoverage([event()], evidence({payments: [receipt()]})).get('event-1')!;
        assert.equal(result.packageSessionValue, 40); assert.equal(result.packageSummary?.paymentStatus, 'partial');
        assert.equal(result.packageReservationStatus, 'RESERVED'); assert.deepEqual(result.paymentMethods, ['Carta']);
    });
    it('counts transferred receipts once and includes subsequent USER payments on the verified purchase invoice', () => {
        const agreement = pack({invoiceId}), bill = invoice();
        const transferred = receipt({invoiceId}), later = receipt({id: 'later', carePackageId: null, invoiceId, source: 'USER', amount: 200});
        const base = evidence({packages: [agreement], purchaseInvoices: [bill], payments: [transferred, {...transferred}, later,
            receipt({id: 'coverage', source: 'PACKAGE', amount: 400}), receipt({id: 'void', status: 'VOID', amount: 400})]});
        assert.equal(projectPackageCoverage([event()], base).get('event-1')?.packageSummary?.paymentStatus, 'partial');
        base.payments.push(receipt({id: 'final', carePackageId: null, invoiceId, source: 'USER', amount: 100}));
        assert.equal(projectPackageCoverage([event()], base).get('event-1')?.packageSummary?.paymentStatus, 'paid');
    });
    it('recognizes a documented quote invoice while leaving unreconciled legacy purchase payments unknown', () => {
        const legacy = pack({templateId: null, quoteId: 'quote-1', invoiceId, lines: [{itemType: 'SERVICE', itemId: serviceA, quantity: 10, total: 400}]});
        const documented = projectPackageCoverage([event()], evidence({packages: [legacy], purchaseInvoices: [invoice({status: 'paid'})]})).get('event-1')!;
        assert.equal(documented.packageSummary?.paymentStatus, 'paid'); assert.equal(documented.packageSessionValue, 40);
        const unknown = projectPackageCoverage([event()], evidence({packages: [{...legacy, invoiceId: null}]})).get('event-1')!;
        assert.equal(unknown.packageSummary?.paymentStatus, 'unknown'); assert.equal(unknown.packageSessionValue, 40);
    });
    it('never exposes an invoice identifier or claims absence without invoice access', () => {
        const result = projectPackageCoverage([event()], evidence({packages: [pack({invoiceId})], purchaseInvoices: [invoice()], payments: [receipt()]})).get('event-1')!;
        assert.equal(result.packageSummary?.invoiceId, null); assert.equal(result.packageSummary?.invoiceStatus, 'unknown');
        assert.equal(result.packageSummary?.canOpen, false);
        const noInvoice = projectPackageCoverage([event()], evidence()).get('event-1')!;
        assert.equal(noInvoice.packageSummary?.invoiceStatus, 'unknown');
    });
    it('reports a void purchase document without erasing its real receipt or treating void as paid', () => {
        const bill = invoice({status: 'void'});
        const result = projectPackageCoverage([event()], evidence({packages: [pack({invoiceId})], purchaseInvoices: [bill], invoices: [bill],
            invoiceReadablePatients: new Set([`${patientId}:${site}`]), payments: [receipt()]})).get('event-1')!;
        assert.equal(result.packageSummary?.invoiceId, invoiceId); assert.equal(result.packageSummary?.invoiceStatus, 'void');
        assert.equal(result.packageSummary?.paymentStatus, 'partial');
    });
    it('does not use another patient or site package to populate the summary', () => {
        const hidden = pack({patientId: 'other-patient', name: 'Hidden name', invoiceId});
        const result = projectPackageCoverage([event()], evidence({packages: [hidden], openablePackageIds: new Set([packageId])})).get('event-1')!;
        assert.equal(result.packageSessionValue, null); assert.equal(result.packageSummary?.name, 'Pacchetto');
        assert.equal(result.packageSummary?.invoiceId, null); assert.equal(result.packageSummary?.canOpen, false);
    });
    it('recognizes a unique verified legacy consumption without requiring a synthetic payment row', () => {
        const legacyEvent = event({carePackageId: null, carePackageServiceId: null, packageReservationStatus: null, status: 'COMPLETED'});
        const result = projectPackageCoverage([legacyEvent], evidence({consumptions: [consumption()]})).get('event-1')!;
        assert.equal(result.carePackageId, packageId); assert.equal(result.packageReservationStatus, 'CONSUMED'); assert.equal(result.packageSessionValue, 40);
    });
    it('excludes reversed consumptions and never reactivates an explicitly released assignment', () => {
        const legacy = event({carePackageId: null, packageReservationStatus: null});
        assert.equal(projectPackageCoverage([legacy], evidence({consumptions: [consumption({status: 'REVERSED'})]})).size, 0);
        assert.equal(projectPackageCoverage([event({packageReservationStatus: 'RELEASED'})], evidence({consumptions: [consumption()]})).size, 0);
        assert.equal(projectPackageCoverage([event({status: 'CANCELLED'})], evidence({consumptions: [consumption()]})).size, 0);
    });
    it('keeps ambiguous historical traces unknown instead of inventing a package association', () => {
        const legacy = event({carePackageId: null, packageReservationStatus: null});
        const result = projectPackageCoverage([legacy], evidence({consumptions: [consumption(), consumption({id: 'duplicate', packageId: 'other-package'})]})).get('event-1')!;
        assert.equal(result.carePackageId, null); assert.equal(result.packageSummary, null); assert.equal(result.packageSessionValue, null);
        assert.ok(result.packageValueUnavailableReason);
    });
});

describe('batch coverage loading and access boundaries', () => {
    it('loads one purchase and its invoice evidence for multiple sessions without altering the supplied cash rows', async t => {
        const reads: Array<{model: string; options: any}> = [];
        const agreement = pack({invoiceId}), bill = invoice();
        t.mock.method(PackageConsumption, 'schema', (() => ({findAll: async () => {throw new Error('Modern assignments do not need a legacy lookup');}})) as any);
        t.mock.method(CarePackage, 'schema', (() => ({findAll: async (options: any) => {reads.push({model: 'package', options});
            return options.attributes.length === 1 ? [model({id: packageId})] : [model(agreement)];}})) as any);
        t.mock.method(Invoice, 'schema', (() => ({findAll: async (options: any) => {reads.push({model: 'invoice', options}); return [model(bill)];}})) as any);
        t.mock.method(InvoicePayment, 'schema', (() => ({findAll: async (options: any) => {reads.push({model: 'payment', options});
            return [model(receipt({source: 'USER', carePackageId: null, invoiceId, amount: 400}))];}})) as any);
        t.mock.method(Patient, 'schema', (() => ({findAll: async (options: any) => {reads.push({model: 'patient', options}); return [model({id: patientId, structureId: site})];}})) as any);
        const request: any = {tenantSchema: 'rehablo_test', query: {}, user: {sub: userId, sid: site,
            perms: ['care_package:read:structure', 'invoice:read:structure']}};
        const cashRows = [{id: 'existing', source: 'APPOINTMENT', amount: 50}], snapshot = JSON.stringify(cashRows);
        const result = await loadPackageCoverage(request, [event(), event({id: 'event-2', packageReservationStatus: 'CONSUMED'})], cashRows);
        assert.equal(result.size, 2); assert.equal(result.get('event-1')?.packageSummary?.paymentStatus, 'paid');
        assert.equal(result.get('event-1')?.packageSummary?.invoiceId, invoiceId); assert.equal(result.get('event-1')?.packageSummary?.invoiceStatus, 'issued');
        assert.equal(result.get('event-1')?.packageSummary?.canOpen, true); assert.equal(JSON.stringify(cashRows), snapshot);
        assert.equal(reads.filter(read => read.model === 'invoice').length, 1); assert.equal(reads.filter(read => read.model === 'payment').length, 1);
        const paymentWhere = reads.find(read => read.model === 'payment')!.options.where;
        assert.deepEqual(paymentWhere[Op.or].find((branch: any) => branch.invoiceId).invoiceId[Op.in], [invoiceId]);
        const references = reads.find(read => read.model === 'package')!.options.where[Op.or];
        assert.ok(references.every((reference: Row) => reference.patientId === patientId && reference.structureId === site));
    });
    it('uses the quote drawer permission bucket without granting invoice access', async t => {
        const agreement = pack({templateId: null, quoteId: 'quote-1', lines: [{itemType: 'SERVICE', itemId: serviceA, quantity: 10, total: 400}]});
        let openWhere: any;
        t.mock.method(CarePackage, 'schema', (() => ({findAll: async (options: any) => {
            if (options.attributes.length === 1) {openWhere = options.where; return [model({id: packageId})];} return [model(agreement)];}})) as any);
        t.mock.method(InvoicePayment, 'schema', (() => ({findAll: async () => []})) as any);
        t.mock.method(Patient, 'schema', (() => ({findAll: async () => {throw new Error('Invoice permission is absent');}})) as any);
        const result = await loadPackageCoverage({tenantSchema: 'rehablo_test', query: {}, user: {sub: userId, sid: site, perms: ['quote:read:structure']}} as any, [event()]);
        assert.equal(result.get('event-1')?.packageSummary?.canOpen, true); assert.equal(result.get('event-1')?.packageSummary?.invoiceStatus, 'unknown');
        const branches = openWhere[Op.and][1][Op.or]; assert.equal(branches.length, 1); assert.equal(branches[0][Op.and][1].templateId, null);
    });
});
