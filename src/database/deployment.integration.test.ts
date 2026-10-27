import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {get} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {Model, type Sequelize} from 'sequelize';
import {requireMigrationsTestDatabase} from '../../scripts/test-database-migrations-integration.mjs';
import type {DatabaseManifest} from './migrationTypes.js';

test('compiled deployment CLI, managed provisioning and constant readiness queries', {timeout: 180000}, async t => {
    const target = requireMigrationsTestDatabase(process.env);
    const directory = fileURLToPath(new URL('../..', import.meta.url));
    const cli = fileURLToPath(new URL('../../dist/scripts/databaseMigrations.js', import.meta.url));
    assert.ok(existsSync(cli), 'Run npm run build before the compiled deployment integration test');
    Object.assign(process.env, {DATABASE_URL: target.databaseUrl, NODE_ENV: 'production', DB_SSL: 'false',
        DATABASE_MIGRATION_PHASE: 'managed', TENANT_SCHEMA_SYNC: 'off', JWT_SECRET: randomBytes(32).toString('hex'),
        REMINDER_EXTERNAL_DELIVERY_ENABLED: 'false', ACTIVITIES_DELIVERY_ENABLED: 'false'});
    // Import the same compiled manifest as the CLI and server: source and compiled checksums differ intentionally.
    const compiled = (name: string) => import(new URL('../../dist/' + name + '.js', import.meta.url).href);
    const {sequelize: database}: {sequelize: Sequelize} = await compiled('config/database');
    const {databaseManifest}: {databaseManifest: DatabaseManifest} = await compiled('database/migrationManifest');
    const {databaseManifest: sourceManifest} = await import('./migrationManifest.js');
    const {sequelize: sourceDatabase} = await import('../config/database.js');
    const {schemaBaseline} = await compiled('database/schemaBaseline');
    const {registerDatabaseModels} = await compiled('database/registerModels');
    const {migrateDatabase, getDatabaseStatus} = await compiled('database/releaseRunner');
    const {assertDatabaseReady, assertTenantReady} = await compiled('database/releaseControl');
    const {beginTenantProvisioning, provisionTenantSchema, ensureTenantSchema, invalidateTenantSchemaCache} = await compiled('utils/tenantSchema');
    registerDatabaseModels();
    const loggingOptions = (database as unknown as {options: {logging: false | ((sql: string) => void)}}).options;
    loggingOptions.logging = false;
    const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
    const schemas = new Set<string>();
    const knownTables = new Set<string>([...schemaBaseline.public.map((table: {name: string}) => table.name),
        'schema_control','schema_releases','tenant_schema_state','platform_schema_migrations','schema_transition',
        'auth_schema_migrations','auth_security_migrations','activity_notification_migrations','activity_notification_preferences','account_action_tokens']);
    const knownEnums = new Set<string>(schemaBaseline.public.flatMap((table: {enums: string[]}) => table.enums.flatMap(sql =>
        [...sql.matchAll(/CREATE TYPE "public"\."([^"]+)"/g)].map(match => match[1]))));
    let ownsDatabaseObjects = false;
    const runCli = async (action: 'migrate' | 'status' | 'check'): Promise<string> => {
        const child = spawn(process.execPath, [cli, action], {cwd: directory, env: {...process.env}, windowsHide: true,
            stdio: ['ignore','pipe','pipe']});
        let output = '';
        child.stdout!.on('data', chunk => {output += String(chunk);});
        child.stderr!.on('data', chunk => {output += String(chunk);});
        const timer = setTimeout(() => child.kill(), 45000);
        try {
            await new Promise<void>((resolve, reject) => {
                child.once('error', reject);
                child.once('exit', code => code === 0 ? resolve() : reject(new Error('Compiled database CLI failed: ' + output)));
            });
            return output;
        } finally {clearTimeout(timer);}
    };
    const captureSql = async <T>(work: () => Promise<T>) => {
        const statements: string[] = [];
        const options = loggingOptions;
        const previous = options.logging;
        options.logging = sql => statements.push(sql);
        try {return {result: await work(), statements};} finally {options.logging = previous;}
    };
    const insertTenant = async (id: string, transaction: any) => database.query(`INSERT INTO public.tenants
        (id,license,"idStripe","maxUserQuantity","maxStructureQuantity","createdAt","updatedAt")
        VALUES (:id,'synthetic-deployment-integration','synthetic',1,1,NOW(),NOW())`, {transaction, replacements: {id}});
    const httpHealth = (port: number): Promise<{status: number;body: string}> => new Promise((resolve, reject) => {
        const request = get(`http://127.0.0.1:${port}/health`, response => {
            let body = ''; response.on('data', chunk => {body += String(chunk);});
            response.once('end', () => resolve({status: response.statusCode ?? 0, body}));
        });
        request.once('error', reject);
        request.setTimeout(1000, () => request.destroy(new Error('Health request timed out')));
    });
    const stopChild = async (child: ChildProcess) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        child.kill();
        await exited;
    };
    try {
        await database.authenticate();
        const [names] = await database.query('SELECT current_database() AS name');
        assert.equal((names[0] as any).name, target.databaseName);
        const [tables] = await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
        const [types] = await database.query(`SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
            WHERE n.nspname='public' AND t.typtype='e'`);
        assert.equal(tables.length, 0, 'Deployment integration tests require an empty disposable database');
        assert.equal(types.length, 0, 'Deployment integration tests require no pre-existing public enum types');
        ownsDatabaseObjects = true;

        await t.test('source tooling and compiled deployment agree on the immutable release and migration checksums', () => {
            assert.equal(sourceManifest.id, databaseManifest.id);
            assert.equal(sourceManifest.checksum, databaseManifest.checksum,
                'Release checksums must derive from frozen migration artifacts, independently of TypeScript compilation');
            for (const scope of ['publicMigrations', 'tenantMigrations'] as const) {
                assert.deepEqual(sourceManifest[scope].map(({name, checksum}) => ({name, checksum})),
                    databaseManifest[scope].map(({name, checksum}) => ({name, checksum})));
            }
        });

        await t.test('the compiled CLI executes the complete public release on a fresh database and reports no-op on retry', async () => {
            const first = await runCli('migrate');
            assert.match(first, /"noop":false/);
            assert.equal((await getDatabaseStatus(databaseManifest, database)).ready, true);
            assert.match(await runCli('check'), /"ready":true/);
            assert.match(await runCli('migrate'), /"noop":true/);
            const [versions] = await database.query('SELECT version FROM public.platform_schema_migrations');
            assert.deepEqual((versions as Array<{version: string}>).map(row => row.version).sort(), databaseManifest.publicMigrations.map(step => step.name).sort());
        });

        const tenantId = randomUUID(), schema = 'rehablo_' + tenantId.replaceAll('-', '');
        schemas.add(schema);
        await t.test('managed tenant registration applies explicit migrations and state atomically without Model.sync', async () => {
            const previousSync = Model.sync;
            (Model as any).sync = async () => {throw new Error('Managed provisioning must never invoke Sequelize model sync');};
            try {
                await database.transaction(async transaction => {
                    await beginTenantProvisioning(transaction);
                    await insertTenant(tenantId, transaction);
                    assert.equal(await provisionTenantSchema(tenantId, transaction), schema);
                });
            } finally {(Model as any).sync = previousSync;}
            await assertTenantReady(schema, databaseManifest, database);
            const [activations] = await database.query(`SELECT COUNT(*)::int AS count FROM ${quote(schema)}.activity_notification_activation`);
            assert.equal((activations[0] as any).count, 0, 'Disabled delivery must not establish a migration-time notification cutoff');
            invalidateTenantSchemaCache(tenantId);
            const {statements} = await captureSql(async () => {
                assert.equal(await ensureTenantSchema(tenantId), schema);
                assert.equal(await ensureTenantSchema(tenantId), schema);
            });
            assert.equal(statements.length, 1, 'The first access reads readiness once; repeated access uses the process cache');
            assert.ok(statements.every(sql => !/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(sql)));
        });

        await t.test('a failed registration rolls back the tenant, schema, migration versions and ready state together', async () => {
            const failedTenant = randomUUID(), failedSchema = 'rehablo_' + failedTenant.replaceAll('-', '');
            schemas.add(failedSchema);
            await assert.rejects(database.transaction(async transaction => {
                await beginTenantProvisioning(transaction);
                await insertTenant(failedTenant, transaction);
                await provisionTenantSchema(failedTenant, transaction);
                throw new Error('synthetic-registration-failure');
            }), /synthetic-registration-failure/);
            const [rows] = await database.query(`SELECT
                EXISTS(SELECT 1 FROM public.tenants WHERE id=:tenant) AS tenant,
                EXISTS(SELECT 1 FROM public.tenant_schema_state WHERE "schemaName"=:schema) AS state,
                to_regnamespace(:schema) AS schema`, {replacements: {tenant: failedTenant, schema: failedSchema}});
            assert.deepEqual(rows[0], {tenant: false, state: false, schema: null});
        });

        await t.test('the compiled managed server becomes healthy without tenant schema sync or migration phases', async () => {
            const server = spawn(process.execPath, ['dist/server.js'], {cwd: directory,
                env: {...process.env, PORT: '0'}, windowsHide: true, stdio: ['ignore','pipe','pipe']});
            let output = '', port = 0;
            const observe = (chunk: Buffer) => {
                output += String(chunk);
                const match = output.match(/listening on 0\.0\.0\.0:(\d+);/);
                if (match) port = Number(match[1]);
            };
            server.stdout!.on('data', observe); server.stderr!.on('data', observe);
            try {
                const deadline = Date.now() + 20000;
                let healthy = false;
                while (Date.now() < deadline && server.exitCode === null) {
                    if (port) {
                        try {
                            const result = await httpHealth(port);
                            if (result.status === 200) {assert.deepEqual(JSON.parse(result.body), {status: 'ok'}); healthy = true; break;}
                        } catch { /* Listener/readiness can still be starting. */ }
                    }
                    await delay(50);
                }
                assert.equal(healthy, true, 'Compiled managed startup failed: ' + output);
                assert.match(output, /database release compatibility: completed/);
                assert.doesNotMatch(output, /\[tenant-schema\]|sync modello|public auth models|catalog seed|tenant discovery|tenant schemas:|structure backfill/);
            } finally {await stopChild(server);}
        });

        await t.test('readiness and an unchanged release use the same query count with 4 and 1000 tenant metadata records', async () => {
            const addMetadata = async (count: number) => {
                await database.query(`WITH added AS (
                    INSERT INTO public.tenants (id,license,"idStripe","maxUserQuantity","maxStructureQuantity","createdAt","updatedAt")
                    SELECT gen_random_uuid(),'synthetic-metadata-cardinality','synthetic',1,1,NOW(),NOW() FROM generate_series(1,:count)
                    RETURNING id
                ) INSERT INTO public.tenant_schema_state ("schemaName","releaseId",checksum,"compatibleReleases")
                    SELECT 'rehablo_' || replace(id::text,'-',''),:release,:checksum,CAST(:compatible AS jsonb) FROM added`, {
                    replacements: {count, release: databaseManifest.id, checksum: databaseManifest.checksum,
                        compatible: JSON.stringify([databaseManifest.id])}
                });
            };
            const measure = async (expectedTenants: number) => {
                const [counts] = await database.query('SELECT COUNT(*)::int AS count FROM public.tenants');
                assert.equal((counts[0] as any).count, expectedTenants);
                const readiness = await captureSql(() => assertDatabaseReady(databaseManifest, database));
                const migration = await captureSql<{noop: boolean}>(() => migrateDatabase(databaseManifest, {database}));
                assert.equal(migration.result.noop, true);
                for (const sql of [...readiness.statements, ...migration.statements]) {
                    assert.doesNotMatch(sql, /\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i);
                    assert.doesNotMatch(sql, /information_schema|public\.tenants|schema_migrations/i);
                }
                return {readiness: readiness.statements.length, migration: migration.statements.length};
            };
            await addMetadata(3);
            const four = await measure(4);
            await addMetadata(996);
            const thousand = await measure(1000);
            assert.deepEqual(thousand, four);
            const [physical] = await database.query("SELECT COUNT(*)::int AS count FROM pg_namespace WHERE nspname LIKE 'rehablo\\_%' ESCAPE '\\'");
            assert.equal((physical[0] as any).count, 1, 'This is a metadata scaling simulation, not a 1000-schema migration benchmark');
            t.diagnostic('4 vs 1000 metadata records: readiness=' + four.readiness + ', no-op migration=' + four.migration + ' SQL queries; 1 physical tenant schema');
        });
    } finally {
        try {
            if (ownsDatabaseObjects) {
                for (const schema of schemas) {
                    assert.match(schema, /^rehablo_[a-f0-9]{32}$/);
                    await database.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
                }
                const [tables] = await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
                for (const row of tables as Array<{tablename: string}>) {
                    if (knownTables.has(row.tablename)) await database.query('DROP TABLE public.' + quote(row.tablename) + ' CASCADE');
                }
                const [types] = await database.query(`SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                    WHERE n.nspname='public' AND t.typtype='e'`);
                for (const row of types as Array<{typname: string}>) {
                    if (knownEnums.has(row.typname)) await database.query('DROP TYPE public.' + quote(row.typname));
                }
                const [remaining] = await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
                assert.equal(remaining.length, 0, 'Unexpected test-created tables require explicit fixture ownership before cleanup');
            }
        } finally {
            await database.close();
            if (sourceDatabase !== database) await sourceDatabase.close();
        }
    }
});
