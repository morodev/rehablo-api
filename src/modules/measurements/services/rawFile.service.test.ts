import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveRawFile } from './rawFile.service.js';
import RawFile from '../models/rawFile.model.js';
import { localStorageAdapter } from '../storage/localStorageAdapter.js';

const input = { tenantId: 'fixture', originalName: 'fixture.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b') };
const saved = { storagePath: 'fixture/file.csv', sizeBytes: 3, checksumSha256: 'fixture-hash' };

test('raw upload preserves metadata and stored content on success', async t => {
    t.mock.method(localStorageAdapter, 'save', async () => saved);
    const remove = t.mock.method(localStorageAdapter, 'remove', async () => {});
    t.mock.method(RawFile, 'schema', (() => ({ create: async (values: any) => values })) as any);
    const result = await saveRawFile('fixture', input);
    assert.equal(result.storagePath, saved.storagePath);
    assert.equal(result.checksumSha256, saved.checksumSha256);
    assert.equal(result.uploadedBy, null);
    assert.equal(remove.mock.callCount(), 0);
});

test('raw upload removes the saved file if metadata creation rejects', async t => {
    const error = new Error('metadata failed');
    t.mock.method(localStorageAdapter, 'save', async () => saved);
    const remove = t.mock.method(localStorageAdapter, 'remove', async () => {});
    t.mock.method(RawFile, 'schema', (() => ({ create: async () => { throw error; } })) as any);
    await assert.rejects(saveRawFile('fixture', input), thrown => thrown === error);
    assert.deepEqual(remove.mock.calls[0].arguments, [saved.storagePath]);
});

test('raw upload preserves the metadata error when compensation also fails', async t => {
    const error = new Error('metadata failed');
    t.mock.method(localStorageAdapter, 'save', async () => saved);
    t.mock.method(localStorageAdapter, 'remove', async () => { throw new Error('storage failed'); });
    const log = t.mock.method(console, 'error', () => {});
    t.mock.method(RawFile, 'schema', (() => ({ create: async () => { throw error; } })) as any);
    await assert.rejects(saveRawFile('fixture', input), thrown => thrown === error);
    assert.equal(log.mock.callCount(), 1);
    assert.doesNotMatch(String(log.mock.calls[0].arguments), /fixture\.csv|metadata failed|storage failed/);
});

test('raw upload does not write metadata or compensate when initial storage fails', async t => {
    const error = new Error('save failed');
    t.mock.method(localStorageAdapter, 'save', async () => { throw error; });
    const remove = t.mock.method(localStorageAdapter, 'remove', async () => {});
    const schema = t.mock.method(RawFile, 'schema', (() => { throw new Error('unexpected metadata access'); }) as any);
    await assert.rejects(saveRawFile('fixture', input), thrown => thrown === error);
    assert.equal(remove.mock.callCount(), 0);
    assert.equal(schema.mock.callCount(), 0);
});

