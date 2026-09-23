import assert from 'node:assert/strict';
import { it, TestContext } from 'node:test';
import { Request, Response, NextFunction } from 'express';
import { sequelize } from '../../../config/database.js';
import { PatientCredit } from '../models/administration.model.js';
import { PatientCreditMovement } from '../models/patientCreditMovement.model.js';
import { applyCredit, refundCredit } from './patientCredit.controller.js';

const creditId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const patientId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const structureId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003';

function legacyCredit() {
    const values: Record<string, unknown> = { id: creditId, patientId, structureId,
        amount: 80, remainingAmount: 80, status: 'ACTIVE', sourceType: 'ADVANCE', sourceId: null };
    return { get: (key: string) => values[key] };
}

async function run(handler: (req: Request, res: Response, next: NextFunction) => void, body: Record<string, unknown>) {
    const req: any = { tenantSchema: 'rehablo_test', params: { id: creditId }, body,
        access: { scope: 'tenant', userId: patientId },
        header: () => 'patient-credit-test-001' };
    return new Promise<number>(resolve => {
        const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; },
            json() { resolve(this.statusCode); return this; } };
        handler(req, res, (error?: any) => resolve(error?.statusCode ?? 500));
    });
}

function fixture(t: TestContext) {
    t.mock.method(sequelize, 'transaction', (async (callback: any) => callback({ LOCK: { UPDATE: 'UPDATE' } })) as any);
    t.mock.method(PatientCredit, 'schema', (() => ({ findByPk: async () => legacyCredit() })) as any);
    t.mock.method(PatientCreditMovement, 'schema', (() => ({ findOne: async () => null })) as any);
}

it('refuses to apply an unbacked legacy credit to an invoice', async t => {
    fixture(t);
    const status = await run(applyCredit, { amount: 20, targetType: 'INVOICE', targetId: patientId });
    assert.equal(status, 409);
});

it('refuses to refund an unbacked legacy credit', async t => {
    fixture(t);
    const status = await run(refundCredit, { amount: 20, accountId: patientId, paymentMethodId: structureId });
    assert.equal(status, 409);
});
