import assert from 'node:assert/strict';
import {it, TestContext} from 'node:test';
import {Op} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {requireAnyPermission, requirePermission} from '../../../middleware/rbac.js';
import {CarePackage, Quote} from '../models/index.js';
import Patient from '../../patients/models/patient.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import controller, {normalizeQuoteLines} from './administration.controller.js';
import {getQuote, listQuotes} from './administration.view.controller.js';
import {listCarePackages} from './carePackage.controller.js';
import {documentHash, quoteDocument} from '../services/quoteDocument.js';

const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const tenantId = id(1), structureId = id(2), patientId = id(3), quoteId = id(4), userId = id(5), packageId = id(6);
const schema = 'rehablo_' + tenantId.replaceAll('-', '');
const record = (data: Record<string, any>): any => ({data,
    get(key: unknown) {return typeof key === 'string' ? data[key] : {...data};}});

function fixture(t: TestContext) {
    const quote = record({id: quoteId, structureId, patientId, number: 7, year: 2026, status: 'ACCEPTED',
        issuedAt: '2026-10-01', expiresAt: '2026-10-31', currency: 'EUR', subtotal: 200, total: 200, taxTotal: 0,
        lines: [{itemType: 'SERVICE', description: 'Fisioterapia', quantity: 4, unitPrice: 50, total: 200}], notes: ''});
    const quotes = [quote], packages: any[] = [];
    const patients = [record({id: patientId, name: 'Mario', surname: 'Rossi', structureId})];
    const calls: Array<{model: any; schema: string; method: string; options: any}> = [];
    const locks = new Map<string, Promise<void>>();
    let lockedReads = 0, activeTransactions = 0, peakTransactions = 0;

    const matches = (row: any, where: any): boolean => {
        if (!where) return true;
        if (typeof where.val === 'string') return where.val !== '1=0';
        return Reflect.ownKeys(where).every(key => {
            const expected = where[key];
            if (key === Op.and) return Array.isArray(expected) ? expected.every(part => matches(row, part)) : matches(row, expected);
            if (key === Op.or) return expected.some((part: any) => matches(row, part));
            if (typeof key !== 'string') throw new Error('Unsupported fixture predicate');
            const actual = row.get(key);
            if (expected && typeof expected === 'object') {
                if (Array.isArray(expected[Op.in])) return expected[Op.in].includes(actual);
                if (expected[Op.in]?.val) {
                    const selected = /"structureId" = '([^']+)'/.exec(expected[Op.in].val)?.[1];
                    assert.ok(selected, 'The fixture must evaluate the patient structure scope');
                    return patients.some(patient => patient.get('id') === actual && patient.get('structureId') === selected);
                }
                if (Object.hasOwn(expected, Op.ne)) return actual !== expected[Op.ne] && !(actual == null && expected[Op.ne] == null);
                if (Object.hasOwn(expected, Op.iLike)) return String(actual ?? '').toLowerCase().includes(expected[Op.iLike].replaceAll('%', '').toLowerCase());
                throw new Error('Unsupported fixture field predicate');
            }
            return expected == null ? actual == null : actual === expected;
        });
    };
    const install = (model: any, rows: any[]) => t.mock.method(model, 'schema', ((selectedSchema: string) => {
        const visible = selectedSchema === schema ? rows : [];
        const track = (method: string, options: any) => calls.push({model, schema: selectedSchema, method, options});
        return {
            findAll: async (options: any = {}) => {
                track('findAll', options);
                return visible.filter(row => matches(row, options.where)).map(row => options.raw ? row.get({plain: true}) : row);
            },
            findOne: async (options: any) => {
                track('findOne', options);
                if (model === Quote && options.transaction && options.lock === options.transaction.LOCK.UPDATE) {
                    const key = selectedSchema + ':' + options.where.id, previous = locks.get(key) ?? Promise.resolve();
                    let release!: () => void;
                    const held = new Promise<void>(resolve => {release = resolve;});
                    locks.set(key, previous.then(() => held));
                    await previous;
                    options.transaction.releases.push(release);
                    lockedReads++;
                }
                return visible.find(row => matches(row, options.where)) ?? null;
            },
            findAndCountAll: async (options: any) => {
                track('findAndCountAll', options);
                const found = visible.filter(row => matches(row, options.where));
                return {rows: found.slice(options.offset, options.offset + options.limit), count: found.length};
            },
            create: async (data: any, options: any) => {
                track('create', options);
                // Let simultaneous requests race unless the controller holds the quote lock.
                await new Promise<void>(resolve => setImmediate(resolve));
                const row = record({id: id(100 + rows.length), status: 'ACTIVE', templateId: null, ...data});
                rows.push(row); return row;
            }
        };
    }) as any);
    install(Quote, quotes); install(CarePackage, packages); install(Patient, patients);
    install(AgendaEvent, []); install(InvoicePayment, []);
    t.mock.method(sequelize, 'transaction', (async (work: any) => {
        const transaction = {LOCK: {UPDATE: 'UPDATE'}, releases: [] as Array<() => void>};
        activeTransactions++; peakTransactions = Math.max(peakTransactions, activeTransactions);
        try {return await work(transaction);}
        finally {activeTransactions--; transaction.releases.forEach(release => release());}
    }) as any);
    const addPackage = (changes: Record<string, any> = {}) => {
        const row = record({id: packageId, quoteId, structureId, patientId, templateId: null, name: 'Pacchetto precedente',
            status: 'ACTIVE', purchasedUnits: 4, remainingUnits: 4, totalPrice: 200, ...changes});
        packages.push(row); return row;
    };
    return {quote, quotes, packages, patients, calls, addPackage, stats: () => ({lockedReads, peakTransactions})};
}

function request(query: Record<string, any> = {}, permissions = ['quote:read:structure', 'quote:update:structure']): any {
    return {tenantSchema: schema, params: {id: quoteId}, body: {}, query,
        user: {tid: tenantId, sub: userId, sid: structureId, perms: permissions},
        access: {resource: 'quote', action: 'read', scope: 'structure', structureId, userId}};
}
function run(handler: any, req: any, middleware?: any): Promise<{status: number; data: any; message: string}> {
    return new Promise(resolve => {
        const res: any = {code: 200, status(code: number) {this.code = code; return this;},
            json(body: any) {resolve({status: this.code, data: body.data, message: body.message}); return this;}};
        const next = (error?: any) => error
            ? resolve({status: error.statusCode ?? 500, data: null, message: error.message})
            : handler(req, res, (failure: any) => resolve({status: failure.statusCode ?? 500, data: null, message: failure.message}));
        if (middleware) middleware(req, res, next); else next();
    });
}
const read = (req: any) => run(getQuote, req, requirePermission('quote', 'read'));
const create = (req: any) => run(controller.createPackageFromQuote, req, requirePermission('quote', 'update'));
const history = (req: any) => run(listCarePackages, req, requireAnyPermission(['care_package', 'read'], ['quote', 'read']));

it('returns an explicit null relationship before conversion without changing the quote list', async t => {
    fixture(t);
    const detail = await read(request());
    assert.equal(detail.status, 200); assert.equal(detail.data.linkedPackage, null);
    const list = await run(listQuotes, request());
    assert.equal(Object.hasOwn(list.data.items[0], 'linkedPackage'), false);
});

for (const status of ['ACTIVE', 'EXHAUSTED', 'VOID']) {
    it(`retains the persisted ${status} package relationship on every private detail reload`, async t => {
        const f = fixture(t); f.addPackage({status, notes: 'Internal package note'});
        for (let reload = 0; reload < 2; reload++) {
            const detail = await read(request());
            assert.equal(detail.status, 200);
            assert.deepEqual(detail.data.linkedPackage, {id: packageId, status});
        }
        assert.deepEqual(f.calls.find(call => call.model === CarePackage)!.options.attributes, ['id', 'status']);
    });
}

it('matches the quote relation to its tenant, structure, patient and historical package type', async t => {
    const f = fixture(t);
    f.addPackage({id: id(20), quoteId: id(99)});
    f.addPackage({id: id(21), structureId: id(99)});
    f.addPackage({id: id(22), patientId: id(99)});
    f.addPackage({id: id(23), templateId: id(99)});
    assert.equal((await read(request())).data.linkedPackage, null);
    f.addPackage();
    assert.deepEqual((await read(request())).data.linkedPackage, {id: packageId, status: 'ACTIVE'});
    assert.ok(f.calls.filter(call => call.model === CarePackage).every(call => call.schema === schema));
});

it('does not query packages for missing, out-of-scope or another tenant quote', async t => {
    const f = fixture(t); f.addPackage();
    const missing = request(); missing.params.id = id(90);
    assert.equal((await read(missing)).status, 404);
    const foreignTenant = request(); foreignTenant.tenantSchema = 'rehablo_other';
    assert.equal((await read(foreignTenant)).status, 404);
    f.quote.data.structureId = id(91);
    assert.equal((await read(request())).status, 404);
    assert.equal(f.calls.filter(call => call.model === CarePackage).length, 0);
});

it('rejects users lacking quote read before exposing a linked package', async t => {
    const f = fixture(t); f.addPackage();
    assert.equal((await read(request({}, ['care_package:read:tenant']))).status, 403);
    assert.equal(f.calls.length, 0);
});

it('creates once and reports a flat reused response on every repeated conversion', async t => {
    const f = fixture(t), first = await create(request());
    assert.equal(first.status, 201, first.message); assert.equal(first.data.reused, false);
    assert.equal(first.data.quoteId, quoteId); assert.equal(first.data.purchasedUnits, 4);
    assert.equal(first.message, 'Pacchetto creato dal preventivo');
    for (let retry = 0; retry < 3; retry++) {
        const reused = await create(request());
        assert.equal(reused.status, 200); assert.equal(reused.data.reused, true); assert.equal(reused.data.id, first.data.id);
        assert.equal(reused.message, 'Pacchetto già creato per questo preventivo');
    }
    assert.equal(f.packages.length, 1); assert.equal(f.stats().lockedReads, 4);
    assert.deepEqual((await read(request())).data.linkedPackage, {id: first.data.id, status: 'ACTIVE'});
});

it('serializes concurrent conversion retries by locking the quote and creates one record', async t => {
    const f = fixture(t);
    const results = await Promise.all(Array.from({length: 5}, () => create(request())));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 200, 200, 200, 201]);
    assert.equal(new Set(results.map(result => result.data.id)).size, 1);
    assert.equal(results.filter(result => result.data.reused === false).length, 1);
    assert.equal(f.packages.length, 1); assert.equal(f.stats().lockedReads, 5);
    assert.equal(f.stats().peakTransactions, 5, 'The fixture must not serialize entire transactions');
});

it('reuses an exhausted package and preserves existing conversion authorization', async t => {
    const f = fixture(t); f.addPackage({status: 'EXHAUSTED', remainingUnits: 0});
    const reused = await create(request());
    assert.equal(reused.status, 200); assert.equal(reused.data.reused, true); assert.equal(reused.data.status, 'EXHAUSTED');
    assert.equal((await create(request({}, ['quote:read:structure']))).status, 403);
    f.quote.data.structureId = id(99);
    assert.equal((await create(request())).status, 404);
    assert.equal(f.packages.length, 1);
});

it('filters the historical list by package ID for a quote-only user', async t => {
    const f = fixture(t); f.addPackage(); f.addPackage({id: id(30)});
    const result = await history(request({legacy: 'true', packageId}));
    assert.equal(result.status, 200, result.message); assert.equal(result.data.total, 1);
    assert.deepEqual(result.data.items.map((row: any) => row.id), [packageId]);
    assert.equal(result.data.items[0].balance, null, 'Unknown historical money must remain unknown');
    assert.equal(result.data.items[0].paidAmount, null); assert.equal(result.data.items[0].paymentStatus, null);
});

it('keeps package ID filtering additive to structure, patient, status and legacy scopes', async t => {
    const f = fixture(t), pack = f.addPackage();
    assert.equal((await history(request({legacy: 'true', packageId, patientId: id(90)}))).data.total, 0);
    assert.equal((await history(request({legacy: 'true', packageId, status: 'EXHAUSTED'}))).data.total, 0);
    pack.data.structureId = id(90);
    assert.equal((await history(request({legacy: 'true', packageId}))).data.total, 0);
    pack.data.structureId = structureId; f.patients[0].data.structureId = id(90);
    assert.equal((await history(request({legacy: 'true', packageId}))).data.total, 0);
    f.patients[0].data.structureId = structureId; pack.data.templateId = id(90);
    assert.equal((await history(request({legacy: 'true', packageId}))).data.total, 0);
    assert.equal((await history(request({legacy: 'true', packageId, structureId: id(90)}))).status, 403);
});

it('uses quote scope for historical lists even when package permission has a wider scope', async t => {
    const f = fixture(t); f.addPackage();
    const permissions = ['care_package:read:tenant', 'quote:read:structure'];
    f.patients[0].data.structureId = id(90);
    const result = await history(request({legacy: 'true', packageId}, permissions));
    assert.equal(result.status, 200); assert.equal(result.data.total, 0);
});

it('rejects malformed historical package IDs before querying records', async t => {
    const f = fixture(t);
    for (const invalid of ['', 'not-a-uuid', [packageId], {id: packageId}]) {
        const result = await history(request({legacy: 'true', packageId: invalid}));
        assert.equal(result.status, 400); assert.equal(result.message, 'Pacchetto non valido');
    }
    assert.equal(f.calls.length, 0);
});

it('does not let a historical deep link bypass permission for the new package list', async t => {
    fixture(t);
    assert.equal((await history(request({packageId}))).status, 403);
    assert.equal((await history(request({legacy: 'true', packageId}, ['care_package:read:tenant']))).status, 403);
});

it('does not change delivered quote snapshots or hashes when a private package link is added', async t => {
    const f = fixture(t), patient = f.patients[0].get({plain: true}), quote = f.quote.get({plain: true});
    const original = quoteDocument(quote, patient, {});
    const linked = quoteDocument({...quote, linkedPackage: {id: packageId, status: 'ACTIVE'}}, patient, {});
    assert.deepEqual(linked, original); assert.equal(documentHash(linked), documentHash(original));
    assert.equal(JSON.stringify(linked).includes(packageId), false);
});

it('normalizes quote customer totals and savings with added INPS without changing the tariff', () => {
    const payload: any = {lines: [{itemType: 'SERVICE', description: 'Sedute', quantity: 2, unitPrice: 50, baseUnitPrice: 100,
        vatNature: 'N4', socialSecurity: {fund: 'INPS_GS', mode: 'EXCLUDED', rate: 4}, appliesVat: true}]};
    assert.equal(normalizeQuoteLines(payload, true), null);
    assert.equal(payload.total, 104); assert.equal(payload.subtotal, 208);
    assert.equal(payload.lines[0].unitPrice, 50); assert.equal(payload.lines[0].contributionAmount, 4);
});
it('preserves legacy quote calculations without a frozen contribution agreement', () => {
    const payload: any = {lines: [{itemType: 'SERVICE', description: 'Sedute', quantity: 2, unitPrice: 50, baseUnitPrice: 100}]};
    assert.equal(normalizeQuoteLines(payload, true), null);
    assert.equal(payload.total, 100); assert.equal(payload.subtotal, 200);
});
