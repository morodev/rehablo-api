import assert from 'node:assert/strict';
import {after, beforeEach, describe, it} from 'node:test';
import EventType from '../../agenda/models/eventType.model.js';
import Patient from '../models/patient.model.js';
import {setDefaultEventType} from './patient.controller.js';

const patientId = '00000000-0000-4000-8000-000000000001';
const eventTypeId = '00000000-0000-4000-8000-000000000002';
const originalPatientSchema = Patient.schema;
const originalEventTypeSchema = EventType.schema;

let patientExists: boolean;
let eventTypeExists: boolean;
let eventTypeLookups: number;
let patientUpdates: number;
let patient: any;

function invoke(body: Record<string, unknown>): Promise<{status: number; payload: any}> {
    return new Promise((resolve, reject) => {
        const response = {status: 0, payload: null as any};
        const res: any = {
            status(code: number) {
                response.status = code;
                return res;
            },
            json(payload: any) {
                response.payload = payload;
                resolve(response);
                return res;
            }
        };
        const req: any = {
            tenantSchema: 'rehablo_00000000000040008000000000000001',
            params: {patientId},
            body,
            access: {resource: 'patient', action: 'update', scope: 'tenant', userId: 'user-1', structureId: null}
        };

        setDefaultEventType(req, res, reject);
    });
}

describe('patient default appointment type endpoint', {concurrency: false}, () => {
    beforeEach(() => {
        patientExists = true;
        eventTypeExists = true;
        eventTypeLookups = 0;
        patientUpdates = 0;
        patient = {
            id: patientId,
            defaultEventTypeId: null,
            async update(values: Record<string, unknown>) {
                patientUpdates++;
                Object.assign(patient, values);
            }
        };

        (Patient as any).schema = () => ({
            findOne: async () => patientExists ? patient : null
        });
        (EventType as any).schema = () => ({
            findByPk: async (id: string) => {
                eventTypeLookups++;
                return eventTypeExists && id === eventTypeId ? {id} : null;
            }
        });
    });

    after(() => {
        (Patient as any).schema = originalPatientSchema;
        (EventType as any).schema = originalEventTypeSchema;
    });

    it('assigns a valid tenant event type and returns the updated patient', async () => {
        const result = await invoke({eventTypeId});

        assert.equal(result.status, 200);
        assert.equal(result.payload.data.defaultEventTypeId, eventTypeId);
        assert.equal(patientUpdates, 1);
        assert.equal(eventTypeLookups, 1);
    });

    it('removes the preference without looking up an event type', async () => {
        patient.defaultEventTypeId = eventTypeId;
        const result = await invoke({eventTypeId: null});

        assert.equal(result.status, 200);
        assert.equal(result.payload.data.defaultEventTypeId, null);
        assert.equal(patientUpdates, 1);
        assert.equal(eventTypeLookups, 0);
    });

    it('rejects malformed, missing and unknown event types without updating the patient', async () => {
        assert.equal((await invoke({eventTypeId: 'invalid'})).status, 422);
        assert.equal((await invoke({})).status, 400);
        eventTypeExists = false;
        assert.equal((await invoke({eventTypeId})).status, 404);
        assert.equal(patientUpdates, 0);
    });

    it('does not expose or update a patient outside the authorized scope', async () => {
        patientExists = false;
        const result = await invoke({eventTypeId});

        assert.equal(result.status, 404);
        assert.equal(eventTypeLookups, 0);
        assert.equal(patientUpdates, 0);
    });
});
