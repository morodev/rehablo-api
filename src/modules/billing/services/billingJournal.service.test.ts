import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryTypes, Sequelize } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { billingJournal } from './billingJournal.service.js';

test('durable progress uses an independent bounded pool and bound values', async t => {
    const progress = { invoiceId: "invoice_'_value", users: 2 };
    let called = false;
    t.mock.method(Sequelize.prototype, 'query', async function (this: Sequelize & { options: { pool: { max: number } } }, sql: string, options: any) {
        called = true;
        assert.notEqual(this, sequelize);
        assert.equal(this.options.pool && this.options.pool.max, 1);
        assert.equal(options.type, QueryTypes.UPDATE);
        assert.deepEqual(options.bind, [JSON.stringify(progress), 'operation-a', 'tenant-a']);
        assert.equal(sql.includes(progress.invoiceId), false);
        assert.equal(sql.includes('"billing_operations"'), true);
        assert.equal(sql.includes('"tenants"'), false);
        return [undefined, 1];
    });
    await billingJournal.saveProgress({ id: 'operation-a', tenantId: 'tenant-a', progress });
    assert.equal(called, true);
});

test('missing processing ledger row prevents proceeding with a payment', async t => {
    t.mock.method(Sequelize.prototype, 'query', async () => [undefined, 0]);
    await assert.rejects(billingJournal.saveProgress({ id: 'missing', tenantId: 'tenant-a', progress: {} }), /Impossibile salvare/);
});
