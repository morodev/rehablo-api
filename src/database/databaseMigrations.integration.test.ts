import assert from 'node:assert/strict';
import {test} from 'node:test';
import {requireMigrationsTestDatabase} from '../../scripts/test-database-migrations-integration.mjs';

test('migration database guard requires an explicit isolated local database', () => {
    assert.throws(() => requireMigrationsTestDatabase({DATABASE_URL: 'postgres://localhost/rehablo'}), /TEST_MIGRATIONS_DATABASE_URL is required/);
    for (const value of ['postgres://localhost/rehablo', 'postgres://remote.example/rehablo_migrations_test',
        'https://localhost/rehablo_migrations_test', 'postgres://localhost/rehablo_migrations_test#fragment']) {
        assert.throws(() => requireMigrationsTestDatabase({TEST_MIGRATIONS_DATABASE_URL: value}));
    }
    assert.equal(requireMigrationsTestDatabase({TEST_MIGRATIONS_DATABASE_URL: 'postgres://localhost:5433/rehablo_migrations_test_run'}).databaseName,
        'rehablo_migrations_test_run');
    assert.throws(() => requireMigrationsTestDatabase({
        TEST_MIGRATIONS_DATABASE_URL: 'postgres://fixture:one@127.0.0.1/rehablo_migrations_test',
        DATABASE_URL: 'postgres://application:two@localhost:5432/rehablo_migrations_test'
    }), /must differ/);
});
