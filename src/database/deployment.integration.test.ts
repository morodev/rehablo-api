import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {get} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {Model, type Sequelize} from 'sequelize';
import {requireMigrationsTestDatabase} from '../../scripts/test-database-migrations-integration.mjs';

test('standard Sequelize CLI deployment, failures, provisioning and readiness', {timeout: 180000}, async t => {
    const target = requireMigrationsTestDatabase(process.env);
    Object.assign(process.env, {DATABASE_URL: target.databaseUrl, NODE_ENV: 'production', DB_SSL: 'false',
        JWT_SECRET: randomBytes(32).toString('hex'), DEVICE_CREDENTIALS_SECRET: randomBytes(32).toString('hex'),
        BACKGROUND_JOBS_ENABLED: 'false', REMINDER_EXTERNAL_DELIVERY_ENABLED: 'false', ACTIVITIES_DELIVERY_ENABLED: 'false'});
    const directory = fileURLToPath(new URL('../..', import.meta.url));
    const compiled = (name: string) => import(new URL('../../dist/' + name + '.js', import.meta.url).href);
    assert.ok(existsSync(join(directory, 'dist/server.js')), 'Build the deployment artifact before running integration tests');
    const {sequelize: database}: {sequelize: Sequelize} = await compiled('config/database');
    const {sequelize: sourceDatabase} = await import('../config/database.js');
    const {requiredMigrationNames} = await compiled('database/standardMigrations');
    const {assertDatabaseReady, assertTenantReady, getDatabaseStatus} = await compiled('database/migrationStatus');
    const {beginTenantProvisioning, provisionTenantSchema, ensureTenantSchema, invalidateTenantSchemaCache} = await compiled('utils/tenantSchema');
    const {registerDatabaseModels} = await compiled('database/registerModels');
    const {schemaBaseline} = await compiled('database/schemaBaseline');
    registerDatabaseModels();
    const scripts = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).scripts;
    const command: string[] = scripts['db:migrate'].match(/"[^"]*"|'[^']*'|[^\s]+/g)
        .map((argument: string) => argument.replace(/^(['"])(.*)\1$/, '$2'));
    assert.ok(['sequelize', 'sequelize-cli'].includes(command.shift()!), 'db:migrate must invoke the standard CLI directly');
    const cli = join(directory, 'node_modules/sequelize-cli/lib/sequelize');
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'rehablo-standard-deployment-'));
    const guard = join(temporaryDirectory, 'forbid-business-sync.mjs');
    writeFileSync(guard, `import {createRequire} from 'node:module';
const require = createRequire(${JSON.stringify(join(directory, 'package.json'))});
const {Model, Sequelize} = require('sequelize');
const original = Model.sync;
Model.sync = function(options) {
    if (this.tableName !== 'SequelizeMeta') throw new Error('Business Model.sync is forbidden during deployment: ' + this.tableName);
    return original.call(this, options);
};
Sequelize.prototype.sync = function() {throw new Error('Global model synchronization is forbidden during deployment');};
`);
    const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    const schemas = new Set<string>();
    const knownTables = new Set<string>([...schemaBaseline.public.map((table: {name: string}) => table.name),
        'SequelizeMeta', 'schema_migrations', 'platform_schema_migrations', 'schema_control', 'schema_releases',
        'tenant_schema_state', 'schema_transition', 'auth_schema_migrations', 'auth_security_migrations',
        'activity_notification_migrations', 'activity_notification_preferences', 'account_action_tokens']);
    const knownEnums = new Set<string>(schemaBaseline.public.flatMap((table: {enums: string[]}) => table.enums.flatMap(sql =>
        [...sql.matchAll(/CREATE TYPE "public"\."([^"]+)"/g)].map(match => match[1]))));
    let ownsFixture = false;
    const spawnArtifact = (script: string, args: string[] = []) => {
        const child = spawn(process.execPath, ['--import', pathToFileURL(guard).href, script, ...args], {
            cwd: directory, env: {...process.env, PORT: '0'}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
        let output = '';
        child.stdout!.on('data', chunk => {output += String(chunk);});
        child.stderr!.on('data', chunk => {output += String(chunk);});
        return {child, output: () => output};
    };
    const stop = async (child: ChildProcess) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
        child.kill(); await closed;
    };
    const runCli = async (expectedCode = 0) => {
        const {child, output} = spawnArtifact(cli, command);
        const timer = setTimeout(() => child.kill(), 45000);
        try {
            const code = await new Promise<number | null>((resolve, reject) => {
                child.once('error', reject); child.once('close', resolve);
            });
            assert.equal(code, expectedCode, 'Unexpected CLI exit: ' + output());
            return output();
        } finally {clearTimeout(timer); await stop(child);}
    };
    const health = (port: number): Promise<number> => new Promise((resolve, reject) => {
        const request = get(`http://127.0.0.1:${port}/health`, response => {response.resume(); resolve(response.statusCode ?? 0);});
        request.once('error', reject);
        request.setTimeout(1000, () => request.destroy(new Error('Health request timed out')));
    });
    const metadata = async (schema = 'public') => {
        const [rows] = await database.query(`SELECT name FROM ${quote(schema)}."SequelizeMeta" ORDER BY name`);
        return (rows as Array<{name: string}>).map(row => row.name);
    };
    const insertTenant = (id: string, transaction?: any) => database.query(`INSERT INTO public.tenants
        (id,license,"idStripe","maxUserQuantity","maxStructureQuantity","createdAt","updatedAt")
        VALUES (:id,'synthetic-standard-deployment','synthetic',1,1,NOW(),NOW())`, {transaction, replacements: {id}});
    try {
        await database.authenticate();
        const [identity] = await database.query('SELECT current_database() AS name');
        assert.equal((identity[0] as any).name, target.databaseName);
        const [existing] = await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
        const [existingEnums] = await database.query(`SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
            WHERE n.nspname='public' AND t.typtype='e'`);
        assert.equal(existing.length, 0, 'Deployment tests require an empty disposable database');
        assert.equal(existingEnums.length, 0, 'Deployment tests require no pre-existing public enums');
        ownsFixture = true;

        await t.test('startup fails before migrations without applying public DDL or marking anything complete', async () => {
            assert.equal((await getDatabaseStatus(database)).ready, false);
            await assert.rejects(assertDatabaseReady(database));
            const {child, output} = spawnArtifact(join(directory, 'dist/server.js'));
            const timer = setTimeout(() => child.kill(), 15000);
            try {
                const code = await new Promise<number | null>((resolve, reject) => {
                    child.once('error', reject); child.once('close', resolve);
                });
                assert.equal(code, 1, 'Unmigrated startup must fail: ' + output());
                assert.doesNotMatch(output(), /Business Model.sync|Global model synchronization/);
                const [tables] = await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
                assert.equal(tables.length, 0, 'Startup and readiness checks must not initialize public metadata or schema');
            } finally {clearTimeout(timer); await stop(child);}
        });

        await t.test('a real schema error fails the CLI and leaves the initial migration pending', async () => {
            await database.query('CREATE TABLE public.users (id TEXT PRIMARY KEY)');
            const output = await runCli(1);
            assert.doesNotMatch(output, /Business Model.sync|Global model synchronization/);
            assert.deepEqual(await metadata(), [], 'An unsuccessful migration cannot be recorded in SequelizeMeta');
            assert.equal((await getDatabaseStatus(database)).ready, false);
            await database.query('DROP TABLE public.users CASCADE');
        });

        await t.test('the actual CLI completes both migrations while an obsolete bridge shared lock is still held', async () => {
            const blocker = await database.transaction();
            try {
                await database.query('SELECT pg_advisory_xact_lock_shared(1380270671,18700)', {transaction: blocker});
                const output = await runCli();
                assert.doesNotMatch(output, /Business Model.sync|Global model synchronization|release-lock-waiting/);
                assert.deepEqual(await metadata(), requiredMigrationNames);
                assert.equal((await getDatabaseStatus(database)).ready, true);
                await assertDatabaseReady(database);
                const [locks] = await database.query(`SELECT COUNT(*)::int AS count FROM pg_locks
                    WHERE locktype='advisory' AND classid=1380270671::oid AND objid=18700::oid AND granted
                    AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`);
                assert.equal((locks[0] as any).count, 1, 'The old lock remains held; migrations must not bypass it by terminating its owner');
            } finally {await blocker.rollback();}
        });

        await t.test('redeploys preserve recorded migrations and existing catalog edits', async () => {
            await database.query(`UPDATE public.metric_definitions SET "displayName"='Preserve deployment edit' WHERE code='KNEE_EXT_PEAK_FORCE'`);
            await runCli();
            assert.deepEqual(await metadata(), requiredMigrationNames);
            const [rows] = await database.query(`SELECT "displayName" FROM public.metric_definitions WHERE code='KNEE_EXT_PEAK_FORCE'`);
            assert.equal((rows[0] as any).displayName, 'Preserve deployment edit');
        });

        const tenantId = randomUUID(), schema = 'rehablo_' + tenantId.replaceAll('-', '');
        schemas.add(schema);
        await t.test('signup provisions the schema and both tenant migration names in its own transaction', async () => {
            const previousSync = Model.sync;
            (Model as any).sync = async () => {throw new Error('Signup must not synchronize business models');};
            try {
                await database.transaction(async transaction => {
                    await beginTenantProvisioning(transaction);
                    await insertTenant(tenantId, transaction);
                    assert.equal(await provisionTenantSchema(tenantId, transaction), schema);
                });
            } finally {Model.sync = previousSync;}
            assert.deepEqual(await metadata(schema), requiredMigrationNames);
            await assertTenantReady(schema, database);
            invalidateTenantSchemaCache(tenantId);
            const statements: string[] = [];
            const options = (database as any).options, previousLogging = options.logging;
            options.logging = (sql: string) => statements.push(sql);
            try {
                assert.equal(await ensureTenantSchema(tenantId), schema);
                assert.equal(await ensureTenantSchema(tenantId), schema);
            } finally {options.logging = previousLogging;}
            assert.ok(statements.length > 0 && statements.length <= 2, 'Tenant readiness is read once and then cached');
            assert.ok(statements.every(sql => !/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(sql)));
        });

        await t.test('a failed signup rolls back tenant, schema and per-tenant migration metadata', async () => {
            const failedId = randomUUID(), failedSchema = 'rehablo_' + failedId.replaceAll('-', '');
            schemas.add(failedSchema);
            await assert.rejects(database.transaction(async transaction => {
                await beginTenantProvisioning(transaction);
                await insertTenant(failedId, transaction);
                await provisionTenantSchema(failedId, transaction);
                throw new Error('synthetic-signup-failure');
            }), /synthetic-signup-failure/);
            const [rows] = await database.query(`SELECT EXISTS(SELECT 1 FROM public.tenants WHERE id=:id) AS tenant,
                to_regnamespace(:schema) AS schema`, {replacements: {id: failedId, schema: failedSchema}});
            assert.deepEqual(rows[0], {tenant: false, schema: null});
            assert.deepEqual(await metadata(), requiredMigrationNames);
        });

        await t.test('a migrated server becomes healthy while the obsolete bridge lock is held', async () => {
            const blocker = await database.transaction();
            let server: ReturnType<typeof spawnArtifact> | undefined;
            try {
                await database.query('SELECT pg_advisory_xact_lock_shared(1380270671,18700)', {transaction: blocker});
                server = spawnArtifact(join(directory, 'dist/server.js'));
                const deadline = Date.now() + 20000;
                let ready = false;
                while (Date.now() < deadline && server.child.exitCode === null) {
                    const port = server.output().match(/listening on 0\.0\.0\.0:(\d+)/)?.[1];
                    if (port) {
                        try {if (await health(Number(port)) === 200) {ready = true; break;}} catch { /* Listener is starting. */ }
                    }
                    await delay(50);
                }
                assert.equal(ready, true, 'Migrated startup did not become healthy: ' + server.output());
                assert.doesNotMatch(server.output(), /release-lock|Business Model.sync|Global model synchronization|public auth models/);
                assert.deepEqual(await metadata(), requiredMigrationNames);
            } finally {
                if (server) await stop(server.child);
                await blocker.rollback();
            }
        });
    } finally {
        try {
            if (ownsFixture) {
                for (const schema of schemas) await database.query('DROP SCHEMA IF EXISTS ' + quote(schema) + ' CASCADE');
                const [tables] = await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
                for (const row of tables as Array<{tablename: string}>) {
                    assert.ok(knownTables.has(row.tablename), 'Refusing cleanup of an unowned table: ' + row.tablename);
                    await database.query('DROP TABLE public.' + quote(row.tablename) + ' CASCADE');
                }
                const [types] = await database.query(`SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e'`);
                for (const row of types as Array<{typname: string}>) {
                    assert.ok(knownEnums.has(row.typname), 'Refusing cleanup of an unowned enum: ' + row.typname);
                    await database.query('DROP TYPE public.' + quote(row.typname));
                }
            }
        } finally {
            await database.close();
            if (sourceDatabase !== database) await sourceDatabase.close();
            unlinkSync(guard); rmdirSync(temporaryDirectory);
        }
    }
});
