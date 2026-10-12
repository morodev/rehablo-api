import assert from 'node:assert/strict';
import {it} from 'node:test';
import {sequelize} from '../../../config/database.js';
import {mirrorInvoicePaymentToTreasury} from './invoicePaymentTreasury.service.js';

it('mirrors cash using the validated site and its default account when a legacy invoice has no site column', async t => {
    const structureId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const accountId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const transaction = {} as any;
    const queries: Array<{sql: string; options: any}> = [];
    t.mock.method(sequelize, 'query', (async (sql: string, options: any) => {
        queries.push({sql, options});
        assert.equal(options.transaction, transaction);
        if (sql.includes('financial_accounts')) {
            assert.equal(options.replacements.structureId, structureId);
            return [[{id: accountId}], {}];
        }
        assert.match(sql, /INSERT INTO .*treasury_movements/);
        return [[], {}];
    }) as any);
    await mirrorInvoicePaymentToTreasury('rehablo_0123456789abcdef0123456789abcdef', {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        invoiceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', amount: 40, paidAt: '2026-09-01'
    }, transaction, {structureId, paymentMethodId: null, idempotencyKey: 'settlement_receipt'});
    assert.equal(queries.length, 2);
    assert.equal(queries[1].options.replacements.structureId, structureId);
    assert.equal(queries[1].options.replacements.accountId, accountId);
    assert.equal(queries[1].options.replacements.idempotencyKey, 'settlement_receipt');
    assert.equal(queries[1].options.replacements.amount, 40);
    assert.match(queries[1].sql, /ON CONFLICT .* DO NOTHING/);
});
