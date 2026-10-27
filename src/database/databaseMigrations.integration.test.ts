import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {Sequelize, QueryTypes, type Transaction} from 'sequelize';
import {requireMigrationsTestDatabase} from '../../scripts/test-database-migrations-integration.mjs';
import type {DatabaseManifest, MigrationStep} from './migrationTypes.js';

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

test('PostgreSQL release migration transactions, resumability and provisioning locks', {timeout: 120000}, async t => {
    // No application imports, dotenv loading, or fallback database before this guard.
    const safeDatabase = requireMigrationsTestDatabase(process.env);
    process.env.DATABASE_URL = safeDatabase.databaseUrl;
    process.env.DB_SSL = 'false';
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = randomBytes(32).toString('hex');
    const {migrateDatabase, getDatabaseStatus, runTenantMigrations} = await import('./releaseRunner.js');
    const {assertDatabaseReady, assertTenantReady, assertProvisioningRelease, lockProvisioning, recordTenantReady} = await import('./releaseControl.js');
    const {initializeBridge, markBridgeComplete, requireBridgeComplete} = await import('./schemaTransition.js');
    const {SchemaReadinessError, quoteTenantSchema} = await import('./migrationTypes.js');
    const database = new Sequelize(safeDatabase.databaseUrl, {dialect: 'postgres', logging: false,
        dialectOptions: {ssl: false}, pool: {max: 8, min: 0, acquire: 15000}});
    const fixtureTables = ['tenants', 'schema_control', 'schema_releases', 'tenant_schema_state',
        'platform_schema_migrations', 'schema_transition', 'migrations_integration_events'];
    const schemas = new Set<string>();
    let fixtureOwned = false;
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const schemaOf = (id: string) => 'rehablo_' + id.replaceAll('-', '');
    const events = new Map<string, number>();
    const step = (name: string, scope: 'public' | 'tenant', up: MigrationStep['up']): MigrationStep => ({name, scope, checksum: hash(name), up});
    const manifest = (id: string, publicMigrations: MigrationStep[], tenantMigrations: MigrationStep[]): DatabaseManifest => ({
        id, checksum: hash(JSON.stringify({id, publicMigrations: publicMigrations.map(({name, checksum}) => ({name, checksum})),
            tenantMigrations: tenantMigrations.map(({name, checksum}) => ({name, checksum}))})), publicMigrations, tenantMigrations
    });
    const prepareTenant = async (schema: string, db: Sequelize, transaction: Transaction) => {
        schemas.add(schema);
        await db.query(`CREATE SCHEMA IF NOT EXISTS ${quoteTenantSchema(schema)}`, {transaction});
    };
    const eventCount = async (schema: string, version: string) => {
        const rows = await database.query<{count: number}>('SELECT COUNT(*)::int AS count FROM public.migrations_integration_events WHERE name = :name',
            {type: QueryTypes.SELECT, replacements: {name: `${schema}:${version}`}});
        return rows[0].count;
    };
    const logStep = async (db: Sequelize, schema: string, name: string, transaction: Transaction) => {
        events.set(`${schema}:${name}`, (events.get(`${schema}:${name}`) ?? 0) + 1);
        await db.query('INSERT INTO public.migrations_integration_events (name) VALUES (:name)',
            {transaction, replacements: {name: `${schema}:${name}`}});
    };
    const publicBase = step('integration-public-v1', 'public', async (db, schema, transaction) => {
        assert.equal(schema, 'public');
        await db.query('CREATE TABLE public.migrations_integration_events (name TEXT PRIMARY KEY)', {transaction});
    });
    const tenantBase = step('integration-tenant-v1', 'tenant', async (db, schema, transaction) => {
        await db.query(`CREATE TABLE ${quoteTenantSchema(schema)}.migration_fixture (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL)`, {transaction});
        await db.query(`INSERT INTO ${quoteTenantSchema(schema)}.migration_fixture VALUES (1, 1)`, {transaction});
        await logStep(db, schema, 'v1', transaction);
    });
    const base = manifest('integration-release-v1', [publicBase], [tenantBase]);
    const ids = [randomUUID(), randomUUID()].sort();
    const [firstSchema, failedSchema] = ids.map(schemaOf);
    const apply = (release: DatabaseManifest, concurrency = 1) => migrateDatabase(release, {database, concurrency, prepareTenant});
    const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>(done => {resolve = done;});
        return {promise, resolve};
    };
    const waitForReleaseWaiter = async () => {
        const end = Date.now() + 5000;
        while (Date.now() < end) {
            const rows = await database.query<{waiting: boolean}>(`SELECT EXISTS (
                SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
                AND classid = 1380270671::oid AND objid = 18700::oid) AS waiting`, {type: QueryTypes.SELECT});
            if (rows[0].waiting) return;
            await delay(20);
        }
        assert.fail('Expected a migration/provisioning session to wait on the shared release lock');
    };

    try {
        const identity = await database.query<{name: string}>('SELECT current_database() AS name', {type: QueryTypes.SELECT});
        assert.equal(identity[0].name, safeDatabase.databaseName);
        const occupied = await database.query<{name: string}>(`SELECT tablename AS name FROM pg_tables
            WHERE schemaname = 'public' AND tablename IN (:tables)`, {type: QueryTypes.SELECT, replacements: {tables: fixtureTables}});
        assert.equal(occupied.length, 0, 'Use an empty dedicated migration test database: existing control or tenant fixture tables will not be removed');
        // A fresh database may enter managed mode without the compatibility rollout.
        await requireBridgeComplete(database);
        await database.query('CREATE TABLE public.tenants (id UUID PRIMARY KEY)');
        fixtureOwned = true;
        await requireBridgeComplete(database);
        for (const id of ids) await database.query('INSERT INTO public.tenants (id) VALUES (:id)', {replacements: {id}});

        await t.test('existing tenants require completed bridge bootstrap rather than transition metadata alone', async () => {
            await assert.rejects(requireBridgeComplete(database), SchemaReadinessError);
            await database.transaction(transaction => initializeBridge(database, transaction));
            await assert.rejects(requireBridgeComplete(database), SchemaReadinessError);
            await markBridgeComplete(database);
            await requireBridgeComplete(database);
            await markBridgeComplete(database);
            const rows = await database.query<{count: number}>('SELECT COUNT(*)::int AS count FROM public.schema_transition', {type: QueryTypes.SELECT});
            assert.equal(rows[0].count, 1);
            assert.equal((await getDatabaseStatus(base, database)).ready, false, 'Bridge handshake must not mark the managed release ready');
        });

        await t.test('readiness/status are read-only before initialization, then fresh tenants share one release', async () => {
            assert.deepEqual(await getDatabaseStatus(base, database, true), {ready: false, currentRelease: null, release: base.id, tenants: []});
            await assert.rejects(assertDatabaseReady(base, database), SchemaReadinessError);
            const result = await apply(base, 2);
            assert.equal(result.noop, false); assert.equal(result.tenants, 2); assert.equal(result.migrations, 3);
            await assertDatabaseReady(base, database);
            const state = await getDatabaseStatus(base, database, true);
            assert.equal(state.ready, true); assert.equal(state.tenants!.length, 2);
            for (const schema of ids.map(schemaOf)) {
                await assertTenantReady(schema, base, database);
                assert.equal(await eventCount(schema, 'v1'), 1);
            }
        });

        await t.test('an unchanged release does no DDL, data writes, preparation or per-tenant migration work', async () => {
            const statements: string[] = [];
            (database as any).options.logging = (sql: string) => statements.push(sql);
            try {
                const result = await migrateDatabase(base, {database, concurrency: 2,
                    preparePublic: async () => {assert.fail('No-op must skip public preparation');},
                    prepareTenant: async () => {assert.fail('No-op must skip tenant preparation');}});
                assert.deepEqual(result, {release: base.id, noop: true, tenants: 0, migrations: 0});
            } finally {(database as any).options.logging = false;}
            assert.ok(statements.length > 0);
            assert.ok(statements.every(sql => !/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(sql)), statements.join('\n'));
            assert.ok(statements.every(sql => !sql.includes('public.tenants')), 'No-op must not enumerate tenants');
            assert.equal(events.get(`${firstSchema}:v1`), 1);
        });

        let failTenant = true;
        const tenantV2 = step('integration-tenant-v2', 'tenant', async (db, schema, transaction) => {
            await db.query(`ALTER TABLE ${quoteTenantSchema(schema)}.migration_fixture ADD COLUMN rollback_probe INTEGER`, {transaction});
            await db.query(`UPDATE ${quoteTenantSchema(schema)}.migration_fixture SET revision = 2, rollback_probe = 42`, {transaction});
            await logStep(db, schema, 'v2', transaction);
            if (failTenant && schema === failedSchema) throw new Error('Injected tenant migration failure');
        });
        const second = manifest('integration-release-v2', [publicBase], [tenantBase, tenantV2]);
        await t.test('failure rolls back tenant DDL/data/history and preserves completed tenant checkpoints', async () => {
            await assert.rejects(apply(second), /Tenant migration failed/);
            const state = await getDatabaseStatus(second, database, true);
            assert.equal(state.ready, false); assert.equal(state.currentRelease, base.id);
            assert.equal(state.tenants!.find(row => row.schemaName === firstSchema)!.releaseId, second.id);
            assert.equal(state.tenants!.find(row => row.schemaName === failedSchema)!.releaseId, base.id);
            const columns = await database.query<{column_name: string}>(`SELECT column_name FROM information_schema.columns
                WHERE table_schema = :schema AND table_name = 'migration_fixture' AND column_name = 'rollback_probe'`,
                {type: QueryTypes.SELECT, replacements: {schema: failedSchema}});
            assert.equal(columns.length, 0);
            const rows = await database.query<{revision: number}>(`SELECT revision FROM ${quoteTenantSchema(failedSchema)}.migration_fixture`, {type: QueryTypes.SELECT});
            assert.equal(rows[0].revision, 1); assert.equal(await eventCount(failedSchema, 'v2'), 0);
            const history = await database.query<{version: string}>(`SELECT version FROM ${quoteTenantSchema(failedSchema)}.schema_migrations WHERE version = :version`,
                {type: QueryTypes.SELECT, replacements: {version: tenantV2.name}});
            assert.equal(history.length, 0);
            await assert.rejects(assertDatabaseReady(second, database), SchemaReadinessError);
            await assertDatabaseReady(base, database);
        });
        await t.test('retry applies only incomplete tenant work and preserves additive rollback compatibility', async () => {
            failTenant = false;
            const result = await apply(second);
            assert.equal(result.tenants, 1); assert.equal(result.migrations, 1);
            assert.equal(events.get(`${firstSchema}:v2`), 1);
            for (const schema of ids.map(schemaOf)) {
                assert.equal(await eventCount(schema, 'v2'), 1);
                await assertTenantReady(schema, second, database);
                await assertTenantReady(schema, base, database);
            }
            await assertDatabaseReady(second, database);
        });

        const tenantV3 = step('integration-tenant-v3', 'tenant', async (db, schema, transaction) => {
            await db.query(`UPDATE ${quoteTenantSchema(schema)}.migration_fixture SET revision = 3`, {transaction});
            await logStep(db, schema, 'v3', transaction);
        });
        const third = manifest('integration-release-v3', [publicBase], [tenantBase, tenantV2, tenantV3]);
        await t.test('concurrent runners commit the release once and the second runner skips completed work', async () => {
            const results = await Promise.all([apply(third, 2), apply(third, 2)]);
            assert.equal(results.filter(result => !result.noop).length, 1);
            assert.equal(results.filter(result => result.noop).length, 1);
            const rows = await database.query<{count: number}>('SELECT COUNT(*)::int AS count FROM public.schema_releases WHERE id = :id',
                {type: QueryTypes.SELECT, replacements: {id: third.id}});
            assert.equal(rows[0].count, 1);
            for (const schema of ids.map(schemaOf)) assert.equal(await eventCount(schema, 'v3'), 1);
        });
        await t.test('published migration and release checksums cannot be changed', async () => {
            await assert.rejects(apply({...third, checksum: hash('changed release')}), /checksum mismatch/);
            const changed = {...tenantBase, checksum: hash('changed published step')};
            await assert.rejects(apply(manifest('integration-invalid-release', [publicBase], [changed, tenantV2, tenantV3])), /immutable migration/);
            assert.equal((await getDatabaseStatus(third, database)).currentRelease, third.id);
        });

        const tenantV4 = step('integration-tenant-v4', 'tenant', async (db, schema, transaction) => {
            await db.query(`UPDATE ${quoteTenantSchema(schema)}.migration_fixture SET revision = 4`, {transaction});
            await logStep(db, schema, 'v4', transaction);
        });
        const fourth = manifest('integration-release-v4', [publicBase], [tenantBase, tenantV2, tenantV3, tenantV4]);
        await t.test('release waits for provisioning to commit and includes its new tenant before publishing readiness', async () => {
            const tenantId = randomUUID(), schema = schemaOf(tenantId);
            const provisioned = deferred(), commitProvisioning = deferred();
            const provisioning = database.transaction(async transaction => {
                await lockProvisioning(database, transaction);
                await assertProvisioningRelease(third, database, transaction);
                await database.query('INSERT INTO public.tenants (id) VALUES (:id)', {transaction, replacements: {id: tenantId}});
                await prepareTenant(schema, database, transaction);
                await runTenantMigrations(third, schema, database, transaction);
                await recordTenantReady(schema, third, database, transaction);
                provisioned.resolve();
                await commitProvisioning.promise;
            });
            // Observe provisioning failure even if it occurs before the rendezvous.
            await Promise.race([provisioned.promise, provisioning.then(() => {throw new Error('Provisioning completed before its gate');})]);
            const release = apply(fourth, 2);
            void release.catch(() => {});
            let checkFailure: unknown;
            try {
                await waitForReleaseWaiter();
                assert.equal((await getDatabaseStatus(fourth, database)).ready, false);
            } catch (error) {checkFailure = error;}
            finally {commitProvisioning.resolve();}
            await provisioning;
            const result = await release;
            if (checkFailure) throw checkFailure;
            assert.equal(result.tenants, 3);
            await assertTenantReady(schema, fourth, database);
            assert.equal(await eventCount(schema, 'v1'), 1); assert.equal(await eventCount(schema, 'v4'), 1);
            assert.equal((await getDatabaseStatus(fourth, database, true)).tenants!.length, 3);
        });

        await t.test('provisioning blocked by a release rechecks compatibility before writing tenant data', async () => {
            const migrationStarted = deferred(), finishMigration = deferred();
            const tenantV5 = step('integration-tenant-v5', 'tenant', async (db, schema, transaction) => {
                migrationStarted.resolve();
                await finishMigration.promise;
                await logStep(db, schema, 'v5', transaction);
            });
            const fifth = manifest('integration-release-v5', [publicBase], [tenantBase, tenantV2, tenantV3, tenantV4, tenantV5]);
            const release = apply(fifth);
            void release.catch(() => {});
            await Promise.race([migrationStarted.promise, release.then(() => {throw new Error('Release completed before its gate');})]);
            const staleProvisioning = database.transaction(async transaction => {
                await lockProvisioning(database, transaction);
                await assertProvisioningRelease(fourth, database, transaction);
                assert.fail('An older API release must not provision a tenant against a newer database release');
            });
            void staleProvisioning.catch(() => {});
            let checkFailure: unknown;
            try {await waitForReleaseWaiter();}
            catch (error) {checkFailure = error;}
            finally {finishMigration.resolve();}
            await release;
            await assert.rejects(staleProvisioning, SchemaReadinessError);
            if (checkFailure) throw checkFailure;
            await assertDatabaseReady(fifth, database);
        });

        await t.test('an occupied shared release lock fails within its deadline and leaves the connection usable', async () => {
            const transaction = await database.transaction();
            try {
                await lockProvisioning(database, transaction);
                await assert.rejects(migrateDatabase(base, {database, lockTimeoutMs: 50}), /lock timeout|canceling statement/i);
            } finally {await transaction.rollback();}
            assert.equal((await apply(base)).noop, true);
            await database.query('SELECT 1');
        });
    } finally {
        if (fixtureOwned) {
            for (const schema of schemas) await database.query(`DROP SCHEMA IF EXISTS ${quoteTenantSchema(schema)} CASCADE`);
            for (const table of fixtureTables) await database.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
        }
        await database.close();
    }
});
