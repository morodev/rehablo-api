import assert from 'node:assert/strict';
import {after, beforeEach, describe, it} from 'node:test';
import {Structure, StructureUser} from '../../auth/models/index.js';
import EventType from '../../agenda/models/eventType.model.js';
import EventTypeStructure from '../../agenda/models/eventTypeStructure.model.js';
import Patient from '../models/patient.model.js';
import {savePatient, update, setDefaultEventType} from './patient.controller.js';

const patientId = '00000000-0000-4000-8000-000000000001';
const eventTypeId = '00000000-0000-4000-8000-000000000002';
const structureId = '00000000-0000-4000-8000-000000000003';
const schema = 'rehablo_test';
const originals = {patient: Patient.schema, eventType: EventType.schema, mappings: EventTypeStructure.schema,
    structure: Structure.findOne, assignment: StructureUser.findOne};
let writes: Record<string, unknown>[];
let patient: any;
let patientExists: boolean;
let eventTypeExists: boolean;
let restricted: boolean;
let available: boolean;
let lookups: number;
let mappings: any[];

function invoke(handler: any, body: any) {
    return new Promise<{status: number; payload: any}>((resolve, reject) => {
        const result = {status: 0, payload: null as any};
        const res: any = {status(code: number) {result.status = code; return res;},
            json(payload: any) {result.payload = payload; resolve(result); return res;}};
        handler({tenantSchema: schema, params: {patientId}, body,
            user: {id: 'user-1', tenants: [{id: 'tenant-1'}]},
            access: {resource: 'patient', action: 'update', scope: 'structure', userId: 'user-1', structureId}}, res, reject);
    });
}

describe('patient preference saved with anagraphic data', {concurrency: false}, () => {
    beforeEach(() => {
        writes = []; lookups = 0; mappings = [];
        patientExists = eventTypeExists = available = true; restricted = false;
        patient = {id: patientId, structureId, name: 'Mario', defaultEventTypeId: eventTypeId,
            get(key: string) {return this[key];},
            async update(payload: any) {writes.push(payload); Object.assign(this, payload);}};
        (Patient as any).schema = (tenant: string) => {
            assert.equal(tenant, schema);
            return {findOne: async () => patientExists ? patient : null,
                create: async (payload: any) => {writes.push(payload); return {...patient, defaultEventTypeId: null, ...payload};},
                update: async (payload: any) => {writes.push(payload); Object.assign(patient, payload); return [1];}};
        };
        (EventType as any).schema = (tenant: string) => {
            assert.equal(tenant, schema);
            return {findByPk: async (id: string) => {
                lookups++;
                return eventTypeExists && id === eventTypeId ? {id, availabilityMode: restricted ? 'SELECTED' : 'ALL'} : null;
            }};
        };
        (EventTypeStructure as any).schema = () => ({findAll: async (query: any) => {
            mappings.push(query.where);
            return available ? [{eventTypeId, structureId}] : [];
        }});
        (Structure as any).findOne = async () => ({id: structureId});
        (StructureUser as any).findOne = async () => ({structureId});
    });

    after(() => {
        (Patient as any).schema = originals.patient;
        (EventType as any).schema = originals.eventType;
        (EventTypeStructure as any).schema = originals.mappings;
        (Structure as any).findOne = originals.structure;
        (StructureUser as any).findOne = originals.assignment;
    });

    it('creates patient and preference in one write', async () => {
        const result = await invoke(savePatient, {name: 'Mario', surname: 'Rossi', privacyConsent: true, defaultEventTypeId: eventTypeId});
        assert.equal(result.status, 201);
        assert.equal(result.payload.data.defaultEventTypeId, eventTypeId);
        assert.equal(writes.length, 1);
        assert.equal(writes[0].structureId, structureId);
    });

    it('creates with null or omitted preference', async () => {
        for (const preference of [{defaultEventTypeId: null}, {}]) {
            const result = await invoke(savePatient, {name: 'Mario', privacyConsent: true, ...preference});
            assert.equal(result.status, 201);
            assert.equal(result.payload.data.defaultEventTypeId, null);
        }
        assert.equal(lookups, 0);
    });

    it('updates and clears the explicit preference with the other data', async () => {
        for (const preference of [eventTypeId, null]) {
            const result = await invoke(update, {contact: {name: 'Luigi'}, defaultEventTypeId: preference});
            assert.equal(result.status, 200);
            assert.equal(result.payload.data.defaultEventTypeId, preference);
            assert.equal(result.payload.data.name, 'Luigi');
        }
        assert.equal(writes.length, 2);
    });

    it('ignores the preference in old contact payloads and preserves a newer row choice', async () => {
        const result = await invoke(update, {contact: {name: 'Luigi', defaultEventTypeId: null}});
        assert.equal(result.status, 200);
        assert.equal(result.payload.data.defaultEventTypeId, eventTypeId);
        assert.equal(Object.hasOwn(writes[0], 'defaultEventTypeId'), false);
        assert.equal(lookups, 0);
    });

    it('ignores the preference in legacy unwrapped PUT payloads', async () => {
        const result = await invoke(update, {name: 'Luigi', defaultEventTypeId: null});
        assert.equal(result.status, 200);
        assert.equal(result.payload.data.defaultEventTypeId, eventTypeId);
        assert.equal(Object.hasOwn(writes[0], 'defaultEventTypeId'), false);
        assert.equal(lookups, 0);
    });

    it('accepts an update containing only an explicit preference', async () => {
        const result = await invoke(update, {contact: {}, defaultEventTypeId: null});
        assert.equal(result.status, 200);
        assert.equal(result.payload.data.defaultEventTypeId, null);
    });

    for (const handler of [savePatient, update]) {
        it(`rejects malformed and missing tenant types before any ${handler === savePatient ? 'creation' : 'update'}`, async () => {
            const body = handler === savePatient ? {name: 'Mario', privacyConsent: true} : {contact: {name: 'Luigi'}};
            assert.equal((await invoke(handler, {...body, defaultEventTypeId: 'invalid'})).status, 422);
            eventTypeExists = false;
            assert.equal((await invoke(handler, {...body, defaultEventTypeId: eventTypeId})).status, 404);
            assert.equal(writes.length, 0);
        });
    }

    it('checks structure availability for POST, PUT and the existing PATCH', async () => {
        restricted = true; available = false;
        assert.equal((await invoke(savePatient, {name: 'Mario', privacyConsent: true, defaultEventTypeId: eventTypeId})).status, 409);
        assert.equal((await invoke(update, {contact: {name: 'Luigi'}, defaultEventTypeId: eventTypeId})).status, 409);
        assert.equal((await invoke(setDefaultEventType, {eventTypeId})).status, 409);
        assert.equal(writes.length, 0);
        assert.equal(mappings.length, 3);
        for (const where of mappings) assert.deepEqual(where, {eventTypeId, structureId});
    });

    it('does not look up types or write an out-of-scope patient', async () => {
        patientExists = false;
        assert.equal((await invoke(update, {contact: {name: 'Luigi'}, defaultEventTypeId: eventTypeId})).status, 404);
        assert.equal(writes.length, 0);
        assert.equal(lookups, 0);
    });
});
