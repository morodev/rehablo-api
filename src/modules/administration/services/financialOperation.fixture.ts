import {TestContext} from 'node:test';
import {FinancialOperation} from '../models/financialOperation.model.js';
/** In-memory transaction fixtures must install this so no test touches a database. */
export function mockFinancialOperations(t: Pick<TestContext, 'mock'>, rows: any[] = []) {
    t.mock.method(FinancialOperation, 'schema', (() => ({
        findOne: async ({where}: any) => rows.find(row => row.idempotencyKey === where.idempotencyKey) ?? null,
        create: async (values: any) => {const row = {...values, get: (key: string) => values[key]}; rows.push(row); return row;}
    })) as any);
    return rows;
}
