import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {it, TestContext} from 'node:test';
import {Op} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {CarePackage, PackageTemplate, PackageConsumption, FinancialAccount, PaymentMethod, TreasuryMovement, Quote} from '../models/index.js';
import Patient from '../../patients/models/patient.model.js';
import Service from '../../products-services/models/service.model.js';
import Product from '../../products-services/models/product.model.js';
import ServiceStructure from '../../products-services/models/serviceStructure.model.js';
import ProductStructure from '../../products-services/models/productStructure.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import InvoiceService from '../../invoice/models/invoiceService.model.js';
import InvoiceProduct from '../../invoice/models/invoiceProduct.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import {Tenant, Structure} from '../../auth/models/index.js';
import {FinancialOperation} from '../models/financialOperation.model.js';
import {createCarePackage, createPackagePayment, createPackageInvoice, voidPackagePayment, getCarePackage, listCarePackages, setupCarePackageBooking, packagePaymentOptions} from './carePackage.controller.js';
import {packageMoneySummary, packagePatientWhere} from '../services/carePackage.service.js';
import {createPayment as createInvoicePayment} from '../../invoice/controllers/payment.controller.js';

const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const tenantId = id(1), structureId = id(2), patientId = id(3), templateId = id(4), serviceId = id(5), accountId = id(6), methodId = id(7);
const schema = 'rehablo_' + tenantId.replaceAll('-', '');
const PaymentModel = InvoicePayment.schema(schema);
const record = (values: Record<string, any>): any => ({...values,
    get(key: unknown) {if (typeof key === 'string') return this[key]; return Object.fromEntries(Object.entries(this).filter(([, value]) => typeof value !== 'function'));},
    async update(changes: object) {Object.assign(this, changes); return this;}});
const values = (row: any) => row.get({plain: true});
function matches(row: any, where: any): boolean {
    if (!where || where.val) return true;
    return Reflect.ownKeys(where).every(key => {
        const value = where[key];
        if (key === Op.and) return value.every((part: any) => matches(row, part));
        if (key === Op.or) return value.some((part: any) => matches(row, part));
        if (typeof key !== 'string') return true;
        const actual = row.get(key);
        if (Array.isArray(value)) return value.includes(actual);
        if (value && typeof value === 'object') {
            if (value[Op.in]) return Array.isArray(value[Op.in]) ? value[Op.in].includes(actual) : true;
            if (Reflect.ownKeys(value).includes(Op.ne)) return actual !== value[Op.ne] && !(actual == null && value[Op.ne] == null);
            return true;
        }
        return value == null ? actual == null : actual === value;
    });
}
function fixture(t: TestContext) {
    const collections = new Map<any, any[]>();
    const packagePages: any[] = [];
    const install = (model: any, rows: any[] = []) => {
        collections.set(model, rows);
        t.mock.method(model, 'schema', (() => ({
            findAndCountAll: async (options: any) => {packagePages.push(options); const matching = rows.filter(row => matches(row, options.where))
                .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || String(a.id).localeCompare(String(b.id)));
                return {count: matching.length, rows: matching.slice(options.offset, options.offset + options.limit)};},
            findOne: async ({where}: any) => rows.find(row => matches(row, where)) ?? null,
            findByPk: async (key: string) => rows.find(row => row.get('id') === key) ?? null,
            findAll: async ({where, raw}: any = {}) => rows.filter(row => matches(row, where)).map(row => raw ? values(row) : row),
            create: async (value: any) => {const row = record({id: randomUUID(), createdAt: new Date().toISOString(), ...value}); rows.push(row); return row;},
            update: async (changes: object, {where}: any) => {for (const row of rows.filter(row => matches(row, where))) await row.update(changes);},
            count: async ({where}: any = {}) => rows.filter(row => matches(row, where)).length
        })) as any);
        return rows;
    };
    const templates = install(PackageTemplate, [record({id: templateId, structureId, name: '10 fisioterapie', serviceId,
        serviceName: 'Fisioterapia', sessionCount: 10, totalPrice: 400, validityDays: null, isActive: true})]);
    const packages = install(CarePackage), events = install(AgendaEvent), invoices = install(Invoice), lines = install(InvoiceService), ledger = install(TreasuryMovement);
    const quotes = install(Quote);
    install(PackageConsumption); install(InvoiceProduct); install(InvoiceAgendaEvent); install(ServiceStructure); install(ProductStructure); install(Product); install(FinancialOperation);
    install(Patient, [record({id: patientId, name: 'Mario', surname: 'Rossi', structureId})]);
    const services = install(Service, [record({id: serviceId, name: 'Fisioterapia', sellingPrice: 70, productVat: 'N4', isActive: true, availabilityMode: 'ALL'})]);
    const accounts = install(FinancialAccount, [record({id: accountId, name: 'Cassa', currency: 'EUR', type: 'CASH', structureId, isActive: true})]);
    install(PaymentMethod, [record({id: methodId, label: 'Contanti', isActive: true})]);
    const issuer = record({id: tenantId, businessName: 'Studio', VATNumber: '12345678901', address: 'Via Roma 1', city: 'Roma', zipCode: '00100', taxRegime: 'forfettario', lastDocumentNumberByYear: {}});
    t.mock.method(Tenant, 'findByPk', (async () => issuer) as any);
    t.mock.method(Structure, 'findOne', (async () => record({id: structureId, tenantId})) as any);
    const payments: any[] = [];
    collections.set(InvoicePayment, payments);
    t.mock.method(InvoicePayment, 'schema', (() => ({
        findOne: async ({where}: any) => payments.find(row => matches(row, where)) ?? null,
        findAll: async ({where}: any = {}) => payments.filter(row => matches(row, where)),
        create: async (data: any, options: any) => {
            const row = PaymentModel.build(data); payments.push(row);
            (row as any).update = async (changes: any, opts: any) => {
                (row as any)._previousDataValues = {...row.dataValues}; row.set(changes);
                await (PaymentModel as any).runHooks('afterUpdate', row, opts);
                (row as any)._previousDataValues = {...row.dataValues}; row.changed('status', false); return row;
            };
            await (PaymentModel as any).runHooks('afterCreate', row, options);
            (row as any)._previousDataValues = {...row.dataValues}; row.changed('status', false); return row;
        },
        update: async (changes: any, {where}: any) => {payments.filter(row => matches(row, where)).forEach(row => row.set(changes));}
    })) as any);
    t.mock.method(sequelize, 'query', (async (sql: string, options: any) => {
        if (sql.trimStart().startsWith('SELECT') && sql.includes('treasury_movements')) return [ledger.filter(row => row.sourceId === options.replacements.sourceId && row.direction === 'IN' && row.status === 'POSTED').map(values), {}];
        if (sql.includes('INSERT INTO') && sql.includes('INVOICE_PAYMENT_VOID')) {
            const original = ledger.find(row => row.sourceId === options.replacements.sourceId && row.direction === 'IN');
            if (original && !ledger.some(row => row.reversalOfId === original.id)) ledger.push(record({id: randomUUID(), direction: 'OUT', amount: original.amount, reversalOfId: original.id}));
        } else if (sql.includes('INSERT INTO')) ledger.push(record({...options.replacements, direction: 'IN', status: 'POSTED', sourceType: 'INVOICE_PAYMENT'}));
        return [[], {}];
    }) as any);
    let tail = Promise.resolve();
    t.mock.method(sequelize, 'transaction', ((work: any) => {
        const task = tail.then(async () => {
            const snapshots = [...collections.values()].map(rows => ({rows, originals: rows.slice(), states: rows.map(values)}));
            try {return await work({LOCK: {UPDATE: 'UPDATE'}});} catch (error) {
                for (const snapshot of snapshots) {snapshot.rows.splice(0, snapshot.rows.length, ...snapshot.originals); snapshot.rows.forEach((row, index) => row.set ? row.set(snapshot.states[index]) : Object.assign(row, snapshot.states[index]));}
                throw error;
            }
        }); tail = task.then(() => undefined, () => undefined); return task;
    }) as any);
    return {templates, packages, events, payments, ledger, invoices, lines, services, quotes, packagePages, accounts};
}
function request(body: object, params: object = {}, key = 'purchase-operation-001'): any {
    return {tenantSchema: schema, body, params, query: {}, header: () => key,
        user: {isSuperAdmin: true, sub: id(8), sid: structureId, tenants: [{id: tenantId}]},
        access: {scope: 'tenant', userId: id(8), structureId}};
}
function run(handler: any, req: any): Promise<{status: number; data: any; message: string}> {
    return new Promise(resolve => {const res: any = {code: 200, status(code: number) {this.code = code; return this;},
        json(body: any) {resolve({status: this.code, data: body.data, message: body.message}); return this;}};
        handler(req, res, (error: any) => resolve({status: error?.statusCode ?? 500, data: null, message: error?.message}));});
}
const receipt = (amount: number) => ({amount, accountId, paymentMethodId: methodId, paidAt: '2026-01-01'});
const quotedPackage = (overrides: Record<string, any> = {}) => record({id: id(20), patientId, structureId, templateId: null,
    quoteId: id(50), name: 'Percorso concordato', purchasedUnits: 10, remainingUnits: 8, totalPrice: 500,
    status: 'ACTIVE', createdAt: '2025-12-01T10:00:00.000Z', invoiceId: null,
    lines: [{id: 'line-fisio', itemType: 'SERVICE', itemId: serviceId, description: 'Fisioterapia concordata', quantity: 4, unitPrice: 50, total: 200, vatNature: 'N4'},
        {id: 'line-tecar', itemType: 'SERVICE', itemId: null, description: 'Tecarterapia concordata', quantity: 6, unitPrice: 50, total: 300, vatNature: 'N4'}],
    ...overrides});

it('collects and invoices an existing multiple-service quote package without charging its sessions again', async t => {
    const f = fixture(t), pack = quotedPackage(); f.packages.push(pack);
    const detail = await run(getCarePackage, request({}, {id: pack.id}));
    assert.equal(detail.status, 200, detail.message); assert.equal(detail.data.financialAvailable, true);
    assert.equal(detail.data.legacy, true); assert.equal(detail.data.balance, 500); assert.equal(detail.data.paidAmount, 0);
    assert.equal(detail.data.purchasedAt, pack.createdAt);
    const paid = await run(createPackagePayment, request(receipt(100), {id: pack.id}, 'quoted-receipt-001'));
    assert.equal(paid.status, 200, paid.message); assert.equal(paid.data.balance, 400);
    const paymentId = f.payments[0].id;
    assert.equal(f.payments[0].carePackageId, pack.id); assert.equal(f.payments[0].agendaEventId, null);
    assert.equal(f.payments[0].source, 'PACKAGE_PURCHASE');
    const repeated = await run(createPackagePayment, request(receipt(100), {id: pack.id}, 'quoted-receipt-001'));
    assert.equal(repeated.status, 200, repeated.message); assert.equal(f.payments.length, 1); assert.equal(f.ledger.length, 1);
    f.services[0].sellingPrice = 900; f.services[0].name = 'Catalogo modificato';
    const emitted = await run(createPackageInvoice, request({}, {id: pack.id}, 'quoted-invoice-001'));
    assert.equal(emitted.status, 201, emitted.message); assert.equal(f.invoices[0].invoiceNet, 500);
    assert.equal(f.lines.length, 2); assert.equal(f.payments[0].id, paymentId);
    assert.equal(f.payments[0].invoiceId, emitted.data.invoiceId); assert.equal(f.ledger.length, 1);
    const retriedInvoice = await run(createPackageInvoice, request({}, {id: pack.id}, 'quoted-invoice-001'));
    assert.equal(retriedInvoice.status, 200, retriedInvoice.message); assert.equal(f.invoices.length, 1);
    const settled = await run(createPackagePayment, request(receipt(400), {id: pack.id}, 'quoted-receipt-002'));
    assert.equal(settled.status, 200, settled.message); assert.equal(settled.data.balance, 0);
    assert.equal(f.invoices[0].status, 'paid'); assert.equal(f.payments.length, 2);
    assert.equal(f.ledger.reduce((sum, row) => sum + Number(row.amount), 0), 500);
    assert.equal(pack.purchasedUnits, 10); assert.equal(pack.remainingUnits, 8); assert.equal(f.events.length, 0);
});

it('invoices a quoted package before its receipts and reverses only the recorded purchase money', async t => {
    const f = fixture(t), pack = quotedPackage(); f.packages.push(pack);
    const emitted = await run(createPackageInvoice, request({}, {id: pack.id}, 'quote-first-invoice-001'));
    assert.equal(emitted.status, 201, emitted.message); assert.equal(f.payments.length, 0); assert.equal(f.ledger.length, 0);
    const first = await run(createPackagePayment, request(receipt(100), {id: pack.id}, 'quote-after-invoice-001'));
    assert.equal(first.status, 200, first.message); assert.equal(first.data.balance, 400);
    assert.equal(f.payments[0].invoiceId, emitted.data.invoiceId);
    const reversed = await run(voidPackagePayment, request({reason: 'Incasso registrato per errore'}, {id: pack.id, paymentId: f.payments[0].id}));
    assert.equal(reversed.status, 200, reversed.message); assert.equal(reversed.data.balance, 500);
    assert.equal(reversed.data.paidAmount, 0); assert.equal(f.ledger.length, 2);
    assert.equal(pack.remainingUnits, 8);
});

it('updates the quote package balance when its invoice is paid directly without a second receipt ledger', async t => {
    const f = fixture(t), pack = quotedPackage(); f.packages.push(pack);
    const emitted = await run(createPackageInvoice, request({}, {id: pack.id}, 'direct-quote-invoice-001'));
    assert.equal(emitted.status, 201, emitted.message);
    const invoiceId = emitted.data.invoiceId;
    for (const [index, amount] of [100, 400].entries()) {
        const req = request(receipt(amount), {invoiceId}, `direct-quote-payment-${index}`);
        const paid = await run(createInvoicePayment, req);
        assert.equal(paid.status, 201, paid.message);
        assert.equal(f.payments[index].carePackageId, pack.id);
        assert.equal(f.payments[index].source, 'PACKAGE_PURCHASE');
        const retry = await run(createInvoicePayment, req);
        assert.equal(retry.status, 200, retry.message);
        const detail = await run(getCarePackage, request({}, {id: pack.id}));
        assert.equal(detail.data.balance, index === 0 ? 400 : 0);
        assert.equal(detail.data.paidAmount, index === 0 ? 100 : 500);
    }
    assert.equal(f.invoices[0].status, 'paid'); assert.equal(f.payments.length, 2); assert.equal(f.ledger.length, 2);
    assert.equal(f.ledger.reduce((sum, row) => sum + Number(row.amount), 0), 500);
    assert.equal(pack.remainingUnits, 8);
});

it('keeps a documented zero-price quote settled without inventing a receipt', async t => {
    const f = fixture(t), pack = quotedPackage({totalPrice: '0.00', lines: quotedPackage().lines.map((line: any) => ({...line, unitPrice: 0, total: 0}))});
    f.packages.push(pack);
    const detail = await run(getCarePackage, request({}, {id: pack.id}));
    assert.equal(detail.status, 200, detail.message); assert.equal(detail.data.financialAvailable, true);
    assert.equal(detail.data.totalPrice, 0); assert.equal(detail.data.balance, 0);
    assert.equal(detail.data.paidAmount, 0); assert.equal(detail.data.paymentStatus, 'paid');
    const emitted = await run(createPackageInvoice, request({}, {id: pack.id}, 'free-quote-invoice-001'));
    assert.equal(emitted.status, 400, emitted.message); assert.equal(f.invoices.length, 0);
    assert.equal(f.payments.length, 0); assert.equal(f.ledger.length, 0); assert.equal(pack.remainingUnits, 8);
});

it('requires quote read and payment permissions for a quote receipt and its account options', async t => {
    const f = fixture(t), pack = quotedPackage(); f.packages.push(pack);
    const req = request(receipt(100), {id: pack.id}, 'quote-rights-receipt-001');
    req.user = {...req.user, isSuperAdmin: false, perms: ['quote:read:structure', 'payment:create:structure']};
    const options = await run(packagePaymentOptions, {...req, query: {patientId}});
    assert.equal(options.status, 200, options.message);
    assert.equal((await run(createPackagePayment, req)).status, 200);
    req.user.perms = ['quote:read:structure'];
    assert.equal((await run(createPackagePayment, {...req, header: () => 'quote-denied-receipt-001'})).status, 403);
    req.user.perms = ['payment:create:structure'];
    assert.equal((await run(createPackagePayment, {...req, header: () => 'quote-no-read-receipt-001'})).status, 403);
    assert.equal(f.payments.length, 1); assert.equal(f.ledger.length, 1);
});

it('keeps incomplete or unrelated historical packages financially unavailable', async t => {
    const f = fixture(t), pack = quotedPackage({lines: [{itemType: 'SERVICE', quantity: 10}]}); f.packages.push(pack);
    for (const data of [{quoteId: id(50)}, {quoteId: null, lines: quotedPackage().lines}]) {
        await pack.update(data);
        const detail = await run(getCarePackage, request({}, {id: pack.id}));
        assert.equal(detail.status, 200, detail.message); assert.equal(detail.data.financialAvailable, false);
        assert.equal(detail.data.paidAmount, null); assert.equal(detail.data.balance, null);
        assert.equal((await run(createPackagePayment, request(receipt(100), {id: pack.id}, 'unavailable-receipt-001'))).status, 409);
    }
    assert.equal(f.payments.length, 0); assert.equal(f.ledger.length, 0);
});

it('projects the frozen quoted agreement for invoice review while keeping booking setup lines unchanged', async t => {
    const f = fixture(t), pack = quotedPackage();
    const agreedLines = pack.lines.map((line: any) => ({...line}));
    pack.purchaseSnapshot = {quote: {id: pack.quoteId, total: 500, lines: agreedLines}};
    pack.lines = pack.lines.map((line: any) => ({...line, description: 'Descrizione modificata', unitPrice: 100, total: line.quantity * 100}));
    f.packages.push(pack);
    const detail = await run(getCarePackage, request({}, {id: pack.id}));
    assert.equal(detail.status, 200, detail.message); assert.equal(detail.data.financialAvailable, true);
    assert.deepEqual(detail.data.lines, agreedLines);
    assert.equal(detail.data.balance, 500);
    assert.ok(detail.data.booking.setupLines.every((line: any) => line.description === 'Descrizione modificata'));
    assert.equal(pack.lines[0].description, 'Descrizione modificata');
});

it('purchase, partial receipt, invoicing and final receipt retain exactly one cash ledger per receipt', async t => {
    const f = fixture(t);
    const purchase = await run(createCarePackage, request({templateId, patientId, payment: receipt(100)}));
    assert.equal(purchase.status, 201, purchase.message); assert.equal(purchase.data.balance, 300); assert.equal(f.ledger.length, 1);
    const packageId = purchase.data.id, originalPaymentId = f.payments[0].id;
    f.templates[0].totalPrice = 800; f.services[0].sellingPrice = 90;
    const emitted = await run(createPackageInvoice, request({}, {id: packageId}, 'invoice-operation-001'));
    assert.equal(emitted.status, 201, emitted.message); assert.equal(f.invoices[0].invoiceNet, 400);
    assert.equal(f.lines[0].servicePrice, 400); assert.equal(f.payments[0].id, originalPaymentId);
    assert.equal(f.payments[0].invoiceId, emitted.data.invoiceId); assert.equal(f.ledger.length, 1);
    const retry = await run(createPackageInvoice, request({}, {id: packageId}, 'invoice-operation-001'));
    assert.equal(retry.status, 200); assert.equal(f.invoices.length, 1);
    const paid = await run(createPackagePayment, request(receipt(300), {id: packageId}, 'receipt-operation-002'));
    assert.equal(paid.status, 200, paid.message); assert.equal(paid.data.balance, 0); assert.equal(f.invoices[0].status, 'paid');
    assert.equal(f.ledger.reduce((sum, row) => sum + Number(row.amount), 0), 400); assert.equal(f.payments.length, 2);
});
it('serializes concurrent purchase/receipt retries and rejects reused keys with different amounts', async t => {
    const f = fixture(t), body = {templateId, patientId};
    const results = await Promise.all([run(createCarePackage, request(body)), run(createCarePackage, request(body))]);
    assert.deepEqual(results.map(row => row.status), [201, 200]); assert.equal(f.packages.length, 1); assert.equal(f.ledger.length, 0);
    const packageId = results[0].data.id;
    const receipts = await Promise.all([run(createPackagePayment, request(receipt(100), {id: packageId}, 'receipt-operation-001')),
        run(createPackagePayment, request(receipt(100), {id: packageId}, 'receipt-operation-001'))]);
    assert.deepEqual(receipts.map(row => row.status), [200, 200]); assert.equal(f.payments.length, 1); assert.equal(f.ledger.length, 1);
    assert.equal((await run(createPackagePayment, request(receipt(110), {id: packageId}, 'receipt-operation-001'))).status, 409);
});
it('uses the sole account automatically and permits an unspecified payment method', async t => {
    const f = fixture(t);
    const purchase = await run(createCarePackage, request({templateId, patientId, payment: {amount: 50, paidAt: '2026-01-01'}}));
    assert.equal(purchase.status, 201, purchase.message);
    assert.equal(f.ledger.length, 1); assert.equal(f.ledger[0].accountId, accountId);
    assert.equal(f.payments[0].method, null);
});
it('creates a cash account only inside a successful initial receipt and requires choice when multiple exist', async t => {
    const f = fixture(t); f.accounts.splice(0);
    const body = {templateId, patientId, payment: {amount: 401, paidAt: '2026-01-01'}};
    assert.equal((await run(createCarePackage, request(body))).status, 409);
    assert.equal(f.accounts.length, 0); assert.equal(f.packages.length, 0);
    body.payment.amount = 50;
    const purchase = await run(createCarePackage, request(body));
    assert.equal(purchase.status, 201, purchase.message); assert.equal(f.accounts.length, 1);
    assert.equal(f.accounts[0].openingBalance, 0); assert.equal(f.ledger[0].accountId, f.accounts[0].id);
    f.accounts.push(record({id: id(99), name: 'Banca', structureId, currency: 'EUR', isActive: true}));
    const next = await run(createPackagePayment, request({amount: 20, paidAt: '2026-01-02'}, {id: purchase.data.id}, 'ambiguous-account-001'));
    assert.equal(next.status, 422); assert.equal(f.ledger.length, 1);
});
it('rolls back acquisition and cash when the initial receipt exceeds the price', async t => {
    const f = fixture(t);
    const result = await run(createCarePackage, request({templateId, patientId, payment: receipt(401)}));
    assert.equal(result.status, 409); assert.equal(f.packages.length, 0); assert.equal(f.payments.length, 0); assert.equal(f.ledger.length, 0);
});
it('refuses a changed catalogue offer before recording an acquisition or money', async t => {
    const f = fixture(t); f.templates[0].updatedAt = new Date('2026-10-02T10:00:00Z');
    const result = await run(createCarePackage, request({templateId, patientId, expectedTemplateUpdatedAt: '2026-10-01T10:00:00Z'}));
    assert.equal(result.status, 409); assert.equal(f.packages.length, 0); assert.equal(f.ledger.length, 0);
});
it('prevents receipt access through another patient package and disallows missing reversal reason', async t => {
    const f = fixture(t), purchase = await run(createCarePackage, request({templateId, patientId, payment: receipt(100)}));
    const other = record({...values(f.packages[0]), id: id(90)}); f.packages.push(other);
    assert.equal((await run(voidPackagePayment, request({reason: 'wrong target'}, {id: other.id, paymentId: f.payments[0].id}))).status, 404);
    assert.equal((await run(voidPackagePayment, request({}, {id: purchase.data.id, paymentId: f.payments[0].id}))).status, 400);
    assert.equal(f.payments[0].status, 'POSTED'); assert.equal(f.ledger.length, 1);
});
it('voids a pre-invoice receipt once, restores the purchase balance and retains units', async t => {
    const f = fixture(t), purchase = await run(createCarePackage, request({templateId, patientId, payment: receipt(100)}));
    const params = {id: purchase.data.id, paymentId: f.payments[0].id};
    const first = await run(voidPackagePayment, request({reason: 'Importo registrato per errore'}, params));
    assert.equal(first.status, 200, first.message); assert.equal(first.data.balance, 400); assert.equal(first.data.remainingUnits, 10);
    assert.equal(f.ledger.length, 2); assert.equal(f.ledger[1].direction, 'OUT');
    assert.equal((await run(voidPackagePayment, request({reason: 'Importo registrato per errore'}, params))).status, 200);
    assert.equal(f.ledger.length, 2);
});
it('does not expose packages belonging to another selected structure', async t => {
    const f = fixture(t); f.packages.push(record({id: id(20), patientId, structureId: id(99), templateId}));
    assert.equal((await run(getCarePackage, request({}, {id: id(20)}))).status, 404);
    const own = request({}); own.user = {...own.user, isSuperAdmin: false, perms: ['care_package:read:own']};
    const where: any = packagePatientWhere(own);
    assert.match(where[Op.and][0].patientId[Op.in].val, /agenda_events/);
});
it('projects expired purchases without bookable units while preserving the unpaid balance', async t => {
    const f = fixture(t), purchase = await run(createCarePackage, request({templateId, patientId}));
    f.packages[0].expiresAt = '2020-01-01';
    const detail = await run(getCarePackage, request({}, {id: purchase.data.id}));
    assert.equal(detail.status, 200); assert.equal(detail.data.status, 'EXPIRED'); assert.equal(detail.data.availableUnits, 0); assert.equal(detail.data.balance, 400);
});
it('excludes voided cash from money balance without treating session usage as payment', () => {
    assert.deepEqual(packageMoneySummary({totalPrice: 400, remainingUnits: 3}, [{amount: 100, status: 'POSTED'}, {amount: 300, status: 'VOID'}]),
        {paidAmount: 100, balance: 300, paymentStatus: 'partial'});
});

it('pages the permitted origins once with a global count and keeps legacy/default queries compatible', async t => {
    const f = fixture(t);
    f.packages.push(record({id: id(20), patientId, structureId, templateId, name: 'Catalogo', purchasedUnits: 10, remainingUnits: 10, totalPrice: 400, serviceId, status: 'ACTIVE', createdAt: '2026-01-01'}),
        record({id: id(21), patientId, structureId, templateId: null, quoteId: id(50), name: 'Da preventivo', purchasedUnits: 10, remainingUnits: 10, totalPrice: 300, serviceId, status: 'ACTIVE', createdAt: '2026-01-03'}),
        record({id: id(22), patientId, structureId, templateId: null, name: 'Sorgente non disponibile', purchasedUnits: 10, remainingUnits: 10, totalPrice: 0, serviceId, status: 'ACTIVE', createdAt: '2026-01-02'}));
    const req = request({}); req.query = {origin: 'all', page: '2', limit: '2'};
    const page = await run(listCarePackages, req);
    assert.equal(page.status, 200, page.message); assert.equal(page.data.total, 3); assert.deepEqual(page.data.items.map((row: any) => row.id), [id(20)]);
    assert.equal(f.packagePages.length, 1); assert.equal(f.packagePages[0].offset, 2); assert.equal(f.packagePages[0].limit, 2);
    req.query = {}; assert.equal((await run(listCarePackages, req)).data.total, 1);
    req.query = {legacy: 'true'}; assert.equal((await run(listCarePackages, req)).data.total, 2);
    for (const [origin, expected] of [['catalog', id(20)], ['quote', id(21)], ['other', id(22)]]) {
        req.query = {origin}; const response = await run(listCarePackages, req);
        assert.deepEqual(response.data.items.map((row: any) => row.id), [expected]);
    }
    req.query = {origin: 'unknown'}; assert.equal((await run(listCarePackages, req)).status, 422);
});

it('applies each origin authorization before paging rather than combining separately limited lists', async t => {
    const f = fixture(t);
    f.packages.push(...[templateId, null].map((template, index) => record({id: id(20 + index), patientId, structureId, templateId: template,
        name: 'Pacchetto', purchasedUnits: 10, remainingUnits: 10, totalPrice: 400, serviceId, status: 'ACTIVE'})));
    const req = request({}); req.user = {...req.user, isSuperAdmin: false, perms: ['care_package:read:own']}; req.query = {origin: 'all'};
    const catalog = await run(listCarePackages, req);
    assert.equal(catalog.data.total, 1); assert.equal(catalog.data.items[0].id, id(20));
    assert.match(f.packagePages[0].where[Op.and][0][Op.or][0][Op.and][0][Op.and][0].patientId[Op.in].val, /agenda_events/);
    req.user.perms = ['quote:read:structure'];
    const previous = await run(listCarePackages, req); assert.equal(previous.data.total, 1); assert.equal(previous.data.items[0].id, id(21));
    assert.equal((await run(getCarePackage, {...req, params: {id: id(20)}})).status, 404);
    assert.equal((await run(getCarePackage, {...req, params: {id: id(21)}})).status, 200);
});

it('distinguishes commercial quote origin from template ACL and protects quote links with document scope', async t => {
    const f = fixture(t);
    f.packages.push(record({id: id(20), patientId, structureId, templateId: null, quoteId: id(50), name: 'Sedute da preventivo', purchasedUnits: 10,
        remainingUnits: 10, totalPrice: 300, serviceId, status: 'ACTIVE'}));
    f.quotes.push(record({id: id(50), patientId, structureId, number: 7, year: 2026, createdByUserId: id(99)}));
    const req = request({}, {id: id(20)}); req.user = {...req.user, isSuperAdmin: false, perms: ['quote:read:own']};
    const ownPackage = await run(getCarePackage, req); assert.equal(ownPackage.status, 200, ownPackage.message);
    assert.equal(ownPackage.data.origin, 'QUOTE'); assert.equal(ownPackage.data.canOpenQuote, false); assert.equal(ownPackage.data.quoteNumber, null);
    req.user.perms = ['quote:read:structure']; const quote = await run(getCarePackage, req);
    assert.equal(quote.data.canOpenQuote, true); assert.equal(quote.data.quoteNumber, 'PRV-2026/0007');
    assert.equal(quote.data.totalPrice, 300); assert.equal(quote.data.paidAmount, null); assert.equal(quote.data.balance, null); assert.equal(quote.data.paymentStatus, null);
    f.packages[0].quoteId = null; f.packages[0].totalPrice = 0;
    const unknown = await run(getCarePackage, req); assert.equal(unknown.data.origin, 'OTHER'); assert.equal(unknown.data.totalPrice, null);
    assert.equal(unknown.data.canOpenQuote, false); assert.equal(unknown.data.quoteId, null);
    f.packages[0].templateId = templateId; f.packages[0].quoteId = id(50); req.user.perms.push('care_package:read:structure');
    assert.equal((await run(getCarePackage, req)).data.origin, 'QUOTE');
});

it('configures the existing historical package with scoped quote rights and preserves all financial facts', async t => {
    const f = fixture(t), stamp = '2026-10-01T10:00:00.000Z';
    f.packages.push(record({id: id(20), patientId, structureId, templateId: null, name: 'Trattamenti precedenti', purchasedUnits: 10, remainingUnits: 8,
        totalPrice: 300, status: 'ACTIVE', updatedAt: stamp, lines: [{id: 'line-1', itemType: 'SERVICE', description: 'Trattamenti', quantity: 10}],
        purchaseSnapshot: {agreement: 'unchanged'}}));
    const req = request({expectedRemainingUnits: 8, expectedUpdatedAt: stamp, lines: [{lineId: 'line-1', serviceId}],
        remainingByService: [{serviceId, remainingUnits: 8}]}, {id: id(20)});
    req.user = {...req.user, isSuperAdmin: false, perms: ['quote:read:structure', 'quote:update:structure']};
    const detail = await run(getCarePackage, req); assert.equal(detail.data.canConfigureBooking, true);
    assert.deepEqual(detail.data.booking.availableServices, [{id: serviceId, name: 'Fisioterapia'}]);
    const [first, second] = await Promise.all([run(setupCarePackageBooking, req), run(setupCarePackageBooking, req)]);
    assert.deepEqual([first.status, second.status], [200, 409]); assert.equal(first.data.id, id(20)); assert.equal(first.data.booking.status, 'READY');
    assert.equal(f.packages.length, 1); assert.equal(f.packages[0].remainingUnits, 8); assert.equal(f.packages[0].totalPrice, 300);
    assert.equal(f.packages[0].purchaseSnapshot.agreement, 'unchanged'); assert.equal(f.packages[0].purchaseSnapshot.bookingAudit.length, 1);
    assert.equal(f.payments.length, 0); assert.equal(f.ledger.length, 0); assert.equal(f.invoices.length, 0);
});

it('rejects stale setup quantities or missing quote update permission before changing the package', async t => {
    const f = fixture(t), stamp = '2026-10-01T10:00:00.000Z';
    f.packages.push(record({id: id(20), patientId, structureId, templateId: null, name: 'Trattamenti', purchasedUnits: 10, remainingUnits: 8,
        totalPrice: 300, status: 'ACTIVE', updatedAt: stamp, lines: [{itemType: 'SERVICE', description: 'Trattamenti', quantity: 10}]}));
    const req = request({expectedRemainingUnits: 9, expectedUpdatedAt: stamp, lines: [{lineId: 'line-0', serviceId}],
        remainingByService: [{serviceId, remainingUnits: 8}]}, {id: id(20)});
    req.user = {...req.user, isSuperAdmin: false, perms: ['quote:read:structure', 'quote:update:structure']};
    assert.equal((await run(setupCarePackageBooking, req)).status, 409); assert.equal(f.packages[0].purchaseSnapshot, undefined);
    req.user.perms = ['quote:read:structure']; assert.equal((await run(setupCarePackageBooking, req)).status, 403);
    assert.equal(f.packages[0].remainingUnits, 8); assert.equal(f.payments.length, 0);
});
