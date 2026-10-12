import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { sequelize } from '../../../config/database.js';
import { Structure, StructureAvailability } from '../models/index.js';
import { updateStructureForTenant } from './structure.controller.js';

function run(req: any): Promise<any> {
    return new Promise(resolve => {
        const res: any = {
            statusCode: 200,
            status(code: number) { this.statusCode = code; return this; },
            json(body: any) { resolve({ status: this.statusCode, body }); return this; }
        };
        updateStructureForTenant(req, res, (error: any) => resolve({ status: error.statusCode ?? 500, error }));
    });
}

function fixture(t: TestContext) {
    const transaction = { LOCK: { UPDATE: 'UPDATE' } };
    const structure: Record<string, any> = { id: 'structure-a', tenantId: 'tenant-a', name: 'Previous name' };
    const availability: Record<string, any> = {
        id: 'availability-a', structureId: 'structure-a', day: 1, enabled: true, open: '08:00', close: '18:00'
    };
    const match = (record: Record<string, any>, where: Record<string, any>) =>
        Object.entries(where).every(([key, value]) => record[key] === value);
    t.mock.method(sequelize, 'transaction', (async (callback: any) => callback(transaction)) as any);
    const parentUpdate = t.mock.method(Structure, 'update', (async (values: any, options: any) => {
        assert.equal(options.transaction, transaction);
        if (!match(structure, options.where)) return [0];
        Object.assign(structure, values);
        return [1];
    }) as any);
    const parentRead = t.mock.method(Structure, 'findOne', (async (options: any) => {
        assert.equal(options.transaction, transaction);
        return match(structure, options.where) ? { ...structure } : null;
    }) as any);
    const availabilityUpdate = t.mock.method(StructureAvailability, 'update', (async (values: any, options: any) => {
        assert.equal(options.transaction, transaction);
        if (!match(availability, options.where)) return [0];
        Object.assign(availability, values);
        return [1];
    }) as any);
    const availabilityCreate = t.mock.method(StructureAvailability, 'create', (async (values: any, options: any) => {
        assert.equal(options.transaction, transaction);
        return { ...values };
    }) as any);
    const req: any = { user: { id: 'user-a', tid: 'tenant-a', tenants: [{ id: 'tenant-a' }] },
        params: { structureId: 'structure-a' }, body: { premise: {} } };
    return { req, structure, availability, parentUpdate, parentRead, availabilityUpdate, availabilityCreate };
}

it('ignores foreign parent identities while preserving legitimate structure edits and tenant ownership', async t => {
    const { req, structure, parentUpdate } = fixture(t);
    const editable = { name: 'Updated name', address: 'Via Roma 1', city: 'Roma', province: 'RM',
        zipCode: '00100', region: '12', structureCode: 'STS-A', phone: '061234', phone2: null,
        email: 'office@example.invalid', defaultPriceListId: 'price-list-a' };
    req.body.premise = { id: 'structure-b', tenantId: 'tenant-b', createdAt: 'forged', updatedAt: 'forged', ...editable };
    const before = structuredClone(req.body);
    assert.equal((await run(req)).status, 200);
    assert.deepEqual(structure, { id: 'structure-a', tenantId: 'tenant-a', ...editable });
    assert.deepEqual(parentUpdate.mock.calls[0].arguments[0], editable);
    assert.deepEqual((parentUpdate.mock.calls[0].arguments[1] as any).where, { id: 'structure-a', tenantId: 'tenant-a' });
    assert.deepEqual(req.body, before);
});

it('uses availability id only for the scoped selector and cannot transfer an existing availability', async t => {
    const { req, availability, availabilityUpdate } = fixture(t);
    req.body.premise = { name: 'Updated name', premiseAvailabilities: [{ id: 'availability-a',
        structureId: 'structure-b', day: 2, enabled: false, open: '09:00', close: '17:00', createdAt: 'forged', updatedAt: 'forged' }] };
    assert.equal((await run(req)).status, 200);
    assert.deepEqual(availability, { id: 'availability-a', structureId: 'structure-a',
        day: 2, enabled: false, open: '09:00', close: '17:00' });
    assert.deepEqual(availabilityUpdate.mock.calls[0].arguments[0], { day: 2, enabled: false, open: '09:00', close: '17:00' });
    assert.deepEqual((availabilityUpdate.mock.calls[0].arguments[1] as any).where,
        { id: 'availability-a', structureId: 'structure-a' });
});

it('forces a new availability onto the scoped parent and supports availability-only updates', async t => {
    const { req, parentUpdate, parentRead, availabilityCreate } = fixture(t);
    req.body.premise = { id: 'structure-b', tenantId: 'tenant-b', premiseAvailabilities: [
        { structureId: 'structure-b', day: 3, enabled: true, open: '10:00', close: '15:00' }
    ] };
    assert.equal((await run(req)).status, 200);
    assert.equal(parentUpdate.mock.callCount(), 0);
    assert.equal((parentRead.mock.calls[0].arguments[0] as any).lock, 'UPDATE');
    assert.deepEqual(availabilityCreate.mock.calls[0].arguments[0],
        { structureId: 'structure-a', day: 3, enabled: true, open: '10:00', close: '15:00' });
});

it('cannot change a foreign availability by supplying its id under an owned parent', async t => {
    const { req, availability, availabilityUpdate } = fixture(t);
    const before = { ...availability };
    req.body.premise = { name: 'Updated name', premiseAvailabilities: [
        { id: 'foreign-availability', structureId: 'structure-b', enabled: false }
    ] };
    assert.equal((await run(req)).status, 200);
    assert.deepEqual(availability, before);
    assert.deepEqual((availabilityUpdate.mock.calls[0].arguments[1] as any).where,
        { id: 'foreign-availability', structureId: 'structure-a' });
});

for (const availabilityOnly of [false, true]) {
    it(`rejects a foreign route target before writing availability (availability-only=${availabilityOnly})`, async t => {
        const { req, structure, availabilityUpdate, availabilityCreate } = fixture(t);
        req.params.structureId = 'structure-b';
        req.body.premise = { ...(availabilityOnly ? {} : { name: 'Forged name' }),
            tenantId: 'tenant-b', premiseAvailabilities: [{ id: 'availability-a', enabled: false }] };
        assert.equal((await run(req)).status, 404);
        assert.equal(structure.name, 'Previous name');
        assert.equal(availabilityUpdate.mock.callCount(), 0);
        assert.equal(availabilityCreate.mock.callCount(), 0);
    });
}
