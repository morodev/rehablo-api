import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {it} from 'node:test';
import {PACKAGE_BOOKING_SERVICES_VERSION, requiredTenantSchemaVersions} from './tenantMigrations.js';
const require = createRequire(import.meta.url);
const migration = require('../../migrations/20261025-package-booking-services.js');

it('registers an additive booking-service rollout without guessing consumption attribution or money', async () => {
    const calls: string[] = [], transaction = {id: 'transaction'};
    await migration.up({sequelize: {query: async (sql: string, options: any) => {
        calls.push(sql); assert.equal(options.transaction, transaction);
    }}}, {schema: 'rehablo_11111111111141118111111111111111', transaction});
    assert.equal(calls.length, 3); assert.ok(calls.every(sql => /^(ALTER|CREATE)\s/.test(sql) && sql.includes('IF NOT EXISTS')));
    assert.ok(calls.some(sql => sql.includes('"carePackageServiceId" UUID NULL')));
    assert.ok(calls.some(sql => sql.includes('"serviceId" UUID NULL')));
    assert.ok(requiredTenantSchemaVersions().includes(PACKAGE_BOOKING_SERVICES_VERSION));
});

it('rejects an invalid tenant schema before any booking migration query', async () => {
    await assert.rejects(() => migration.up({sequelize: {query: () => assert.fail('Must not query')}}, {schema: 'public'}), /Invalid tenant schema/);
});
