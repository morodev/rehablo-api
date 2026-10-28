import assert from 'node:assert/strict';
import test from 'node:test';
import type {Sequelize, Transaction} from 'sequelize';
import {type DatabaseManifest, validateManifest} from './migrationTypes.js';
import {assertProvisioningRelease, assertTenantReady, withReleaseLock} from './releaseControl.js';
import {getDatabaseStatus, migrateDatabase} from './releaseRunner.js';

const manifest: DatabaseManifest = {id: 'release-one', checksum: 'release-one-checksum', publicMigrations: [], tenantMigrations: []};

function lockingDatabase(query: (sql: string, options?: any) => Promise<any>) {
    const events: string[] = [];
    const connection = {query: async (sql: string) => {events.push(sql); return {rows: [{locked: true}]};}};
    const database = {
        query,
        connectionManager: {
            getConnection: async () => {events.push('acquire'); return connection;},
            releaseConnection: async (actual: any) => {assert.equal(actual, connection); events.push('release');},
            destroyConnection: async (actual: any) => {assert.equal(actual, connection); events.push('destroy');}
        }
    } as unknown as Sequelize;
    return {database, events, connection};
}

test('release lock remains on its reserved physical connection and unlocks when work fails', async () => {
    const {database, events} = lockingDatabase(async () => {throw new Error('unexpected pooled query');});
    const failure = new Error('work failed');
    await assert.rejects(withReleaseLock(database, async () => {events.push('work'); throw failure;}), error => error === failure);
    assert.deepEqual(events, ['acquire', 'SELECT pg_try_advisory_lock($1, $2) AS locked',
        'work', 'SELECT pg_advisory_unlock($1, $2)', 'release']);
});

test('a physical connection whose unlock failed is destroyed rather than returned to pool', async () => {
    const {database, events, connection} = lockingDatabase(async () => [[]]);
    const original = connection.query;
    connection.query = async sql => {
        const result = await original(sql);
        if (sql.includes('unlock')) throw new Error('connection lost on unlock');
        return result;
    };
    await assert.rejects(withReleaseLock(database, async () => undefined), /connection lost/);
    assert.equal(events.at(-1), 'destroy');
    assert.equal(events.includes('release'), false);
});

test('an occupied release lock times out with its phase identified and without entering migration work', async () => {
    const {database, events, connection} = lockingDatabase(async () => {throw new Error('No pooled queries expected');});
    connection.query = async sql => {events.push(sql); return {rows: [{locked: false}]};};
    const notices: number[] = [];
    await assert.rejects(withReleaseLock(database, async () => {assert.fail('Occupied lock must not run migrations');},
        'exclusive', 30, duration => notices.push(duration)), /release lock timeout.*exclusive advisory lock.*1380270671, 18700/);
    assert.equal(notices.length, 1);
    assert.equal(events.at(-1), 'release');
    assert.ok(events.filter(sql => sql.startsWith('SELECT')).every(sql => sql.includes('pg_try_advisory_lock')));
});

test('an uncertain release lock acquisition destroys its physical connection', async () => {
    const {database, events, connection} = lockingDatabase(async () => [[]]);
    connection.query = async () => {throw new Error('connection lost during acquisition');};
    await assert.rejects(withReleaseLock(database, async () => {assert.fail('Work must not run');}), /connection lost during acquisition/);
    assert.equal(events.at(-1), 'destroy');
    assert.equal(events.includes('release'), false);
});

test('shared session coordination uses a nonblocking shared lock and matching unlock', async () => {
    const {database, events} = lockingDatabase(async () => [[]]);
    await withReleaseLock(database, async () => {events.push('work');}, 'shared');
    assert.deepEqual(events, ['acquire', 'SELECT pg_try_advisory_lock_shared($1, $2) AS locked',
        'work', 'SELECT pg_advisory_unlock_shared($1, $2)', 'release']);
});

test('completed database releases take a constant read-only no-op path even with a newer target', async () => {
    const statements: string[] = [];
    const {database} = lockingDatabase(async sql => {
        statements.push(sql);
        if (sql.includes('to_regclass')) return [[{control: 'schema_control', releases: 'schema_releases', tenants: 'tenant_schema_state'}]];
        if (sql.includes('FROM public.schema_control c LEFT JOIN')) return [[{releaseId: 'release-two', checksum: manifest.checksum}]];
        throw new Error('No-op must not execute tenant scans, DDL or migration queries');
    });
    database.transaction = (async () => {throw new Error('No-op must not start a transaction');}) as any;
    assert.deepEqual(await migrateDatabase(manifest, {database}), {release: manifest.id, noop: true, tenants: 0, migrations: 0});
    assert.equal(statements.length, 2);
});

test('read-only status reports uninitialized schema without creating control metadata', async () => {
    const {database} = lockingDatabase(async sql => {
        assert.ok(sql.startsWith('SELECT to_regclass'));
        return [[{control: null, releases: null, tenants: null}]];
    });
    assert.deepEqual(await getDatabaseStatus(manifest, database), {ready: false, currentRelease: null, release: manifest.id});
});

test('startup reconciliation of a ready release uses only reads when all tenants are ready', async () => {
    const statements: string[] = [];
    const {database} = lockingDatabase(async sql => {
        statements.push(sql);
        if (sql.includes('to_regclass')) return [[{control: 'yes', releases: 'yes', tenants: 'yes'}]];
        if (sql.includes('FROM public.schema_control c LEFT JOIN')) return [[{releaseId: manifest.id, checksum: manifest.checksum}]];
        if (sql.includes('FROM public.tenants') && sql.includes('LIMIT 1')) return [[]];
        throw new Error('Ready startup must not execute migrations');
    });
    database.transaction = (async () => {throw new Error('Ready startup must not start a transaction');}) as any;
    assert.equal((await migrateDatabase(manifest, {database, reconcileMissingTenants: true})).noop, true);
    assert.equal(statements.length, 3);
    assert.ok(statements.every(sql => sql.startsWith('SELECT')));
});

test('startup of a previously completed compatible version cannot reconcile a newer release backwards', async () => {
    const {database} = lockingDatabase(async sql => {
        if (sql.includes('to_regclass')) return [[{control: 'yes', releases: 'yes', tenants: 'yes'}]];
        if (sql.includes('FROM public.schema_control c LEFT JOIN')) return [[{releaseId: 'newer-release', checksum: manifest.checksum}]];
        throw new Error('An older version must not enumerate or migrate newer tenants');
    });
    database.transaction = (async () => {throw new Error('Older startup must not start a transaction');}) as any;
    assert.equal((await migrateDatabase(manifest, {database, reconcileMissingTenants: true})).noop, true);
});

test('same release ID with changed content fails before starting migrations', async () => {
    const {database} = lockingDatabase(async sql => sql.includes('to_regclass')
        ? [[{control: 'yes', releases: 'yes', tenants: 'yes'}]]
        : [[{releaseId: manifest.id, checksum: 'tampered-checksum'}]]);
    await assert.rejects(migrateDatabase(manifest, {database}), /checksum mismatch/);
});

test('previous API cannot provision an older schema after the database target advances', async () => {
    const {database} = lockingDatabase(async () => [[{releaseId: 'release-two', checksum: 'two', releaseChecksum: 'two'}]]);
    await assert.rejects(assertProvisioningRelease(manifest, database, {} as Transaction), (error: any) => error.statusCode === 503);
});

test('tenant compatibility rejects missing state and incorrect same-release checksum', async () => {
    const schema = 'rehablo_' + 'a'.repeat(32);
    const {database} = lockingDatabase(async () => [[]]);
    await assert.rejects(assertTenantReady(schema, manifest, database), (error: any) => error.statusCode === 503);
    database.query = (async () => [[{releaseId: manifest.id, checksum: 'different', releaseChecksum: manifest.checksum}]]) as any;
    await assert.rejects(assertTenantReady(schema, manifest, database), /not ready/);
});

test('manifest validation rejects duplicate or wrongly scoped steps before acquiring locks', () => {
    const step = {name: 'one', scope: 'tenant' as const, checksum: 'hash', up: async () => {}};
    assert.throws(() => validateManifest({...manifest, tenantMigrations: [step, step]}), /Duplicate/);
    assert.throws(() => validateManifest({...manifest, publicMigrations: [step]}), /Invalid public/);
});

test('failed worker waits for other active tenant transactions before releasing the global lock', async () => {
    const statements: string[] = [];
    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    let secondFailed!: () => void;
    const blocked = new Promise<void>(resolve => {releaseFirst = resolve;});
    const started = new Promise<void>(resolve => {firstStarted = resolve;});
    const failed = new Promise<void>(resolve => {secondFailed = resolve;});
    const {database, events} = lockingDatabase(async sql => {
        statements.push(sql);
        if (sql.includes('to_regclass')) return [[{control: 'yes', releases: 'yes', tenants: 'yes'}]];
        if (sql.includes('SELECT t."id"')) return [ids.map(id => ({id}))];
        return [[]];
    });
    database.transaction = (async (work: any) => work({id: 'synthetic'})) as any;
    const release = {...manifest, tenantMigrations: [{name: 'work', scope: 'tenant' as const, checksum: 'work-hash',
        up: async (_database: Sequelize, schema: string) => {
            if (schema.endsWith('1')) {firstStarted(); await blocked;}
            else {secondFailed(); throw new Error('tenant-two failure');}
        }}]};
    const running = migrateDatabase(release, {database, concurrency: 2});
    await Promise.all([started, failed]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.some(event => event.includes('unlock')), false);
    releaseFirst();
    await assert.rejects(running, /Tenant migration failed/);
    assert.equal(events.at(-1), 'release');
    assert.equal(statements.some(sql => sql.includes('INSERT INTO public.schema_releases')), false);
});

test('public migration steps commit separately so a new enum label is visible to the next step', async () => {
    const {database} = lockingDatabase(async sql => sql.includes('to_regclass')
        ? [[{control: 'yes', releases: 'yes', tenants: 'yes'}]] : [[]]);
    const committed = new Set<Transaction>();
    let firstTransaction: Transaction | undefined;
    database.transaction = (async (work: any) => {
        const transaction = {} as Transaction;
        const result = await work(transaction);
        committed.add(transaction);
        return result;
    }) as any;
    const release: DatabaseManifest = {...manifest, publicMigrations: [
        {name: 'add-enum-value', scope: 'public', checksum: 'enum', up: async (_database, _schema, transaction) => {firstTransaction = transaction;}},
        {name: 'use-enum-value', scope: 'public', checksum: 'use', up: async (_database, _schema, transaction) => {
            assert.ok(firstTransaction);
            assert.notEqual(transaction, firstTransaction);
            assert.ok(committed.has(firstTransaction));
        }}
    ]};
    assert.equal((await migrateDatabase(release, {database})).migrations, 2);
});

test('release deadline rolls back a stalled migration and releases its global lock', async () => {
    const {database, events} = lockingDatabase(async sql => sql.includes('to_regclass')
        ? [[{control: 'yes', releases: 'yes', tenants: 'yes'}]] : [[]]);
    database.transaction = (async (work: any) => {
        try {return await work({});} catch (error) {events.push('rollback'); throw error;}
    }) as any;
    const release: DatabaseManifest = {...manifest, publicMigrations: [
        {name: 'stalled', scope: 'public', checksum: 'stall', up: () => new Promise<void>(() => {})}
    ]};
    await assert.rejects(migrateDatabase(release, {database, timeoutMs: 50}), /deadline exceeded/);
    assert.ok(events.includes('rollback'));
    assert.equal(events.at(-1), 'release');
});
