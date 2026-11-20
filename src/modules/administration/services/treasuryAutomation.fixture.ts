import type {TestContext} from 'node:test';
import {Op} from 'sequelize';
import {TreasuryCategory, TreasuryCategoryDefault, TreasuryCategorySnapshot, TreasuryClassification, TreasuryMovementTag, TreasuryTag} from '../models/treasuryClassification.model.js';

type Row = Record<string, any>;
/** In-memory metadata tables for financial tests; real resolver and permission checks still run. */
export function mockTreasuryAutomation(t: TestContext) {
    const categories: Row[] = [], defaults: Row[] = [], snapshots: Row[] = [], classifications: Row[] = [], tags: Row[] = [], links: Row[] = [];
    const tables = [categories, defaults, snapshots, classifications, tags, links];
    const matches = (row: Row, where: Row = {}) => Reflect.ownKeys(where).every(key => {
        const expected = where[key as string];
        return expected && typeof expected === 'object' && Op.in in expected ? expected[Op.in].includes(row[key as string]) : row[key as string] === expected;
    });
    const model = (row: Row): any => ({get: (key: any) => typeof key === 'string' ? row[key] : {...row},
        update: async (changes: Row) => {Object.assign(row, changes); return model(row);}});
    for (const [entity, rows, primary] of [[TreasuryCategory, categories, 'id'], [TreasuryCategoryDefault, defaults, 'sourceId'],
        [TreasuryCategorySnapshot, snapshots, 'sourceId'], [TreasuryClassification, classifications, 'movementId'],
        [TreasuryTag, tags, 'id'], [TreasuryMovementTag, links, 'movementId']] as const) {
        const create = async (value: Row) => {const row = structuredClone(value); rows.push(row); return model(row);};
        t.mock.method(entity, 'schema', (() => ({
            findByPk: async (id: string) => {const row = rows.find(row => row[primary] === id); return row ? model(row) : null;},
            findOne: async ({where}: any = {}) => {const row = rows.find(row => matches(row, where)); return row ? model(row) : null;},
            findAll: async ({where}: any = {}) => rows.filter(row => matches(row, where)).map(model),
            count: async ({where}: any = {}) => rows.filter(row => matches(row, where)).length,
            create, bulkCreate: async (values: Row[]) => Promise.all(values.map(create)),
            destroy: async ({where}: any) => {const selected = rows.filter(row => matches(row, where)); selected.forEach(row => rows.splice(rows.indexOf(row), 1)); return selected.length;},
            upsert: async (value: Row) => {const row = rows.find(row => row.sourceKind === value.sourceKind && row.sourceId === value.sourceId); if (row) Object.assign(row, value); else rows.push({...value});},
        })) as any);
    }
    return {categories, defaults, snapshots, classifications, tags, links, tables};
}
