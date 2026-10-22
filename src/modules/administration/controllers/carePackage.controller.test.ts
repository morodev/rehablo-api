import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {it, TestContext} from 'node:test';
import {Op} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {CarePackage, PackageTemplate, PackageConsumption, FinancialAccount, PaymentMethod, TreasuryMovement} from '../models/index.js';
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
import {createCarePackage, createPackagePayment, createPackageInvoice, voidPackagePayment, getCarePackage} from './carePackage.controller.js';
import {packageMoneySummary, packagePatientWhere} from '../services/carePackage.service.js';

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
    const install = (model: any, rows: any[] = []) => {
        collections.set(model, rows);
        t.mock.method(model, 'schema', (() => ({
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
    install(PackageConsumption); install(InvoiceProduct); install(InvoiceAgendaEvent); install(ServiceStructure); install(ProductStructure); install(Product);
    install(Patient, [record({id: patientId, name: 'Mario', surname: 'Rossi', structureId})]);
    const services = install(Service, [record({id: serviceId, name: 'Fisioterapia', sellingPrice: 70, productVat: 'N4', isActive: true, availabilityMode: 'ALL'})]);
    install(FinancialAccount, [record({id: accountId, structureId, isActive: true})]);
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
    return {templates, packages, events, payments, ledger, invoices, lines, services};
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
