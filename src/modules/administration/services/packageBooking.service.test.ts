import assert from 'node:assert/strict';
import {it, TestContext} from 'node:test';
import Service from '../../products-services/models/service.model.js';
import ServiceStructure from '../../products-services/models/serviceStructure.model.js';
import {packageBookingState, ensurePackageBooking, configurePackageBooking, changePackageBookingUnits} from './packageBooking.service.js';

const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const serviceA = id(1), serviceB = id(2), structureId = id(3), stamp = '2026-01-01T10:00:00.000Z';
const record = (values: any): any => ({...values, get(key: unknown) {if (typeof key === 'string') return this[key];
    const {get, update, writes, ...plain} = this; return plain;}, writes: [] as any[],
    async update(changes: any, options: any) {this.writes.push({changes, options}); Object.assign(this, changes); return this;}});
const pack = (extra: any = {}) => ({id: id(4), patientId: id(5), structureId, quoteId: id(6), templateId: null,
    name: 'Preventivo 8', purchasedUnits: 10, remainingUnits: 10, status: 'ACTIVE', updatedAt: stamp,
    lines: [{id: 'a', itemType: 'SERVICE', itemId: serviceA, description: 'Fisioterapia', quantity: 4},
        {id: 'b', itemType: 'SERVICE', itemId: serviceB, description: 'Tecar', quantity: 6}], ...extra});
const transaction = {LOCK: {UPDATE: 'UPDATE'}} as any;
const req: any = {tenantSchema: 'rehablo_test', user: {sub: id(9)}};
function serviceFixture(t: TestContext, available = [serviceA, serviceB]) {
    t.mock.method(ServiceStructure, 'schema', (() => ({findAll: async () => []})) as any);
    t.mock.method(Service, 'schema', (() => ({findAll: async () => available.map(serviceId => record({id: serviceId, name: serviceId === serviceA ? 'Fisioterapia' : 'Tecar'}))})) as any);
}
const setup = (extra: any = {}) => ({expectedRemainingUnits: 7, expectedUpdatedAt: stamp,
    lines: [{lineId: 'a', serviceId: serviceA}, {lineId: 'b', serviceId: serviceB}],
    remainingByService: [{serviceId: serviceA, remainingUnits: 3}, {serviceId: serviceB, remainingUnits: 4}], ...extra});

it('derives a single-service partially used package and aggregates repeated service rows without modifying it', () => {
    const source = pack({remainingUnits: 7, lines: [{itemType: 'SERVICE', itemId: serviceA, description: 'Fisio', quantity: 4},
        {itemType: 'PRODUCT', itemId: serviceB, quantity: 100}, {itemType: 'SERVICE', itemId: serviceA, description: 'Fisio', quantity: 6}]});
    const before = JSON.stringify(source), state = packageBookingState(source);
    assert.equal(state.status, 'READY'); assert.equal(state.services.length, 1);
    assert.equal(state.services[0].purchasedUnits, 10); assert.equal(state.services[0].remainingUnits, 7);
    assert.equal(JSON.stringify(source), before);
});

it('preserves the individual service quantities of an unused multiple-service quote', () => {
    const state = packageBookingState(pack()); assert.equal(state.status, 'READY');
    assert.deepEqual(state.services.map(service => [service.serviceId, service.remainingUnits]), [[serviceA, 4], [serviceB, 6]]);
});

it('does not guess the consumed service or match descriptions when the previous data is incomplete', () => {
    const used = packageBookingState(pack({remainingUnits: 7}));
    assert.equal(used.status, 'NEEDS_SETUP'); assert.equal(used.unallocatedConsumedUnits, 3); assert.deepEqual(used.services, []);
    const noId = packageBookingState(pack({lines: [{itemType: 'SERVICE', description: 'Tecar', quantity: 10}]}));
    assert.equal(noId.status, 'NEEDS_SETUP'); assert.equal(noId.setupLines[0].serviceId, null);
    for (const extra of [{remainingUnits: 11}, {purchasedUnits: 10.5}, {lines: [{itemType: 'SERVICE', itemId: serviceA, quantity: 5}]}]) {
        assert.equal(packageBookingState(pack(extra)).status, 'NEEDS_SETUP');
    }
});

it('activates an unambiguous package once under the caller transaction while preserving unrelated snapshot fields', async () => {
    const model = record(pack({purchaseSnapshot: {socialSecurity: {mode: 'INCLUDED'}}}));
    await ensurePackageBooking(model, transaction, id(9)); await ensurePackageBooking(model, transaction, id(9));
    assert.equal(model.writes.length, 1); assert.equal(model.writes[0].options.transaction, transaction);
    assert.equal(model.purchaseSnapshot.socialSecurity.mode, 'INCLUDED'); assert.equal(model.purchaseSnapshot.booking.automatic, true);
    assert.equal(model.remainingUnits, 10); assert.equal(model.purchaseSnapshot.booking.services[1].remainingUnits, 6);
    const ambiguous = record(pack({remainingUnits: 7})); await ensurePackageBooking(ambiguous, transaction);
    assert.equal(ambiguous.writes.length, 0);
    const catalog = record(pack({templateId: id(10), serviceId: serviceA})); await ensurePackageBooking(catalog, transaction);
    assert.equal(catalog.writes.length, 0);
});

it('configures the missing clinical distribution without changing money or the aggregate residual and records an audit', async t => {
    serviceFixture(t); const model = record(pack({remainingUnits: 7, totalPrice: 300}));
    const result = await configurePackageBooking(req, model, setup(), transaction);
    assert.equal(result.status, 'READY'); assert.equal(model.remainingUnits, 7); assert.equal(model.totalPrice, 300);
    assert.deepEqual(result.services.map(service => service.remainingUnits), [3, 4]);
    assert.equal(model.purchaseSnapshot.bookingAudit.length, 1); assert.equal(model.purchaseSnapshot.bookingAudit[0].byUserId, id(9));
    assert.equal(model.writes[0].options.transaction, transaction);
    await assert.rejects(() => configurePackageBooking(req, model, setup(), transaction), /già definite/);
});

it('rejects concurrent changes to the residual or the package timestamp before persisting setup', async t => {
    serviceFixture(t); const model = record(pack({remainingUnits: 7}));
    for (const input of [setup({expectedRemainingUnits: 8}), setup({expectedUpdatedAt: '2026-01-02T10:00:00Z'}), setup({expectedUpdatedAt: ''})]) {
        await assert.rejects(() => configurePackageBooking(req, model, input, transaction), /cambiato/);
    }
    assert.equal(model.writes.length, 0);
});

it('rejects invalid, duplicated, unavailable and overdrawn service mappings without modifying the package', async t => {
    serviceFixture(t); const model = record(pack({remainingUnits: 7}));
    for (const input of [setup({lines: [{lineId: 'a', serviceId: serviceA}, {lineId: 'a', serviceId: serviceB}]}),
        setup({lines: [{lineId: 'a', serviceId: 'invalid'}, {lineId: 'b', serviceId: serviceB}]}),
        setup({remainingByService: [{serviceId: serviceA, remainingUnits: 4}, {serviceId: serviceB, remainingUnits: 4}]}),
        setup({remainingByService: [{serviceId: serviceA, remainingUnits: 5}, {serviceId: serviceB, remainingUnits: 2}]})]) {
        await assert.rejects(() => configurePackageBooking(req, model, input, transaction));
    }
    serviceFixture(t, [serviceA]);
    await assert.rejects(() => configurePackageBooking(req, model, setup(), transaction), /non è disponibile/);
    assert.equal(model.writes.length, 0);
});

it('changes only the frozen service counter and restores it on reversal without modifying the purchase agreement', async () => {
    const model = record(pack()); await ensurePackageBooking(model, transaction);
    await changePackageBookingUnits(model, serviceA, -1, transaction);
    assert.equal(model.remainingUnits, 9); assert.deepEqual(packageBookingState(model.get({plain: true})).services.map(row => row.remainingUnits), [3, 6]);
    await changePackageBookingUnits(model, serviceA, 1, transaction);
    assert.equal(model.remainingUnits, 10); assert.equal(model.lines[0].quantity, 4);
    await assert.rejects(() => changePackageBookingUnits(model, serviceA, 1, transaction), /insufficienti/);
});

it('refuses a corrupted frozen snapshot instead of rebuilding its counters from current quote lines', async () => {
    const model = record(pack()); await ensurePackageBooking(model, transaction);
    model.purchaseSnapshot.booking.services[0].remainingUnits = 1;
    assert.equal(packageBookingState(model.get({plain: true})).status, 'NEEDS_SETUP');
    await assert.rejects(() => changePackageBookingUnits(model, serviceB, -1, transaction), /quantità/);
    assert.equal(model.remainingUnits, 10);
});
