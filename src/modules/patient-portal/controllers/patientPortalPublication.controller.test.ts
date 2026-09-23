import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Request, Response, NextFunction } from 'express';
import PatientSharedDocument from '../models/patientSharedDocument.model.js';
import { localStorageAdapter } from '../../measurements/storage/localStorageAdapter.js';
import { downloadDocument } from './patientPortalPublication.controller.js';

it('does not read a document belonging to another patient', async t => {
    const patientId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
    let fileReads = 0;
    t.mock.method(PatientSharedDocument, 'schema', (() => ({
        findOne: async ({ where }: any) => {
            assert.equal(where.patientId, patientId);
            return null;
        }
    })) as any);
    t.mock.method(localStorageAdapter, 'read', (async () => { fileReads++; throw new Error('File leaked'); }) as any);
    const req: any = { tenantSchema: 'rehablo_test', params: { id: 'another-document' }, user: { pid: patientId } };
    const status = await new Promise<number>(resolve => {
        const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; },
            json() { resolve(this.statusCode); return this; } };
        downloadDocument(req as Request, res as Response, ((error?: any) => resolve(error?.statusCode ?? 500)) as NextFunction);
    });
    assert.equal(status, 404);
    assert.equal(fileReads, 0);
});
