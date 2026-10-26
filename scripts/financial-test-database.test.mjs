import assert from 'node:assert/strict';
import {test} from 'node:test';
import {requireFinancialTestDatabase} from './financial-test-database.mjs';

test('financial integration guard requires an explicit local disposable database', () => {
    assert.throws(() => requireFinancialTestDatabase({DATABASE_URL: 'postgres://user:pass@localhost/rehablo'}), /TEST_FINANCIAL_DATABASE_URL is required/);
    for (const value of ['postgres://user:pass@localhost/rehablo', 'postgres://user:pass@remote.example/rehablo_financial_test',
        'https://localhost/rehablo_financial_test', 'postgres://localhost/rehablo_financial_test#fragment']) {
        assert.throws(() => requireFinancialTestDatabase({TEST_FINANCIAL_DATABASE_URL: value}));
    }
    assert.equal(requireFinancialTestDatabase({TEST_FINANCIAL_DATABASE_URL: 'postgres://localhost:5433/rehablo_financial_test'}).databaseName, 'rehablo_financial_test');
});

test('financial integration guard rejects the application endpoint even with different credentials or loopback alias', () => {
    assert.throws(() => requireFinancialTestDatabase({TEST_FINANCIAL_DATABASE_URL: 'postgres://test:test@127.0.0.1/rehablo_financial_test',
        DATABASE_URL: 'postgres://application:other@localhost:5432/rehablo_financial_test'}), /must differ/);
});
