import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {describe, it} from 'node:test';
import {
    itemAvailableInStructure,
    normalizeAvailabilityMode,
    normalizeStructureIds
} from './structureAvailability.service.js';

const require = createRequire(import.meta.url);
const migration = require('../../../../migrations/20260919-add-catalog-structure-availability.js');

describe('catalog structure availability', () => {
    it('normalizes modes and removes duplicate branch ids', () => {
        assert.equal(normalizeAvailabilityMode(undefined), 'ALL');
        assert.equal(normalizeAvailabilityMode('selected'), 'SELECTED');
        assert.deepEqual(normalizeStructureIds(['a', 'a', 'b']), ['a', 'b']);
        assert.throws(() => normalizeAvailabilityMode('invalid'), /Modalita/);
        assert.throws(() => normalizeStructureIds('a'), /elenco/);
    });

    it('treats legacy/all records as available and checks selected mappings', async () => {
        let lookups = 0;
        const mapping = {
            schema: () => ({
                findAll: async ({where}: any) => {
                    lookups++;
                    return where.structureId === 'branch-a' ? [{itemId: 'item-1'}] : [];
                }
            })
        } as any;
        assert.equal(await itemAvailableInStructure(
            {id: 'legacy'}, mapping, 'tenant', 'itemId', null
        ), true);
        assert.equal(lookups, 0);
        const selected = {id: 'item-1', availabilityMode: 'SELECTED'};
        assert.equal(await itemAvailableInStructure(selected, mapping, 'tenant', 'itemId', 'branch-a'), true);
        assert.equal(await itemAvailableInStructure(selected, mapping, 'tenant', 'itemId', 'branch-b'), false);
    });

    it('creates scoped mapping tables and migrates the old default to every existing branch', async () => {
        const queries: Array<{sql: string; replacements?: Record<string, unknown>}> = [];
        const schema = 'rehablo_00000000000040008000000000000001';
        await migration.up({sequelize: {query: async (sql: string, options: any) => {
            queries.push({sql, replacements: options?.replacements});
            return [[]];
        }}}, {schema, transaction: {id: 'transaction'}});
        const sql = queries.map(query => query.sql).join('\n');
        assert.match(sql, /ALTER TABLE .*"products" ADD COLUMN IF NOT EXISTS "availabilityMode"/);
        assert.match(sql, /CREATE TABLE IF NOT EXISTS .*"product_structures"/);
        assert.match(sql, /CREATE TABLE IF NOT EXISTS .*"service_structures"/);
        assert.match(sql, /CREATE TABLE IF NOT EXISTS .*"event_type_structures"/);
        assert.match(sql, /WHERE "isDefault" = true/);
        const seed = queries.find(query => query.sql.includes('CROSS JOIN public."structures"'));
        assert.equal(seed?.replacements?.tenantId, '00000000-0000-4000-8000-000000000001');
    });
});
