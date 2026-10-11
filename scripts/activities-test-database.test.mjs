import assert from 'node:assert/strict';
import {test} from 'node:test';
import {requireActivitiesTestDatabase} from './activities-test-database.mjs';

const testUrl = 'postgres://test_user:test_password@127.0.0.1:55432/rehablo_activities_test';

test('requires an explicit activities test database without falling back to DATABASE_URL', () => {
    assert.throws(() => requireActivitiesTestDatabase({DATABASE_URL: testUrl}), /TEST_ACTIVITIES_DATABASE_URL is required/);
});

test('accepts a clearly named PostgreSQL test database', () => {
    assert.deepEqual(requireActivitiesTestDatabase({TEST_ACTIVITIES_DATABASE_URL: testUrl}), {
        databaseUrl: testUrl, databaseName: 'rehablo_activities_test'
    });
    assert.equal(requireActivitiesTestDatabase({TEST_ACTIVITIES_DATABASE_URL: testUrl + '_run42'}).databaseName,
        'rehablo_activities_test_run42');
});

test('rejects ordinary databases, malformed URLs and non-PostgreSQL connections', () => {
    for (const value of ['invalid', 'sqlite:///rehablo_activities_test', testUrl.replace('rehablo_activities_test', 'rehablo'),
        testUrl.replace('rehablo_activities_test', 'postgres'), testUrl + '/other', testUrl + '#unsafe']) {
        assert.throws(() => requireActivitiesTestDatabase({TEST_ACTIVITIES_DATABASE_URL: value}));
    }
});

test('rejects the ordinary DATABASE_URL even when credentials or scheme spelling differ', () => {
    assert.throws(() => requireActivitiesTestDatabase({
        TEST_ACTIVITIES_DATABASE_URL: testUrl,
        DATABASE_URL: testUrl.replace('test_user:test_password', 'another_user:another_password').replace('postgres:', 'postgresql:')
    }), /must differ/);
    assert.throws(() => requireActivitiesTestDatabase({
        TEST_ACTIVITIES_DATABASE_URL: testUrl.replace(':55432', ''), DATABASE_URL: testUrl.replace(':55432', ':5432')
    }), /must differ/);
    assert.throws(() => requireActivitiesTestDatabase({
        TEST_ACTIVITIES_DATABASE_URL: testUrl, DATABASE_URL: testUrl.replace('127.0.0.1', 'localhost')
    }), /must differ/);
});

test('rejects malformed ordinary database configuration rather than guessing isolation', () => {
    assert.throws(() => requireActivitiesTestDatabase({TEST_ACTIVITIES_DATABASE_URL: testUrl, DATABASE_URL: 'invalid'}), /cannot confirm/);
});

test('guard errors never include a URL or its credentials', () => {
    let message = '';
    try {
        requireActivitiesTestDatabase({TEST_ACTIVITIES_DATABASE_URL: testUrl.replace('rehablo_activities_test', 'production')});
    } catch (error) {
        message = error.message;
    }
    assert.ok(message);
    assert.ok(!message.includes('test_password'));
    assert.ok(!message.includes('postgres://'));
});
