import assert from 'node:assert/strict';
import { it, TestContext } from 'node:test';
import { sequelize } from '../../../config/database.js';
import { Tenant } from '../../auth/models/index.js';
import { getFiscalSettings, updateFiscalSettings } from './fiscalSettings.controller.js';
import { updateDocumentSettings } from './administration.view.controller.js';

const run = (handler: any, body: any = {}) => new Promise<any>(resolve => {
    const res: any = { code: 200, status(code: number) { this.code = code; return this; }, json(value: any) { resolve({ code: this.code, ...value }); } };
    handler({ user: { tid: 'tenant' }, body }, res, (error: any) => resolve({ code: error.statusCode ?? 500, message: error.message }));
});
function fixture(t: TestContext) {
    const data: any = { administrationSettings: { documents: { invoicePrefix: 'OLD' }, unrelated: { keep: true }, fiscal: { retained: true } } };
    const locks: any[] = [];
    let tail = Promise.resolve();
    t.mock.method(sequelize, 'transaction', ((work: any) => {
        const next = tail.then(() => work({ LOCK: { UPDATE: 'UPDATE' } })); tail = next.then(() => undefined, () => undefined); return next;
    }) as any);
    t.mock.method(Tenant, 'findByPk', (async (_id: string, options: any) => {
        locks.push(options);
        return { get: (key: any) => typeof key === 'string' ? data[key] : data,
            update: async (values: any, options: any) => { assert.ok(options.transaction); Object.assign(data, values); } };
    }) as any);
    return { data, locks };
}
it('returns an unconfigured profile without assuming a profession', async t => {
    fixture(t);
    assert.deepEqual((await run(getFiscalSettings)).data, { stsIssuerType: null, stsDefaultExpenseTypeCode: null, codiceRegione: null });
});
it('normalizes physiotherapist SP under a tenant row lock and preserves other administration settings', async t => {
    const f = fixture(t);
    const result = await run(updateFiscalSettings, { stsIssuerType: 'PHYSIOTHERAPIST' });
    assert.equal(result.code, 200);
    assert.equal(result.data.stsDefaultExpenseTypeCode, 'SP');
    assert.equal(f.locks[0].lock, 'UPDATE');
    assert.equal(f.data.administrationSettings.documents.invoicePrefix, 'OLD');
    assert.equal(f.data.administrationSettings.unrelated.keep, true);
    assert.equal(f.data.administrationSettings.fiscal.retained, true);
});
it('changing to a structure clears a previous profession default until a compatible code is chosen', async t => {
    fixture(t);
    await run(updateFiscalSettings, { stsIssuerType: 'PHYSIOTHERAPIST' });
    const result = await run(updateFiscalSettings, { stsIssuerType: 'AUTHORIZED_STRUCTURE' });
    assert.equal(result.data.stsDefaultExpenseTypeCode, null);
});
it('rejects incompatible settings without touching the previous stored JSON', async t => {
    const f = fixture(t), before = structuredClone(f.data);
    const result = await run(updateFiscalSettings, { stsIssuerType: 'AUTHORIZED_STRUCTURE', stsDefaultExpenseTypeCode: 'SP' });
    assert.equal(result.code, 400);
    assert.deepEqual(f.data, before);
});
it('stores a zero-padded codice regione and rejects non-numeric values', async t => {
    const f = fixture(t);
    const ok = await run(updateFiscalSettings, { stsIssuerType: 'PHYSIOTHERAPIST', codiceRegione: '30' });
    assert.equal(ok.code, 200);
    assert.equal(ok.data.codiceRegione, '030');
    assert.equal(f.data.administrationSettings.fiscal.codiceRegione, '030');
    const bad = await run(updateFiscalSettings, { codiceRegione: 'AB' });
    assert.equal(bad.code, 400);
    assert.equal(f.data.administrationSettings.fiscal.codiceRegione, '030');
});
it('concurrent document and fiscal settings saves keep both values under the same tenant lock', async t => {
    const f = fixture(t);
    const results = await Promise.all([
        run(updateFiscalSettings, { stsIssuerType: 'AUTHORIZED_STRUCTURE', stsDefaultExpenseTypeCode: 'SR' }),
        run(updateDocumentSettings, { invoicePrefix: 'NEW' })
    ]);
    assert.ok(results.every(result => result.code === 200));
    assert.equal(f.data.administrationSettings.fiscal.stsDefaultExpenseTypeCode, 'SR');
    assert.equal(f.data.administrationSettings.documents.invoicePrefix, 'NEW');
    assert.ok(f.locks.every(options => options.lock === 'UPDATE' && options.transaction));
});
